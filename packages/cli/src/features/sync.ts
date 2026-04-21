import { copyFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { GeminiConnector } from "@signet/connector-gemini";
import { HermesAgentConnector } from "@signet/connector-hermes-agent";
import { OhMyPiConnector } from "@signet/connector-oh-my-pi";
import { OpenClawConnector } from "@signet/connector-openclaw";
import { PiConnector } from "@signet/connector-pi";
import type { WorkspaceSourceRepoSyncResult } from "@signet/core";
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
	readonly syncPredictorBinary: (basePath: string) => Promise<SyncState>;
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

function detectHarnesses(): string[] {
	const found: string[] = [];

	if (existsSync(join(homedir(), ".claude", "settings.json"))) {
		found.push("claude-code");
	}
	if (
		existsSync(join(homedir(), ".config", "signet", "bin", "codex")) ||
		existsSync(join(homedir(), ".codex", "config.toml"))
	) {
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
	if (new HermesAgentConnector().isInstalled()) {
		found.push("hermes-agent");
	}
	if (new GeminiConnector().isInstalled()) {
		found.push("gemini");
	}
	if (new PiConnector().isInstalled()) {
		found.push("pi");
	}

	return found;
}
