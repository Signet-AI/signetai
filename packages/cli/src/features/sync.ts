import { OhMyPiConnector } from "@signet/connector-oh-my-pi";
import { OpenClawConnector } from "@signet/connector-openclaw";
import chalk from "chalk";
import { copyFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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
	readonly configureHarnessHooks: (harness: string, basePath: string) => Promise<void>;
	readonly getTemplatesDir: () => string;
	readonly signetLogo: () => string;
	readonly syncBuiltinSkills: (templatesDir: string, basePath: string) => SkillSync;
	readonly syncNativeEmbeddingModel: (basePath: string) => Promise<SyncState>;
	readonly syncPredictorBinary: (basePath: string) => Promise<SyncState>;
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
	synced += syncSkills(basePath, templatesDir, deps);
	synced += await syncPredictor(basePath, deps);
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

function syncSkills(basePath: string, templatesDir: string, deps: Deps): number {
	const result = deps.syncBuiltinSkills(templatesDir, basePath);
	for (const skill of result.installed) {
		console.log(chalk.green(`  ✓ skills/${skill} (installed)`));
	}
	for (const skill of result.updated) {
		console.log(chalk.green(`  ✓ skills/${skill} (updated)`));
	}
	return result.installed.length + result.updated.length;
}

async function syncPredictor(basePath: string, deps: Deps): Promise<number> {
	const predictor = await deps.syncPredictorBinary(basePath);
	if (predictor.status === "updated") {
		console.log(chalk.green(`  ✓ predictor sidecar (${predictor.message})`));
		return 1;
	}
	if (predictor.status === "current") {
		console.log(chalk.dim("  predictor sidecar is up to date"));
		return 0;
	}
	if (predictor.status === "skipped") {
		console.log(chalk.dim(`  predictor sidecar skipped: ${predictor.message}`));
		return 0;
	}

	console.log(chalk.yellow(`  ⚠ predictor sidecar sync failed: ${predictor.message}`));
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
	for (const harness of detectHarnesses()) {
		try {
			await deps.configureHarnessHooks(harness, basePath);
			console.log(chalk.green(`  ✓ hooks re-registered for ${harness}`));
			synced += 1;
		} catch {
			console.log(chalk.yellow(`  ⚠ hooks re-registration failed for ${harness}`));
		}
	}
	return synced;
}

function detectHarnesses(): string[] {
	const found: string[] = [];

	if (existsSync(join(homedir(), ".claude", "settings.json"))) {
		found.push("claude-code");
	}
	if (existsSync(join(homedir(), ".config", "signet", "bin", "codex")) || existsSync(join(homedir(), ".codex", "config.toml"))) {
		found.push("codex");
	}
	if (existsSync(join(homedir(), ".config", "opencode"))) {
		found.push("opencode");
	}
	if (new OpenClawConnector().isInstalled()) {
		found.push("openclaw");
	}
	if (new OhMyPiConnector().isInstalled()) {
		found.push("oh-my-pi");
	}

	return found;
}
