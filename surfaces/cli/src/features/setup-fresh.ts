import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OpenClawConnector } from "@signet/connector-openclaw";
import {
	addObsidianSource,
	buildAgentMemoryConfig,
	disableGraphiqState,
	ensureUnifiedSchema,
	formatYaml,
	resolvePrimaryPackageManager,
	runMigrations,
} from "@signet/core";
import chalk from "chalk";
import open from "open";
import ora from "ora";
import { daemonAccessLines } from "../lib/network.js";
import Database from "../sqlite.js";
import { installGraphiqPlugin } from "./graphiq.js";
import { applyInferenceRoute, buildExtractionRoute, modelOptions } from "./setup-inference-connect.js";
import {
	applyAggregateRecallRoute,
	applySetupInferenceRoute,
	buildSetupAggregateRecall,
	buildSetupInference,
	buildSetupPipeline,
} from "./setup-pipeline.js";
import type { SetupApplyContext, SetupPlan } from "./setup-plan.js";
import { writeSetupCorePluginRegistry } from "./setup-plugins.js";
import { enforceSetupProtection, printSetupProtectionSummary, refreshSnapshotProtection } from "./setup-protection.js";
import { formatWorkspaceSourceRepoSync, readErr, readRecord } from "./setup-shared.js";
import type { SetupDeps } from "./setup-types.js";

