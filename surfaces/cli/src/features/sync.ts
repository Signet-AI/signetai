import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { OpenClawConnector } from "@signetai/connector-openclaw";
import {
	type WorkspaceSourceRepoSyncResult,
	getOhMyPiConfigPath,
	getPiConfigPath,
	loadConfiguredHarnesses,
	resolveHermesRepoPath,
} from "@signetai/core";
import chalk from "chalk";

interface SkillSync {
	readonly installed: readonly string[];
	readonly updated: readonly string[];
	readonly skipped: readonly string[];
}

interface SyncState {
	readonly status: "updated" | "current" | "skipped" | "error";
	readonly message: string;
}

interface Deps {
	readonly agentsDir: string;
	readonly configureHarnessHooks: (
		harness: string,
		basePath: string,
		options?: { openclawRuntimePath?: "plugin" | "legacy" },
	) => Promise<void>;
	readonly getSkillsSourceDir: () => string;
	readonly getTemplatesDir: () => string;
	readonly signetLogo: () => string;
	readonly syncBuiltinSkills: (skillsSourceDir: string, basePath: string) => SkillSync;
	readonly syncNativeEmbeddingModel: (basePath: string) => Promise<SyncState>;
	readonly syncWorkspaceSourceRepo: (basePath: string) => Promise<WorkspaceSourceRepoSyncResult>;
}

export async function syncTemplates(deps: Deps): Promise<void> {
	console.log(deps.signetLogo());
	const basePath = deps.agentsDir;
	const templatesDir = deps.getTemplatesDir();

	if (!existsSync(basePath)) {
		console.log(chalk.red("  No Signet installation found. Run: signet setup"));
		return;
	}

	console.log(chalk.bold("  Syncing template files...\n"));

	let synced = 0;
	synced += syncGitignore(basePath, templatesDir);
	synced += await syncSourceRepo(basePath, deps);
	synced += syncSkills(basePath, deps);
	synced += await syncNative(basePath, deps);
	synced += await syncHarnessHooks(basePath, deps);

	if (synced === 0) {
		console.log(chalk.dim("  All built-in templates are up to date"));
	}

	console.log();
	console.log(chalk.green("  Done!"));
}

function syncGitignore(basePath: string, templatesDir: string): number {
	const src = join(templatesDir, "gitignore.template");
	const dest = join(basePath, ".gitignore");
	if (!existsSync(src) || existsSync(dest)) {
		return 0;
	}

	copyFileSync(src, dest);
	console.log(chalk.green("  ✓ .gitignore"));
	return 1;
}

export function copyDirRecursive(src: string, dest: string): void {
	mkdirSync(dest, { recursive: true });
	const entries = readdirSync(src, { withFileTypes: true });

	for (const entry of entries) {
		const srcPath = join(src, entry.name);
		const destPath = join(dest, entry.name);

		if (entry.isDirectory()) {
			copyDirRecursive(srcPath, destPath);
		} else {
			copyFileSync(srcPath, destPath);
		}
	}
}

function isBuiltinSkillDir(skillDir: string): boolean {
	const skillMdPath = join(skillDir, "SKILL.md");
	if (!existsSync(skillMdPath)) {
		return false;
	}

	try {
		const content = readFileSync(skillMdPath, "utf-8");
		const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
		if (!frontmatter) {
			return false;
		}

		return /^builtin:\s*true$/m.test(frontmatter[1]);
	} catch {
		return false;
	}
}

export function syncBuiltinSkills(skillsSourceDir: string, basePath: string): SkillSync {
	const skillsDest = join(basePath, "skills");
	const result = {
		installed: [] as string[],
		updated: [] as string[],
		skipped: [] as string[],
	};

	if (!existsSync(skillsSourceDir)) {
		return result;
	}

	mkdirSync(skillsDest, { recursive: true });

	const entries = readdirSync(skillsSourceDir, { withFileTypes: true }).filter((d) => d.isDirectory());

	for (const entry of entries) {
		const src = join(skillsSourceDir, entry.name);
		const dest = join(skillsDest, entry.name);
		const sourceIsBuiltin = isBuiltinSkillDir(src);

		if (!existsSync(dest)) {
			copyDirRecursive(src, dest);
			result.installed.push(entry.name);
			continue;
		}

		try {
			const destStat = lstatSync(dest);
			if (destStat.isSymbolicLink() || !destStat.isDirectory()) {
				result.skipped.push(entry.name);
				continue;
			}
		} catch {
			result.skipped.push(entry.name);
			continue;
		}

		if (!sourceIsBuiltin && !isBuiltinSkillDir(dest)) {
			result.skipped.push(entry.name);
			continue;
		}

		copyDirRecursive(src, dest);
		result.updated.push(entry.name);
	}

	return result;
}

