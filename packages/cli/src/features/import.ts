import { confirm, input } from "@inquirer/prompts";
import chalk from "chalk";
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import ora from "ora";

interface Deps {
	readonly copyDirRecursive: (src: string, dest: string) => void;
	readonly gitAddAndCommit: (dir: string, message: string) => Promise<boolean>;
	readonly isGitRepo: (dir: string) => boolean;
}

export async function importFromGitHub(basePath: string, deps: Deps): Promise<void> {
	console.log();
	console.log(chalk.bold("  Import agent configuration from GitHub\n"));

	const repoUrl = await input({
		message: "GitHub repo URL (e.g., username/repo or full URL):",
		validate: (value) => (value.trim().length > 0 ? true : "URL is required"),
	});
	const gitUrl = normalizeGitUrl(repoUrl);

	console.log();
	console.log(chalk.dim(`  Cloning from ${gitUrl}...`));

	if (deps.isGitRepo(basePath) && hasUncommittedChanges(basePath)) {
		const proceed = await confirm({
			message: "You have uncommitted changes. Create backup commit first?",
			default: true,
		});
		if (proceed) {
			const date = new Date().toISOString().replace(/[:.]/g, "-");
			await deps.gitAddAndCommit(basePath, `backup-before-import-${date}`);
			console.log(chalk.green("  ✓ Backup commit created"));
		}
	}

	const tmpDir = join(basePath, ".import-tmp");
	cleanupTmpDir(tmpDir);

	const spinner = ora("Cloning repository...").start();

	try {
		const clone = spawnSync("git", ["clone", "--depth", "1", gitUrl, tmpDir], {
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
			timeout: 60_000,
			windowsHide: true,
			env: {
				...process.env,
				GCM_INTERACTIVE: "never",
				GIT_ASKPASS: "echo",
				GIT_TERMINAL_PROMPT: "0",
			},
		});

		if (clone.status !== 0) {
			spinner.fail("Clone failed");
			console.log(chalk.red(`  ${readSpawnErr(clone.stderr) || "Unknown error"}`));
			cleanupTmpDir(tmpDir);
			return;
		}

		spinner.succeed("Repository cloned");

		const found = findConfigFiles(tmpDir);
		if (found.length === 0) {
			console.log(chalk.yellow("  No agent config files found in repository"));
			cleanupTmpDir(tmpDir);
			return;
		}

		console.log();
		console.log(chalk.dim("  Found config files:"));
		for (const file of found) {
			console.log(chalk.dim(`    • ${file}`));
		}
		console.log();

		const proceed = await confirm({
			message: `Import ${found.length} file(s)? (will overwrite existing)`,
			default: true,
		});
		if (!proceed) {
			cleanupTmpDir(tmpDir);
			return;
		}

		copyConfigFiles(tmpDir, basePath, found);
		copySkillDirs(tmpDir, basePath, deps);
		copyMemoryScripts(tmpDir, basePath, deps);
		cleanupTmpDir(tmpDir);
		ensureOriginRemote(basePath, gitUrl, deps);

		if (deps.isGitRepo(basePath)) {
			await deps.gitAddAndCommit(basePath, `import from ${repoUrl.trim()}`);
			console.log(chalk.green("  ✓ Changes committed"));
		}

		console.log();
		console.log(chalk.green("  Import complete!"));
		console.log(chalk.dim("  Run `signet daemon restart` to apply changes"));
	} catch (err) {
		spinner.fail("Import failed");
		console.log(chalk.red(`  ${readErr(err)}`));
		cleanupTmpDir(tmpDir);
	}
}

export function normalizeGitUrl(repoUrl: string): string {
	const trimmed = repoUrl.trim();
	const withoutTrailingSlash =
		trimmed.length > 1 ? trimmed.replace(/\/+$/, "") : trimmed;
	if (
		!withoutTrailingSlash.includes("://") &&
		!withoutTrailingSlash.startsWith("git@")
	) {
		return withoutTrailingSlash.endsWith(".git")
			? `https://github.com/${withoutTrailingSlash}`
			: `https://github.com/${withoutTrailingSlash}.git`;
	}
	if (
		withoutTrailingSlash.startsWith("https://github.com/") &&
		!withoutTrailingSlash.endsWith(".git")
	) {
		return `${withoutTrailingSlash}.git`;
	}
	return withoutTrailingSlash;
}

function hasUncommittedChanges(basePath: string): boolean {
	const result = spawnSync("git", ["status", "--porcelain"], {
		cwd: basePath,
		encoding: "utf-8",
		windowsHide: true,
	});
	return typeof result.stdout === "string" && result.stdout.trim().length > 0;
}

function cleanupTmpDir(path: string): void {
	if (existsSync(path)) {
		rmSync(path, { recursive: true, force: true });
	}
}

function readSpawnErr(value: string | Buffer | null): string {
	if (typeof value === "string") {
		return value.trim();
	}
	if (value instanceof Buffer) {
		return value.toString("utf-8").trim();
	}
	return "";
}

function findConfigFiles(tmpDir: string): string[] {
	const files = ["agent.yaml", "AGENTS.md", "SOUL.md", "IDENTITY.md", "USER.md", "MEMORY.md"];
	return files.filter((file) => existsSync(join(tmpDir, file)));
}

function copyConfigFiles(tmpDir: string, basePath: string, files: readonly string[]): void {
	for (const file of files) {
		copyFileSync(join(tmpDir, file), join(basePath, file));
		console.log(chalk.green(`  ✓ ${file}`));
	}
}

function copySkillDirs(tmpDir: string, basePath: string, deps: Deps): void {
	const dir = join(tmpDir, "skills");
	if (!existsSync(dir)) {
		return;
	}

	const skills = readdirSync(dir);
	if (skills.length === 0) {
		return;
	}

	mkdirSync(join(basePath, "skills"), { recursive: true });
	for (const skill of skills) {
		const src = join(dir, skill);
		const dest = join(basePath, "skills", skill);
		if (statSync(src).isDirectory()) {
			deps.copyDirRecursive(src, dest);
			console.log(chalk.green(`  ✓ skills/${skill}/`));
		}
	}
}

function copyMemoryScripts(tmpDir: string, basePath: string, deps: Deps): void {
	const dir = join(tmpDir, "memory", "scripts");
	if (!existsSync(dir)) {
		return;
	}

	mkdirSync(join(basePath, "memory", "scripts"), { recursive: true });
	deps.copyDirRecursive(dir, join(basePath, "memory", "scripts"));
	console.log(chalk.green("  ✓ memory/scripts/"));
}

function ensureOriginRemote(basePath: string, gitUrl: string, deps: Deps): void {
	if (!deps.isGitRepo(basePath)) {
		return;
	}

	const remote = spawnSync("git", ["remote", "get-url", "origin"], {
		cwd: basePath,
		encoding: "utf-8",
		windowsHide: true,
	});
	if (remote.status === 0) {
		return;
	}

	spawnSync("git", ["remote", "add", "origin", gitUrl], {
		cwd: basePath,
		windowsHide: true,
	});
	console.log(chalk.dim(`  Set origin remote to ${gitUrl}`));
}

function readErr(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
