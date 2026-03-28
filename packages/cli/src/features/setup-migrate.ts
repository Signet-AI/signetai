import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { confirm } from "@inquirer/prompts";
import {
	Database as CoreDatabase,
	type ImportResult,
	type SetupDetection,
	type SkillsResult,
	ensureUnifiedSchema,
	findSignetForgeBinary,
	formatYaml,
	importMemoryLogs,
	resolvePrimaryPackageManager,
	runMigrations,
	unifySkills,
} from "@signet/core";
import { readNetworkMode } from "@signet/core";
import chalk from "chalk";
import open from "open";
import ora from "ora";
import { daemonAccessLines } from "../lib/network.js";
import Database from "../sqlite.js";
import { installForge, managedForgeInstallSupportedOnCurrentPlatform } from "./forge.js";
import { buildSetupPipeline, defaultExtractionModel } from "./setup-pipeline.js";
import { enforceSetupProtection, printSetupProtectionSummary, refreshSnapshotProtection } from "./setup-protection.js";
import {
	type EmbeddingProviderChoice,
	type ExtractionProviderChoice,
	getEmbeddingDimensions,
	readErr,
	readHarnesses,
	readRecord,
	readString,
} from "./setup-shared.js";
import type { SetupDeps } from "./setup-types.js";