export async function runFreshSetup(plan: SetupPlan, context: SetupApplyContext, deps: SetupDeps): Promise<void> {
	const spinner = ora("Setting up Signet...").start();
	let graphiqInstalled = false;

	try {
		if (context.nonInteractive && !context.allowUnprotectedWorkspace && !context.createLocalBackup) {
			await enforceSetupProtection({
				basePath: context.basePath,
				nonInteractive: true,
				allowUnprotectedWorkspace: false,
				createLocalBackup: false,
				assumeOpenClawLinked: plan.configureOpenClawWs && context.openclawConfigCount > 0,
			});
		}

		const templatesDir = deps.getTemplatesDir();
		mkdirSync(context.basePath, { recursive: true });

		const gitignoreSource = join(templatesDir, "gitignore.template");
		if (existsSync(gitignoreSource)) {
			copyFileSync(gitignoreSource, join(context.basePath, ".gitignore"));
		}

		if (plan.gitEnabled && !deps.isGitRepo(context.basePath)) {
			spinner.text = "Initializing git...";
			await deps.gitInit(context.basePath);
		}

		if (plan.gitEnabled && context.existingAgentsDir) {
			spinner.text = "Creating backup commit...";
			const date = new Date().toISOString().split("T")[0];
			await deps.gitAddAndCommit(context.basePath, `${date}_pre-signet-backup`);
		}

		mkdirSync(join(context.basePath, "memory", "scripts"), { recursive: true });
		mkdirSync(join(context.basePath, "harnesses"), { recursive: true });

		spinner.text = "Installing memory system...";
		const scriptsSource = join(templatesDir, "memory", "scripts");
		if (existsSync(scriptsSource)) {
			deps.copyDirRecursive(scriptsSource, join(context.basePath, "memory", "scripts"));
		}

		const requirementsSource = join(templatesDir, "memory", "requirements.txt");
		if (existsSync(requirementsSource)) {
			copyFileSync(requirementsSource, join(context.basePath, "memory", "requirements.txt"));
		}

		const utilScriptsSource = join(templatesDir, "scripts");
		if (existsSync(utilScriptsSource)) {
			mkdirSync(join(context.basePath, "scripts"), { recursive: true });
			deps.copyDirRecursive(utilScriptsSource, join(context.basePath, "scripts"));
		}

		spinner.text = "Installing built-in skills...";
		deps.syncBuiltinSkills(deps.getSkillsSourceDir(), context.basePath);

		spinner.text = "Cloning Signet source checkout...";
		const sourceRepoSync = await deps.syncWorkspaceSourceRepo(context.basePath);

		if (plan.identityMode === "managed") {
			spinner.text = "Creating agent identity...";
			const agentsTemplate = join(templatesDir, "AGENTS.md.template");
			let agentsMd: string;
			if (existsSync(agentsTemplate)) {
				agentsMd = readFileSync(agentsTemplate, "utf-8").replace(/\{\{AGENT_NAME\}\}/g, plan.agentName);
			} else {
				agentsMd = `# ${plan.agentName}\n\nThis is your agent identity file. Define your agent's personality, capabilities,\nand behaviors here. This file is shared across all your AI tools.\n\n## Personality\n\n${plan.agentName} is a helpful assistant.\n\n## Instructions\n\n- Be concise and direct\n- Ask clarifying questions when needed\n- Remember user preferences\n`;
			}
			writeFileSync(join(context.basePath, "AGENTS.md"), agentsMd);
		}

		spinner.text = "Writing configuration...";
		const now = new Date().toISOString();
		const packageManager = resolvePrimaryPackageManager({ agentsDir: context.basePath, env: process.env });
		const config: Record<string, unknown> = {
			version: 1,
			schema: "signet/v1",
			capabilities: {
				memory: { enabled: true, autoInject: true, memoryHead: true },
				secrets: { enabled: plan.signetSecretsEnabled },
				identity: { mode: plan.identityMode },
			},
			agent: {
				name: plan.agentName,
				description: plan.agentDescription,
				created: now,
				updated: now,
			},
			network: {
				mode: plan.networkMode,
			},
			harnesses: plan.harnesses,
			install: {
				primary_package_manager: packageManager.family,
				source: packageManager.source,
			},
			memory: {
				database: "memory/memories.db",
				session_budget: plan.memorySessionBudget,
				decay_rate: plan.memoryDecayRate,
			},
			search: {
				alpha: plan.searchBalance,
				top_k: plan.searchTopK,
				min_score: plan.searchMinScore,
			},
		};

		if (plan.identityMode === "managed") {
			config.identity = {
				preset: plan.identityPreset,
				startup: {
					load: plan.startupIdentityFiles,
				},
				special: plan.specialIdentityFiles,
			};
		}

		if (plan.embeddingProvider !== "none") {
			config.embedding = {
				provider: plan.embeddingProvider,
				model: plan.embeddingModel,
				dimensions: plan.embeddingDimensions,
			};
		}

		const memory = readRecord(config.memory);
		memory.pipelineV2 = buildSetupPipeline(plan.extractionProvider);
		if (plan.dreamingEnabled) {
			memory.dreaming = {};
		}
		config.memory = memory;
		const inference = buildSetupInference(
			plan.extractionProvider,
			plan.extractionModel,
			plan.harnesses,
			context.availableExtractionProviders,
			context.acpxBin,
			plan.extractionEndpoint,
		);
		applySetupInferenceRoute(config, inference);

		// Dashboard-style connected cloud provider: the modern inference.* route is
		// the source of truth (target + connected account). pipelineV2 stays enabled
		// so the extraction worker runs; the daemon merges inference.* atop the
		// legacy base, so this target overrides the legacy extraction target.
		if (plan.extractionConnect) {
			applyInferenceRoute(
				config,
				buildExtractionRoute({
					kind: "cloud",
					executor: plan.extractionConnect.family,
					family: plan.extractionConnect.family,
					connectMethod: plan.extractionConnect.connectMethod,
					// extractionModel comes from the pi-ai model dropdown (non-empty for
					// connect plans); fall back to the family's first catalog model.
					model: plan.extractionModel || modelOptions(plan.extractionConnect.family)[0]?.id || "haiku",
				}),
			);
		}

		// Optional distinct provider for aggregate recall (query-time evidence
		// synthesis). Overlaid on config.inference; the daemon merges it atop the
		// legacy pipeline.* base, so extraction/session-synthesis are unaffected.
		if (plan.aggregateRecallProvider) {
			applyAggregateRecallRoute(
				config,
				buildSetupAggregateRecall(
					plan.aggregateRecallProvider,
					plan.aggregateRecallModel ?? "",
					plan.aggregateRecallEndpoint,
					plan.extractionConnect?.family === "openrouter" && plan.aggregateRecallProvider === "openrouter",
				),
			);
		}

		if (plan.agents && plan.agents.length > 0) {
			config.agents = {
				roster: plan.agents.map((agent) => ({
					name: agent.name,
					memory: buildAgentMemoryConfig(agent.memoryPolicy, agent.memoryGroup),
				})),
			};
		}

		if (plan.daemonUrl) {
			config.daemon = { url: plan.daemonUrl };
		}

		// Anonymous telemetry disclosure (issue #1026 Phase 2). Telemetry is ON
		// by default; interactive setups get a chance to disable it, and
		// non-interactive (CI/scripted) setups keep the default. Every recorded
		// event is mirrored to ~/.agents/.daemon/telemetry/events.jsonl so
		// users can audit exactly what is recorded and sent.
		let telemetryEnabled = true;
		if (!context.nonInteractive) {
			telemetryEnabled = await import("@inquirer/prompts").then(({ confirm }) =>
				confirm({
					message:
						"Help improve Signet by sharing anonymous usage statistics (version and command names) with PostHog? No memory content, code, arguments, paths, or personal data. Events are logged to ~/.agents/.daemon/telemetry/events.jsonl and, when remote delivery is configured and the workspace database is available, queued locally before best-effort delivery; disable anytime with telemetryEnabled: false.",
					default: true,
				}),
			);
		}
		// The daemon reads telemetryEnabled from memory.pipelineV2 — writing it
		// at the top level would be silently ignored and the opt-out would not
		// reach the daemon.
		const memoryCfg = (config.memory as Record<string, unknown> | undefined) ?? {};
		const pipelineCfg = (memoryCfg.pipelineV2 as Record<string, unknown> | undefined) ?? {};
		config.memory = { ...memoryCfg, pipelineV2: { ...pipelineCfg, telemetryEnabled } };

		writeFileSync(join(context.basePath, "agent.yaml"), formatYaml(config));

		// Connect configured sources (config files the daemon indexes at boot).
		if (plan.sources && plan.sources.length > 0) {
			for (const src of plan.sources) {
				if (src.type === "obsidian") {
					const result = addObsidianSource({ root: src.path, name: src.name }, context.basePath);
					if (result.ok) {
						console.log(chalk.dim(`  ✓ Obsidian source: ${result.source.name}`));
					} else {
						console.warn(chalk.yellow(`  ⚠ Could not add Obsidian source ${src.path}: ${result.error}`));
					}
				}
			}
		}

		writeSetupCorePluginRegistry(context.basePath, {
			signetSecretsEnabled: plan.signetSecretsEnabled,
			graphiqEnabled: plan.graphiqEnabled,
		});
		if (plan.graphiqEnabled) {
			spinner.stop();
			graphiqInstalled = await installGraphiqPlugin({ agentsDir: context.basePath });
			spinner.start("Continuing Signet setup...");
		} else {
			disableGraphiqState(context.basePath);
		}

		const docFiles = Array.from(
			new Set([
				...plan.startupIdentityFiles.map((entry) => entry.path),
				...plan.specialIdentityFiles.map((entry) => entry.path),
			]),
		).map((name) => ({ name, template: `${name}.template` }));

		for (const doc of docFiles) {
			const templatePath = join(templatesDir, doc.template);
			const destPath = join(context.basePath, doc.name);
			if (existsSync(destPath)) {
				continue;
			}
			if (existsSync(templatePath)) {
				const content = readFileSync(templatePath, "utf-8").replace(/\{\{AGENT_NAME\}\}/g, plan.agentName);
				writeFileSync(destPath, content);
			}
		}

		spinner.text = "Initializing database...";
		const dbPath = join(context.basePath, "memory", "memories.db");
		const db = Database(dbPath);
		try {
			ensureUnifiedSchema(db);
			runMigrations(db);
		} finally {
			db.close();
		}

		let protection = await enforceSetupProtection({
			basePath: context.basePath,
			nonInteractive: context.nonInteractive,
			allowUnprotectedWorkspace: context.allowUnprotectedWorkspace,
			createLocalBackup: context.createLocalBackup,
			assumeOpenClawLinked: plan.configureOpenClawWs && context.openclawConfigCount > 0,
		});

		spinner.text = "Configuring harness hooks...";
		// Hooks are installed before the daemon starts. This is safe because
		// connectors only write static files (extension bundles) with a
		// well-known daemon URL (127.0.0.1:3850). The extension resolves the
		// actual daemon address at runtime via SIGNET_DAEMON_URL, falling back
		// to the baked default — no live daemon connection is needed here.
		const configuredHarnesses: string[] = [];
		for (const harness of plan.harnesses) {
			try {
				await deps.configureHarnessHooks(harness, context.basePath, { openclawRuntimePath: plan.openclawRuntimePath });
				configuredHarnesses.push(harness);
			} catch (err) {
				console.warn(`\n  ⚠ Could not configure ${harness}: ${readErr(err)}`);
			}
		}

		if (plan.configureOpenClawWs) {
			spinner.text = "Configuring OpenClaw workspace...";
			const patched = await new OpenClawConnector().configureWorkspace(context.basePath);
			if (patched.length > 0) {
				console.log(chalk.dim(`\n  ✓ OpenClaw workspace set to ${context.basePath}`));
			}
		}

		if (protection.state === "snapshot") {
			spinner.text = "Refreshing workspace snapshot...";
			protection = refreshSnapshotProtection(context.basePath, protection);
		}

		let committed = false;
		if (plan.gitEnabled) {
			const date = new Date().toISOString().split("T")[0];
			committed = await deps.gitAddAndCommit(context.basePath, `${date}_signet-setup`);
		}

		const remoteDaemon = Boolean(plan.daemonUrl);
		let daemonStarted: boolean;
		if (remoteDaemon) {
			// Remote instance: no local daemon to start; the CLI/connector clients
			// resolve daemon.url from config at runtime.
			daemonStarted = true;
		} else {
			spinner.text = "Starting daemon...";
			daemonStarted = await deps.startDaemon(context.basePath);
		}

		if (!remoteDaemon && daemonStarted && plan.embeddingProvider === "native") {
			spinner.text = "Warming native embedding model...";
			const nativeResult = await deps.syncNativeEmbeddingModel(context.basePath);
			if (nativeResult.status === "error") {
				console.log(chalk.yellow(`\n  ⚠ Native embedding model warmup failed: ${nativeResult.message}`));
				console.log(chalk.dim("    Embeddings will be unavailable until this is resolved."));
				console.log(chalk.dim("    Run 'signet sync' to retry, or reconfigure with 'signet setup'."));
			}
		}

		spinner.succeed(chalk.green("Signet initialized!"));

		console.log();
		console.log(chalk.dim("  Files created:"));
		console.log(chalk.dim(`    ${context.basePath}/`));
		console.log(chalk.dim("    ├── agent.yaml    manifest & config"));
		const reportedDocs = Array.from(
			new Set([
				"AGENTS.md",
				...plan.startupIdentityFiles.map((entry) => entry.path),
				...plan.specialIdentityFiles.map((entry) => entry.path),
			]),
		).filter((name) => existsSync(join(context.basePath, name)));
		for (const name of reportedDocs) {
			const special = plan.specialIdentityFiles.some((entry) => entry.path === name) ? " (special session)" : "";
			console.log(chalk.dim(`    ├── ${name.padEnd(12)}${special}`));
		}
		console.log(chalk.dim("    ├── signetai/     Signet source checkout"));
		console.log(chalk.dim("    └── memory/       database & vectors"));

		console.log();
		console.log(chalk.dim("  Core plugins:"));
		console.log(
			chalk.dim(
				`    ${plan.signetSecretsEnabled ? "✓" : "○"} Signet Secrets ${plan.signetSecretsEnabled ? "enabled" : "installed but disabled"}`,
			),
		);
		console.log(
			chalk.dim(`    ${graphiqInstalled ? "✓" : "○"} GraphIQ ${graphiqInstalled ? "enabled" : "not installed"}`),
		);

		if (configuredHarnesses.length > 0) {
			console.log();
			console.log(chalk.dim("  Harnesses configured:"));
			for (const harness of configuredHarnesses) {
				console.log(chalk.dim(`    ✓ ${harness}`));
			}
		}

		const sourceRepoLine = formatWorkspaceSourceRepoSync(sourceRepoSync);
		if (sourceRepoLine) {
			console.log();
			console.log(chalk.dim(sourceRepoLine));
		}

		if (daemonStarted) {
			console.log();
			if (remoteDaemon) {
				console.log(chalk.green(`  ● Using remote daemon: ${plan.daemonUrl}`));
			} else {
				console.log(chalk.green("  ● Daemon running"));
				for (const line of daemonAccessLines(deps.DEFAULT_PORT, plan.networkMode)) {
					console.log(chalk.dim(`    ${line}`));
				}
			}
		}

		// Connect the chosen cloud provider now that the daemon is running (the
		// daemon owns the secrets store + OAuth endpoints, like the dashboard).
		if (plan.extractionConnect && context.connectExtraction) {
			spinner.text = `Connecting ${plan.extractionConnect.family}...`;
			const ok = await context.connectExtraction();
			if (ok) {
				console.log(chalk.green(`  ✓ Connected ${plan.extractionConnect.family}`));
			} else {
				console.log(
					chalk.yellow(
						`  ⚠ Could not connect ${plan.extractionConnect.family} now — finish connecting via the dashboard.`,
					),
				);
			}
		}

		console.log();
		if (committed) {
			console.log(chalk.dim("  ✓ Changes committed to git"));
		}

		if (context.nonInteractive) {
			if (context.openDashboard) {
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
		if (plan.identityMode === "managed") {
			console.log(chalk.cyan("  → Next step: Say '/onboarding' to personalize your agent"));
			console.log(chalk.dim("    This will walk you through setting up your agent's personality,"));
			console.log(chalk.dim("    communication style, and your preferences."));
		} else {
			console.log(chalk.cyan("  → Next step: Use `signet remember` or configure harness memory hooks"));
			console.log(chalk.dim("    Signet will manage memory, recall, sources, and secrets without owning identity."));
		}
		if (protection.state === "bypass") {
			console.log(chalk.red("    Backup warning: this workspace is still unprotected."));
		}
	} catch (err) {
		spinner.fail(chalk.red("Setup failed"));
		console.error(err);
		process.exit(1);
	}
}
