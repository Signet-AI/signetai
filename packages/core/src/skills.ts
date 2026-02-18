/**
 * Skills unification for Signet
 *
 * Unifies skills from multiple harness sources (OpenClaw, Claude Code, etc.)
 * into a single unified registry with optional symlinking.
 */

import {
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	statSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";

/**
 * Metadata for a unified skill
 */
export interface SkillMeta {
	/** Skill name */
	name: string;
	/** Optional version string */
	version?: string;
	/** Source harness */
	source: "openclaw" | "claude-code" | "opencode" | "manual";
	/** When the skill was installed */
	installedAt?: Date;
	/** Whether this skill is symlinked (vs copied) */
	symlinked?: boolean;
	/** Path to the skill directory */
	path?: string;
}

/**
 * A skill source configuration
 */
export interface SkillSource {
	/** Type of source (e.g., 'openclaw', 'claude-code') */
	type: string;
	/** Path to the source directory */
	path: string;
}

/**
 * The unified skill registry
 */
export interface SkillRegistry {
	/** Map of skill name to metadata */
	skills: Record<string, SkillMeta>;
	/** List of configured sources */
	sources: SkillSource[];
}

/**
 * Configuration for skills unification
 */
export interface SkillsConfig {
	/** External registries to import from */
	registries?: Array<{
		/** Path to the registry */
		path: string;
		/** Harness type */
		harness: string;
		/** Whether to symlink instead of copy */
		symlink?: boolean;
	}>;
}

/**
 * Result of skills unification
 */
export interface SkillsResult {
	/** The unified registry */
	registry: SkillRegistry;
	/** Number of skills imported */
	imported: number;
	/** Number of skills symlinked */
	symlinked: number;
	/** Number of skills skipped */
	skipped: number;
}

const home = process.env.HOME || "";

/**
 * Raw skill data from lock.json files
 */
type RawSkillData = Record<string, unknown>;

/**
 * Load the OpenClaw lock.json registry if it exists
 *
 * @param basePath - Base path to look for .clawdhub/lock.json
 * @returns Parsed lock.json or null if not found
 */
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

/**
 * Symlink skills from ~/.claude/skills/ to the unified skills directory
 *
 * @param basePath - Base path containing the skills/ directory
 * @returns Object with count of symlinked skills and their names
 */
export function symlinkClaudeSkills(basePath: string): {
	symlinked: number;
	skills: string[];
} {
	const claudeSkillsDir = join(home, ".claude", "skills");
	const targetSkillsDir = join(basePath, "skills");

	if (!existsSync(claudeSkillsDir)) {
		return { symlinked: 0, skills: [] };
	}

	// Ensure target directory exists
	if (!existsSync(targetSkillsDir)) {
		mkdirSync(targetSkillsDir, { recursive: true });
	}

	const symlinkedSkills: string[] = [];

	try {
		const skills = readdirSync(claudeSkillsDir);

		for (const skill of skills) {
			const src = join(claudeSkillsDir, skill);
			const dest = join(targetSkillsDir, skill);

			// Skip if not a directory
			try {
				if (!statSync(src).isDirectory()) continue;
			} catch {
				continue;
			}

			// Check if dest exists
			try {
				const destStat = lstatSync(dest);
				if (destStat.isSymbolicLink()) {
					// Remove existing symlink to recreate
					unlinkSync(dest);
				} else {
					// It's a real directory - skip to avoid data loss
					continue;
				}
			} catch {
				// dest doesn't exist, that's fine
			}

			try {
				symlinkSync(src, dest);
				symlinkedSkills.push(skill);
			} catch {
				// Symlinks might fail on some systems
			}
		}
	} catch {
		// Failed to read source directory
	}

	return { symlinked: symlinkedSkills.length, skills: symlinkedSkills };
}

/**
 * Write the unified skill registry to skills/registry.json
 *
 * @param basePath - Base path containing the skills/ directory
 * @param registry - The registry to write
 */
export function writeRegistry(basePath: string, registry: SkillRegistry): void {
	const skillsDir = join(basePath, "skills");
	const registryPath = join(skillsDir, "registry.json");

	// Ensure skills directory exists
	if (!existsSync(skillsDir)) {
		mkdirSync(skillsDir, { recursive: true });
	}

	writeFileSync(registryPath, JSON.stringify(registry, null, 2), "utf-8");
}

/**
 * Unify skills from multiple harness sources into a single registry
 *
 * This function:
 * - Imports skills from .clawdhub/lock.json (OpenClaw registry) if it exists
 * - Symlinks skills from ~/.claude/skills/ (Claude Code) to skills/ directory
 * - Writes unified registry to skills/registry.json
 *
 * @param basePath - Base path for the unified skills directory
 * @param config - Configuration for skill sources
 * @returns Result with registry and counts
 */
export async function unifySkills(
	basePath: string,
	config: SkillsConfig = {},
): Promise<SkillsResult> {
	const registry: SkillRegistry = {
		skills: {},
		sources: [],
	};

	let imported = 0;
	let symlinked = 0;
	let skipped = 0;

	// Import from OpenClaw's .clawdhub/lock.json
	const clawdhubLock = loadClawdhubLock(basePath);
	if (clawdhubLock) {
		registry.sources.push({
			type: "openclaw",
			path: join(basePath, ".clawdhub"),
		});

		// Parse skills from lock.json
		// Format is typically { "skills": { "skill-name": { ... } } }
		// or { "skill-name": { ... } } at root
		const skillsData = clawdhubLock.skills || clawdhubLock;

		for (const [name, data] of Object.entries(skillsData)) {
			if (typeof data === "object" && data !== null) {
				const skillData = data as RawSkillData;
				const version =
					typeof skillData.version === "string" ? skillData.version : undefined;
				const installedAt =
					typeof skillData.installedAt === "string" ||
					typeof skillData.installedAt === "number"
						? new Date(skillData.installedAt)
						: undefined;
				const path =
					typeof skillData.path === "string" ? skillData.path : undefined;

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

	// Symlink from Claude Code's ~/.claude/skills/
	const claudeResult = symlinkClaudeSkills(basePath);
	if (
		claudeResult.symlinked > 0 ||
		existsSync(join(home, ".claude", "skills"))
	) {
		registry.sources.push({
			type: "claude-code",
			path: join(home, ".claude", "skills"),
		});

		for (const skillName of claudeResult.skills) {
			// Don't overwrite if already imported from another source
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

	// Process additional registries from config
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

					// Skip if already in registry
					if (registry.skills[entry]) {
						skipped++;
						continue;
					}

					if (reg.symlink) {
						const targetPath = join(basePath, "skills", entry);

						// Ensure skills dir exists
						if (!existsSync(join(basePath, "skills"))) {
							mkdirSync(join(basePath, "skills"), { recursive: true });
						}

						// Remove existing symlink if present
						try {
							const existing = lstatSync(targetPath);
							if (existing.isSymbolicLink()) {
								unlinkSync(targetPath);
							} else {
								// Real directory - skip
								skipped++;
								continue;
							}
						} catch {
							// Doesn't exist, proceed
						}

						try {
							symlinkSync(entryPath, targetPath);
							registry.skills[entry] = {
								name: entry,
								source: reg.harness as SkillMeta["source"],
								symlinked: true,
								path: targetPath,
							};
							symlinked++;
						} catch {
							skipped++;
						}
					} else {
						// Just register without symlinking
						registry.skills[entry] = {
							name: entry,
							source: reg.harness as SkillMeta["source"],
							symlinked: false,
							path: entryPath,
						};
						imported++;
					}
				}
			} catch {
				// Failed to read registry directory
			}
		}
	}

	// Write the unified registry
	writeRegistry(basePath, registry);

	return {
		registry,
		imported,
		symlinked,
		skipped,
	};
}