function syncSkills(basePath: string, deps: Deps): number {
	const result = deps.syncBuiltinSkills(deps.getSkillsSourceDir(), basePath);
	for (const skill of result.installed) {
		console.log(chalk.green(`  ✓ skills/${skill} (installed)`));
	}
	for (const skill of result.updated) {
		console.log(chalk.green(`  ✓ skills/${skill} (updated)`));
	}
	return result.installed.length + result.updated.length;
}

async function syncSourceRepo(basePath: string, deps: Deps): Promise<number> {
	const result = await deps.syncWorkspaceSourceRepo(basePath);
	if (result.status === "cloned" || result.status === "pulled") {
		console.log(chalk.green(`  ✓ ${result.message}`));
		return 1;
	}
	if (result.status === "fetched") {
		console.log(chalk.dim(`  ${result.message}`));
		return 0;
	}
	if (result.status === "error") {
		console.log(chalk.yellow(`  ⚠ ${result.message}`));
		return 0;
	}
	if (result.status === "skipped") {
		console.log(chalk.dim(`  ${result.message}`));
		return 0;
	}
	// current: already up to date, no output
	return 0;
}

async function syncNative(basePath: string, deps: Deps): Promise<number> {
	const native = await deps.syncNativeEmbeddingModel(basePath);
	if (native.status === "updated") {
		console.log(chalk.green(`  ✓ native embedding model warmed (${native.message})`));
		return 1;
	}
	if (native.status === "current") {
		console.log(chalk.dim("  native embedding model is ready"));
		return 0;
	}
	if (native.status === "skipped") {
		console.log(chalk.dim(`  native embedding warmup skipped: ${native.message}`));
		return 0;
	}

	console.log(chalk.yellow(`  ⚠ native embedding warmup failed: ${native.message}`));
	return 0;
}

async function syncHarnessHooks(basePath: string, deps: Deps): Promise<number> {
	let synced = 0;
	const harnesses = [...loadConfiguredHarnesses(basePath)];
	const detected = detectInstalledHarnesses();
	if (detected.length > 0) {
		console.log(chalk.dim(`  Installed harnesses detected: ${detected.join(", ")}`));
	}

	if (harnesses.length === 0) {
		console.log(chalk.dim("  No active harnesses configured; skipping hook re-registration"));
		return 0;
	}

	const inactive = detected.filter((harness) => !harnesses.includes(harness));
	if (inactive.length > 0) {
		console.log(chalk.dim(`  Installed but inactive: ${inactive.join(", ")}`));
	}

	for (const harness of harnesses) {
		try {
			let runtimePath: "plugin" | "legacy" | undefined;
			if (harness === "openclaw") {
				const state = new OpenClawConnector().getRuntimeState();
				if (state === "legacy") {
					runtimePath = "plugin";
					console.log(
						chalk.yellow(
							"  ↺ OpenClaw legacy-only config detected, migrating to the plugin runtime path for full lifecycle capture",
						),
					);
				}
				// Leave dual-state installs visible in doctor/status for manual cleanup.
				// sync only self-heals legacy-only configs and should not silently remove hooks.
			}

			await deps.configureHarnessHooks(
				harness,
				basePath,
				runtimePath ? { openclawRuntimePath: runtimePath } : undefined,
			);
			console.log(chalk.green(`  ✓ hooks re-registered for ${harness}`));
			synced += 1;
		} catch {
			console.log(chalk.yellow(`  ⚠ hooks re-registration failed for ${harness}`));
		}
	}
	return synced;
}

function detectInstalledHarnesses(): string[] {
	const found: string[] = [];
	const home = process.env.HOME ?? homedir();

	if (existsSync(join(home, ".claude", "settings.json"))) {
		found.push("claude-code");
	}
	if (existsSync(join(home, ".config", "signet", "bin", "codex")) || existsSync(join(home, ".codex", "config.toml"))) {
		found.push("codex");
	}
	if (existsSync(join(home, ".config", "opencode"))) {
		found.push("opencode");
	}
	if (new OpenClawConnector().isInstalled()) {
		found.push("openclaw");
	}
	if (existsSync(getOhMyPiConfigPath())) {
		found.push("oh-my-pi");
	}
	if (resolveHermesRepoPath() !== null || existsSync(join(home, ".hermes"))) {
		found.push("hermes-agent");
	}
	if (existsSync(join(home, ".gemini", "settings.json"))) {
		found.push("gemini");
	}
	if (existsSync(getPiConfigPath())) {
		found.push("pi");
	}

	return found;
}
