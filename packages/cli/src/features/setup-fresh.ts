import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OpenClawConnector } from "@signet/connector-openclaw";
import { ensureUnifiedSchema, formatYaml, resolvePrimaryPackageManager, runMigrations } from "@signet/core";
import chalk from "chalk";
import open from "open";
import ora from "ora";
import { daemonAccessLines } from "../lib/network.js";
import Database from "../sqlite.js";
import { installForge, managedForgeInstallSupportedOnCurrentPlatform } from "./forge.js";
import { buildSetupPipeline } from "./setup-pipeline.js";
import { enforceSetupProtection, printSetupProtectionSummary, refreshSnapshotProtection } from "./setup-protection.js";
import { readErr, readRecord } from "./setup-shared.js";
import type { FreshSetupConfig, SetupDeps } from "./setup-types.js";

export async function runFreshSetup(cfg: FreshSetupConfig, deps: SetupDeps): Promise<void> {
	const spinner = ora("Setting up Signet...").start();

	try {
		if (cfg.nonInteractive && !cfg.allowUnprotectedWorkspace && !cfg.createLocalBackup) {
			await enforceSetupProtection({
				basePath: cfg.basePath,
				nonInteractive: true,
				allowUnprotectedWorkspace: false,
				createLocalBackup: false,
				assumeOpenClawLinked: cfg.configureOpenClawWs && cfg.openclawConfigCount > 0,
			});
		}

		const templatesDir = deps.getTemplatesDir();
		mkdirSync(cfg.basePath, { recursive: true });

		const gitignoreSource = join(templatesDir, "gitignore.template");
		if (existsSync(gitignoreSource)) {
			copyFileSync(gitignoreSource, join(cfg.basePath, ".gitignore"));
		}

		if (cfg.gitEnabled && !deps.isGitRepo(cfg.basePath)) {
			spinner.text = "Initializing git...";
			await deps.gitInit(cfg.basePath);
		}

		if (cfg.gitEnabled && cfg.existingAgentsDir) {
			spinner.text = "Creating backup commit...";
			const date = new Date().toISOString().split("T")[0];
			await deps.gitAddAndCommit(cfg.basePath, `${date}_pre-signet-backup`);
		}

		mkdirSync(join(cfg.basePath, "memory", "scripts"), { recursive: true });
		mkdirSync(join(cfg.basePath, "harnesses"), { recursive: true });

		spinner.text = "Installing memory system...";
		const scriptsSource = join(templatesDir, "memory", "scripts");
		if (existsSync(scriptsSource)) {
			deps.copyDirRecursive(scriptsSource, join(cfg.basePath, "memory", "scripts"));
		}

		const requirementsSource = join(templatesDir, "memory", "requirements.txt");
		if (existsSync(requirementsSource)) {
			copyFileSync(requirementsSource, join(cfg.basePath, "memory", "requirements.txt"));
		}

		const utilScriptsSource = join(templatesDir, "scripts");
		if (existsSync(utilScriptsSource)) {
			mkdirSync(join(cfg.basePath, "scripts"), { recursive: true });
			deps.copyDirRecursive(utilScriptsSource, join(cfg.basePath, "scripts"));
		}

		spinner.text = "Installing built-in skills...";
		deps.syncBuiltinSkills(templatesDir, cfg.basePath);

		spinner.text = "Creating agent identity...";
		const agentsTemplate = join(templatesDir, "AGENTS.md.template");
		let agentsMd: string;
		if (existsSync(agentsTemplate)) {
			agentsMd = readFileSync(agentsTemplate, "utf-8").replace(/\{\{AGENT_NAME\}\}/g, cfg.agentName);
		} else {
			agentsMd = `# ${cfg.agentName}\n\nThis is your agent identity file. Define your agent's personality, capabilities,\nand behaviors here. This file is shared across all your AI tools.\n\n## Personality\n\n${cfg.agentName} is a helpful assistant.\n\n## Instructions\n\n- Be concise and direct\n- Ask clarifying questions when needed\n- Remember user preferences\n`;
		}
		writeFileSync(join(cfg.basePath, "AGENTS.md"), agentsMd);

		spinner.text = "Writing configuration...";
		const now = new Date().toISOString();
		const packageManager = resolvePrimaryPackageManager({ agentsDir: cfg.basePath, env: process.env });
		const config: Record<string, unknown> = {
			version: 1,
			schema: "signet/v1",
			agent: {
				name: cfg.agentName,
				description: cfg.agentDescription,
				created: now,
				updated: now,
			},
			network: {
				mode: cfg.networkMode,
			},
			harnesses: cfg.harnesses,
			install: {
				primary_package_manager: packageManager.family,
				source: packageManager.source,
			},
			memory: {
				database: "memory/memories.db",
				session_budget: cfg.memorySessionBudget,
				decay_rate: cfg.memoryDecayRate,
			},
			search: {
				alpha: cfg.searchBalance,
				top_k: cfg.searchTopK,
				min_score: cfg.searchMinScore,
			},
		};

		if (cfg.embeddingProvider !== "none") {
			config.embedding = {
				provider: cfg.embeddingProvider,
				model: cfg.embeddingModel,
				dimensions: cfg.embeddingDimensions,
			};
		}

		const memory = readRecord(config.memory);
		memory.pipelineV2 = buildSetupPipeline(cfg.extractionProvider, cfg.extractionModel);
		config.memory = memory;

		writeFileSync(join(cfg.basePath, "agent.yaml"), formatYaml(config));

		const docFiles = [
			{ name: "MEMORY.md", template: "MEMORY.md.template" },
			{ name: "SOUL.md", template: "SOUL.md.template" },
			{ name: "IDENTITY.md", template: "IDENTITY.md.template" },
			{ name: "USER.md", template: "USER.md.template" },
		];

		for (const doc of docFiles) {
			const templatePath = join(templatesDir, doc.template);
			const destPath = join(cfg.basePath, doc.name);
			if (existsSync(destPath)) {
				continue;
			}
			if (existsSync(templatePath)) {
				const content = readFileSync(templatePath, "utf-8").replace(/\{\{AGENT_NAME\}\}/g, cfg.agentName);
				writeFileSync(destPath, content);
			}
		}

		spinner.text = "Initializing database...";
		const dbPath = join(cfg.basePath, "memory", "memories.db");
		const db = Database(dbPath);
		try {
			ensureUnifiedSchema(db);
			runMigrations(db);
		} finally {
			db.close();
		}

		let protection = await enforceSetupProtection({
			basePath: cfg.basePath,
			nonInteractive: cfg.nonInteractive,
			allowUnprotectedWorkspace: cfg.allowUnprotectedWorkspace,
			createLocalBackup: cfg.createLocalBackup,
			assumeOpenClawLinked: cfg.configureOpenClawWs && cfg.openclawConfigCount > 0,
		});

		if (cfg.harnesses.includes("forge") && !deps.detectExistingSetup(cfg.basePath).harnesses.forge) {
			if (!managedForgeInstallSupportedOnCurrentPlatform()) {
				throw new Error(
					`Forge is selected, but Signet-managed Forge binaries are only available on macOS/Linux arm64/x64. Install Forge separately on ${process.platform} ${process.arch}, then rerun ${chalk.cyan("signet setup")}.`,
				);
			}
			spinner.text = "Installing Forge...";
			await installForge(
				{},
				{
					agentsDir: cfg.basePath,
					defaultPort: deps.DEFAULT_PORT,
					getTemplatesDir: deps.getTemplatesDir,
					isDaemonRunning: deps.isDaemonRunning,
				},
			);
		}

		spinner.text = "Configuring harness hooks...";
		const configuredHarnesses: string[] = [];
		for (const harness of cfg.harnesses) {
			try {
				await deps.configureHarnessHooks(harness, cfg.basePath, { openclawRuntimePath: cfg.openclawRuntimePath });
				configuredHarnesses.push(harness);
			} catch (err) {
				console.warn(`\n  ⚠ Could not configure ${harness}: ${readErr(err)}`);
			}
		}

		if (cfg.configureOpenClawWs) {
			spinner.text = "Configuring OpenClaw workspace...";
			const patched = await new OpenClawConnector().configureWorkspace(cfg.basePath);
			if (patched.length > 0) {
				console.log(chalk.dim(`\n  ✓ OpenClaw workspace set to ${cfg.basePath}`));
			}
		}

		if (protection.state === "snapshot") {
			spinner.text = "Refreshing workspace snapshot...";
			protection = refreshSnapshotProtection(cfg.basePath, protection);
		}

		let committed = false;
		if (cfg.gitEnabled) {
			const date = new Date().toISOString().split("T")[0];
			committed = await deps.gitAddAndCommit(cfg.basePath, `${date}_signet-setup`);
		}

		spinner.text = "Starting daemon...";
		const daemonStarted = await deps.startDaemon(cfg.basePath);

		spinner.succeed(chalk.green("Signet initialized!"));

		console.log();
		console.log(chalk.dim("  Files created:"));
		console.log(chalk.dim(`    ${cfg.basePath}/`));
		console.log(chalk.dim("    ├── agent.yaml    manifest & config"));
		console.log(chalk.dim("    ├── AGENTS.md     agent instructions"));
		console.log(chalk.dim("    ├── SOUL.md       personality & tone"));
		console.log(chalk.dim("    ├── IDENTITY.md   agent identity"));
		console.log(chalk.dim("    ├── USER.md       your profile"));
		console.log(chalk.dim("    ├── MEMORY.md     working memory"));
		console.log(chalk.dim("    └── memory/       database & vectors"));

		if (configuredHarnesses.length > 0) {
			console.log();
			console.log(chalk.dim("  Harnesses configured:"));
			for (const harness of configuredHarnesses) {
				console.log(chalk.dim(`    ✓ ${harness}`));
			}
		}

		if (daemonStarted) {
			console.log();
			console.log(chalk.green("  ● Daemon running"));
			for (const line of daemonAccessLines(deps.DEFAULT_PORT, cfg.networkMode)) {
				console.log(chalk.dim(`    ${line}`));
			}
		}

		console.log();
		if (committed) {
			console.log(chalk.dim("  ✓ Changes committed to git"));
		}

		if (cfg.nonInteractive) {
			if (cfg.openDashboard) {
				await open(`http://localhost:${deps.DEFAULT_PORT}`);
			}
		} else {
			const launchNow = await import("@inquirer/prompts").then(({ confirm }) =>
				confirm({ message: "Open the dashboard?", default: true }),
			);
			if (launchNow) {
				await open(`http://localhost:${deps.DEFAULT_PORT}`);
			}
		}

		console.log();
		printSetupProtectionSummary(protection);
		console.log();
		console.log(chalk.cyan("  → Next step: Say '/onboarding' to personalize your agent"));
		console.log(chalk.dim("    This will walk you through setting up your agent's personality,"));
		console.log(chalk.dim("    communication style, and your preferences."));
		if (protection.state === "bypass") {
			console.log(chalk.red("    Backup warning: this workspace is still unprotected."));
		}
	} catch (err) {
		spinner.fail(chalk.red("Setup failed"));
		console.error(err);
		process.exit(1);
	}
}