export async function runExistingSetupWizard(
	basePath: string,
	detection: SetupDetection,
	existingConfig: Record<string, unknown>,
	deps: SetupDeps,
	options?: {
		nonInteractive?: boolean;
		openDashboard?: boolean;
		skipGit?: boolean;
		allowUnprotectedWorkspace?: boolean;
		createLocalBackup?: boolean;
		embeddingProvider?: EmbeddingProviderChoice;
		embeddingModel?: string;
		extractionProvider?: ExtractionProviderChoice;
		extractionModel?: string;
	},
): Promise<void> {
	const spinner = ora("Setting up Signet for existing identity...").start();

	try {
		const templatesDir = deps.getTemplatesDir();
		if (
			options?.nonInteractive === true &&
			options.allowUnprotectedWorkspace !== true &&
			options.createLocalBackup !== true
		) {
			await enforceSetupProtection({
				basePath,
				nonInteractive: true,
				allowUnprotectedWorkspace: false,
				createLocalBackup: false,
			});
		}

		if (!existsSync(basePath)) {
			mkdirSync(basePath, { recursive: true });
		}
		if (!existsSync(join(basePath, "memory"))) {
			mkdirSync(join(basePath, "memory"), { recursive: true });
		}
		if (!existsSync(join(basePath, "memory", "scripts"))) {
			mkdirSync(join(basePath, "memory", "scripts"), { recursive: true });
		}

		spinner.text = "Installing memory system...";
		const scriptsSource = join(templatesDir, "memory", "scripts");
		if (existsSync(scriptsSource)) {
			deps.copyDirRecursive(scriptsSource, join(basePath, "memory", "scripts"));
		}

		const requirementsSource = join(templatesDir, "memory", "requirements.txt");
		if (existsSync(requirementsSource)) {
			copyFileSync(requirementsSource, join(basePath, "memory", "requirements.txt"));
		}

		spinner.text = "Syncing built-in skills...";
		deps.syncBuiltinSkills(templatesDir, basePath);

		spinner.text = "Creating agent manifest...";
		const now = new Date().toISOString();
		let agentName = "My Agent";
		const identityPath = join(basePath, "IDENTITY.md");
		if (existsSync(identityPath)) {
			try {
				const content = readFileSync(identityPath, "utf-8");
				const nameMatch = content.match(/^#\s*(.+)$/m);
				if (nameMatch) {
					agentName = nameMatch[1].trim();
				}
			} catch {
				// Ignore
			}
		}

		const detectedHarnesses: string[] = [];
		if (detection.harnesses.claudeCode) detectedHarnesses.push("claude-code");
		if (detection.harnesses.openclaw) detectedHarnesses.push("openclaw");
		if (detection.harnesses.opencode) detectedHarnesses.push("opencode");
		if (detection.harnesses.codex) detectedHarnesses.push("codex");
		const configuredHarnessList = readHarnesses(existingConfig.harnesses);
		if (detection.harnesses.ohMyPi || configuredHarnessList.includes("oh-my-pi")) detectedHarnesses.push("oh-my-pi");
		const wantsForge = detection.harnesses.forge || configuredHarnessList.includes("forge");
		const installedForgePath = findSignetForgeBinary(basePath);
		if (wantsForge && installedForgePath) {
			detectedHarnesses.push("forge");
		} else if (wantsForge) {
			if (!managedForgeInstallSupportedOnCurrentPlatform()) {
				throw new Error(
					`Forge is configured, but Signet-managed Forge binaries are only available on macOS/Linux arm64/x64. Install Forge separately on ${process.platform} ${process.arch}, then rerun ${chalk.cyan("signet setup")}.`,
				);
			}
			spinner.text = "Installing Forge...";
			await installForge(
				{},
				{
					agentsDir: basePath,
					defaultPort: deps.DEFAULT_PORT,
					getTemplatesDir: deps.getTemplatesDir,
					isDaemonRunning: deps.isDaemonRunning,
				},
			);
			detectedHarnesses.push("forge");
		}
		const packageManager = resolvePrimaryPackageManager({ agentsDir: basePath, env: process.env });
		const existingAgent = readRecord(existingConfig.agent);

		const config: Record<string, unknown> = {
			version: 1,
			schema: "signet/v1",
			agent: {
				name: agentName,
				description:
					readString(existingConfig.description) ?? readString(existingAgent.description) ?? "Personal AI assistant",
				created: now,
				updated: now,
			},
			network: {
				mode: readNetworkMode(existingConfig),
			},
			harnesses: detectedHarnesses,
			install: {
				primary_package_manager: packageManager.family,
				source: packageManager.source,
			},
			memory: {
				database: "memory/memories.db",
				session_budget: 2000,
				decay_rate: 0.95,
			},
			search: {
				alpha: 0.7,
				top_k: 20,
				min_score: 0.3,
			},
			identity: {
				agents: "AGENTS.md",
				soul: "SOUL.md",
				identity: "IDENTITY.md",
				user: "USER.md",
				heartbeat: "HEARTBEAT.md",
				memory: "MEMORY.md",
				tools: "TOOLS.md",
			},
		};

		if (options?.embeddingProvider && options.embeddingProvider !== "none") {
			const model =
				options.embeddingModel ||
				(options.embeddingProvider === "openai" ? "text-embedding-3-small" : "nomic-embed-text");
			config.embedding = {
				provider: options.embeddingProvider,
				model,
				dimensions: getEmbeddingDimensions(model),
			};
		}

		if (options?.extractionProvider) {
			const memory = readRecord(config.memory);
			memory.pipelineV2 = buildSetupPipeline(
				options.extractionProvider,
				options.extractionModel || defaultExtractionModel(options.extractionProvider),
			);
			config.memory = memory;
		}

		if (!existsSync(join(basePath, "agent.yaml"))) {
			writeFileSync(join(basePath, "agent.yaml"), formatYaml(config));
		}

		const agentsPath = join(basePath, "AGENTS.md");
		if (!existsSync(agentsPath)) {
			const agentsTemplate = join(templatesDir, "AGENTS.md.template");
			if (existsSync(agentsTemplate)) {
				const content = readFileSync(agentsTemplate, "utf-8").replace(/\{\{AGENT_NAME\}\}/g, agentName);
				writeFileSync(agentsPath, content);
			} else {
				writeFileSync(
					agentsPath,
					`# ${agentName}\n\nThis is your agent identity file. Define your agent's personality, capabilities,\nand behaviors here. This file is shared across all your AI tools.\n`,
				);
			}
		}

		const docs = [
			{ name: "MEMORY.md", template: "MEMORY.md.template" },
			{ name: "SOUL.md", template: "SOUL.md.template" },
			{ name: "IDENTITY.md", template: "IDENTITY.md.template" },
			{ name: "USER.md", template: "USER.md.template" },
		];

		for (const doc of docs) {
			const path = join(basePath, doc.name);
			if (existsSync(path)) {
				continue;
			}
			const template = join(templatesDir, doc.template);
			if (!existsSync(template)) {
				continue;
			}
			const content = readFileSync(template, "utf-8").replace(/\{\{AGENT_NAME\}\}/g, agentName);
			writeFileSync(path, content);
		}

		spinner.text = "Initializing database...";
		const dbPath = join(basePath, "memory", "memories.db");
		const db = Database(dbPath);
		const migrationResult = ensureUnifiedSchema(db);
		if (migrationResult.migrated) {
			spinner.text = `Migrated ${migrationResult.memoriesMigrated} memories from ${migrationResult.fromSchema} schema...`;
		}
		runMigrations(db);
		db.close();

		let protection = await enforceSetupProtection({
			basePath,
			nonInteractive: options?.nonInteractive === true,
			allowUnprotectedWorkspace: options?.allowUnprotectedWorkspace === true,
			createLocalBackup: options?.createLocalBackup === true,
		});

		let importResult: ImportResult | null = null;
		if (detection.hasMemoryDir && detection.memoryLogCount > 0) {
			spinner.text = `Importing ${detection.memoryLogCount} memory logs...`;
			let coreDb: CoreDatabase | null = null;
			try {
				coreDb = new CoreDatabase(dbPath);
				importResult = importMemoryLogs(basePath, coreDb);
			} catch (err) {
				console.warn(`\n  ⚠ Memory import warning: ${readErr(err)}`);
			} finally {
				coreDb?.close();
			}
		}

		let skillsResult: SkillsResult | null = null;
		spinner.text = "Unifying skills...";
		try {
			skillsResult = await unifySkills(basePath, {
				registries: [
					detection.harnesses.opencode
						? { path: join(homedir(), ".config", "opencode", "skills"), harness: "opencode", symlink: true }
						: null,
				].filter((entry): entry is { path: string; harness: string; symlink: boolean } => entry !== null),
			});
		} catch (err) {
			console.warn(`\n  ⚠ Skills unification warning: ${readErr(err)}`);
		}

		spinner.text = "Configuring harness connectors...";
		const configuredHarnesses: string[] = [];
		for (const harness of detectedHarnesses) {
			try {
				await deps.configureHarnessHooks(harness, basePath);
				configuredHarnesses.push(harness);
			} catch (err) {
				console.warn(`\n  ⚠ Could not configure ${harness}: ${readErr(err)}`);
			}
		}

		const gitignoreSrc = join(templatesDir, "gitignore.template");
		const gitignoreDest = join(basePath, ".gitignore");
		if (existsSync(gitignoreSrc) && !existsSync(gitignoreDest)) {
			copyFileSync(gitignoreSrc, gitignoreDest);
		}

		let gitEnabled = false;
		if (options?.skipGit !== true) {
			if (!deps.isGitRepo(basePath)) {
				spinner.text = "Initializing git...";
				gitEnabled = await deps.gitInit(basePath);
			} else {
				gitEnabled = true;
			}
		}

		if (protection.state === "snapshot") {
			spinner.text = "Refreshing workspace snapshot...";
			protection = refreshSnapshotProtection(basePath, protection);
		}

		let committed = false;
		if (options?.skipGit !== true && gitEnabled) {
			const date = new Date().toISOString().split("T")[0];
			committed = await deps.gitAddAndCommit(basePath, `${date}_signet-setup`);
		}

		spinner.text = "Starting daemon...";
		const daemonStarted = await deps.startDaemon(basePath);

		spinner.succeed(chalk.green("Signet setup complete!"));
		console.log();
		console.log(chalk.dim("  Your existing identity files are now managed by Signet."));
		console.log(chalk.dim(`    ${basePath}`));
		console.log();

		if (importResult && importResult.imported > 0) {
			console.log(chalk.dim(`  Memory logs imported: ${importResult.imported} entries`));
			if (importResult.skipped > 0) {
				console.log(chalk.dim(`    (${importResult.skipped} skipped)`));
			}
		}

		if (skillsResult && (skillsResult.imported > 0 || skillsResult.symlinked > 0)) {
			console.log(
				chalk.dim(`  Skills unified: ${skillsResult.imported} imported, ${skillsResult.symlinked} symlinked`),
			);
		}

		if (configuredHarnesses.length > 0) {
			console.log();
			console.log(chalk.dim("  Connectors installed for:"));
			for (const harness of configuredHarnesses) {
				console.log(chalk.dim(`    ✓ ${harness}`));
			}
		}

		if (daemonStarted) {
			console.log();
			console.log(chalk.green("  ● Daemon running"));
			for (const line of daemonAccessLines(deps.DEFAULT_PORT, readNetworkMode(config))) {
				console.log(chalk.dim(`    ${line}`));
			}
		}

		if (committed) {
			console.log(chalk.dim("  ✓ Changes committed to git"));
		}

		console.log();
		printSetupProtectionSummary(protection);
		console.log();
		if (options?.nonInteractive === true) {
			if (options.openDashboard === true) {
				await open(`http://localhost:${deps.DEFAULT_PORT}`);
			}
		} else {
			const launchNow = await confirm({ message: "Open the dashboard?", default: true });
			if (launchNow) {
				await open(`http://localhost:${deps.DEFAULT_PORT}`);
			}
		}

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
