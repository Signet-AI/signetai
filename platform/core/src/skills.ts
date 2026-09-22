import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { symlinkDir } from "./symlinks.js";
export interface SkillMeta {
	name: string;
	version?: string;
	source: "openclaw" | "claude-code" | "opencode" | "codex" | "manual";
	installedAt?: Date;
	symlinked?: boolean;
	path?: string;
}
export interface SkillSource {
	type: string;
	path: string;
}
export interface SkillRegistry {
	skills: Record<string, SkillMeta>;
	sources: SkillSource[];
}
export interface SkillsConfig {
	registries?: Array<{
		path: string;
		harness: string;
		symlink?: boolean;
	}>;
}
export interface SkillsResult {
	registry: SkillRegistry;
	imported: number;
	symlinked: number;
	skipped: number;
}

const home = homedir();
type RawSkillData = Record<string, unknown>;
export function loadClawdhubLock(basePath: string): RawSkillData | null {
	const lockPath = join(basePath, ".clawdhub", "lock.json");

	if (!existsSync(lockPath)) {
		return null;
	}

	try {
		const content = readFileSync(lockPath, "utf-8");
		return JSON.parse(content);
	} catch {
		return null;
	}
}
export function symlinkClaudeSkills(basePath: string): {
	symlinked: number;
	skills: string[];
} {
	const claudeSkillsDir = join(home, ".claude", "skills");
	const targetSkillsDir = join(basePath, "skills");

	if (!existsSync(claudeSkillsDir)) {
		return { symlinked: 0, skills: [] };
	}
	if (!existsSync(targetSkillsDir)) {
		mkdirSync(targetSkillsDir, { recursive: true });
	}

	const symlinkedSkills: string[] = [];

	try {
		const skills = readdirSync(claudeSkillsDir);

		for (const skill of skills) {
			const src = join(claudeSkillsDir, skill);
			const dest = join(targetSkillsDir, skill);
			try {
				if (!statSync(src).isDirectory()) continue;
			} catch {
				continue;
			}

			if (symlinkDir(src, dest)) {
				symlinkedSkills.push(skill);
			}
		}
	} catch {}

	return { symlinked: symlinkedSkills.length, skills: symlinkedSkills };
}
export function writeRegistry(basePath: string, registry: SkillRegistry): void {
	const skillsDir = join(basePath, "skills");
	const registryPath = join(skillsDir, "registry.json");
	if (!existsSync(skillsDir)) {
		mkdirSync(skillsDir, { recursive: true });
	}

	writeFileSync(registryPath, JSON.stringify(registry, null, 2), "utf-8");
}
export async function unifySkills(basePath: string, config: SkillsConfig = {}): Promise<SkillsResult> {
	const registry: SkillRegistry = {
		skills: {},
		sources: [],
	};

	let imported = 0;
	let symlinked = 0;
	let skipped = 0;
	const clawdhubLock = loadClawdhubLock(basePath);
	if (clawdhubLock) {
		registry.sources.push({
			type: "openclaw",
			path: join(basePath, ".clawdhub"),
		});
		const skillsData = clawdhubLock.skills || clawdhubLock;

		for (const [name, data] of Object.entries(skillsData)) {
			if (typeof data === "object" && data !== null) {
				const skillData = data as RawSkillData;
				const version = typeof skillData.version === "string" ? skillData.version : undefined;
				const installedAt =
					typeof skillData.installedAt === "string" || typeof skillData.installedAt === "number"
						? new Date(skillData.installedAt)
						: undefined;
				const path = typeof skillData.path === "string" ? skillData.path : undefined;

				registry.skills[name] = {
					name,
					version,
					source: "openclaw",
					installedAt,
					symlinked: false,
					path,
				};
				imported++;
			}
		}
	}
	const claudeResult = symlinkClaudeSkills(basePath);
	if (claudeResult.symlinked > 0 || existsSync(join(home, ".claude", "skills"))) {
		registry.sources.push({
			type: "claude-code",
			path: join(home, ".claude", "skills"),
		});

		for (const skillName of claudeResult.skills) {
			if (!registry.skills[skillName]) {
				registry.skills[skillName] = {
					name: skillName,
					source: "claude-code",
					symlinked: true,
					path: join(basePath, "skills", skillName),
				};
				symlinked++;
			} else {
				skipped++;
			}
		}
	}
	if (config.registries) {
		for (const reg of config.registries) {
			if (!existsSync(reg.path)) {
				continue;
			}

			registry.sources.push({
				type: reg.harness,
				path: reg.path,
			});

			try {
				const entries = readdirSync(reg.path);

				for (const entry of entries) {
					const entryPath = join(reg.path, entry);

					try {
						if (!statSync(entryPath).isDirectory()) continue;
					} catch {
						continue;
					}
					if (registry.skills[entry]) {
						skipped++;
						continue;
					}

					if (reg.symlink) {
						const targetPath = join(basePath, "skills", entry);
						if (!existsSync(join(basePath, "skills"))) {
							mkdirSync(join(basePath, "skills"), { recursive: true });
						}

						if (symlinkDir(entryPath, targetPath)) {
							registry.skills[entry] = {
								name: entry,
								source: reg.harness as SkillMeta["source"],
								symlinked: true,
								path: targetPath,
							};
							symlinked++;
						} else {
							skipped++;
						}
					} else {
						registry.skills[entry] = {
							name: entry,
							source: reg.harness as SkillMeta["source"],
							symlinked: false,
							path: entryPath,
						};
						imported++;
					}
				}
			} catch {}
		}
	}
	writeRegistry(basePath, registry);

	return {
		registry,
		imported,
		symlinked,
		skipped,
	};
}
