import { checkbox, confirm, input, select } from "@inquirer/prompts";
import { OpenClawConnector } from "@signet/connector-openclaw";
import {
	parseSimpleYaml,
	type SetupDetection,
} from "@signet/core";
import chalk from "chalk";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import open from "open";
import ora from "ora";
import { hasCommand, preflightOllamaEmbedding, promptOpenAIEmbeddingModel } from "./setup-providers.js";
import { runFreshSetup } from "./setup-fresh.js";
import {
	EMBEDDING_PROVIDER_CHOICES,
	EXTRACTION_PROVIDER_CHOICES,
	OPENCLAW_RUNTIME_CHOICES,
	SETUP_HARNESS_CHOICES,
	detectPreferredOpenClawWorkspace,
	failNonInteractiveSetup,
	formatDetectionSummary,
	getEmbeddingDimensions,
	hasExistingAgentState,
	hasExistingIdentityFiles,
	normalizeHarnessList,
	readHarnesses,
	readRecord,
	readString,
	type EmbeddingProviderChoice,
	type ExtractionProviderChoice,
	type HarnessChoice,
	type OpenClawRuntimeChoice,
} from "./setup-shared.js";
import { runExistingSetupWizard } from "./setup-migrate.js";
import type { SetupDeps, SetupWizardOptions } from "./setup-types.js";

export async function setupWizard(options: SetupWizardOptions, deps: SetupDeps): Promise<void> {
	console.log(deps.signetLogo());
	console.log();

	const nonInteractive = options.nonInteractive === true;
	const explicitPath = deps.normalizeStringValue(options.path);
	let basePath = deps.normalizeAgentPath(explicitPath ?? deps.AGENTS_DIR);

	if (!explicitPath) {
		const defaultDetection = deps.detectExistingSetup(basePath);
		if (!hasExistingAgentState(defaultDetection)) {
			const openClawWorkspace = detectPreferredOpenClawWorkspace(basePath, deps);
			if (openClawWorkspace) {
				if (nonInteractive) {
					basePath = openClawWorkspace;
				} else {
					console.log(chalk.cyan(`  Detected OpenClaw workspace: ${openClawWorkspace}`));
					const useDetectedWorkspace = await confirm({
						message: "Use this as the Signet agent directory?",
						default: true,
					});
					if (useDetectedWorkspace) {
						basePath = openClawWorkspace;
					}
					console.log();
				}
			}
		}
	}

	const existing = deps.detectExistingSetup(basePath);

	if (nonInteractive) {
		console.log(chalk.dim("  Running in non-interactive mode"));
		if (!explicitPath && basePath !== deps.AGENTS_DIR) {
			console.log(chalk.dim(`  Using detected OpenClaw workspace: ${basePath}`));
		}
		console.log();
	}

	let existingConfig: Record<string, unknown> = {};
	if (existing.agentYaml) {
		try {
			const yaml = readFileSync(join(basePath, "agent.yaml"), "utf-8");
			existingConfig = parseSimpleYaml(yaml);
		} catch {
			// Ignore
		}
	}

	const existingAgent = readRecord(existingConfig.agent);
	const existingEmbedding = readRecord(existingConfig.embedding);
	const existingSearch = readRecord(existingConfig.search);
	const existingMemory = readRecord(existingConfig.memory);
	const existingPipeline = readRecord(existingMemory.pipelineV2);
	const existingExtraction = readRecord(existingPipeline.extraction);
	const existingName = readString(existingConfig.name) ?? readString(existingAgent.name) ?? "My Agent";
	const existingDesc = readString(existingConfig.description) ?? readString(existingAgent.description) ?? "Personal AI assistant";
	const existingHarnesses = readHarnesses(existingConfig.harnesses);

	if (existing.agentsDir && existing.memoryDb) {
		console.log(chalk.green("  ✓ Existing Signet installation detected"));
		console.log(chalk.dim(`    ${basePath}`));
		console.log();

		if (nonInteractive) {
			const running = await deps.isDaemonRunning();
			if (!running) {
				const spinner = ora("Starting daemon...").start();
				const started = await deps.startDaemon(basePath);
				if (started) {
					spinner.succeed("Daemon started");
				} else {
					spinner.fail("Failed to start daemon");
				}
			}

			if (options.openDashboard === true) {
				await open(`http://localhost:${deps.DEFAULT_PORT}`);
			}

			return;
		}

		const action = await select({
			message: "What would you like to do?",
			choices: [
				{ value: "dashboard", name: "Launch dashboard" },
				{ value: "github-import", name: "Import agent config from GitHub" },
				{ value: "reconfigure", name: "Reconfigure settings" },
				{ value: "status", name: "View status" },
				{ value: "exit", name: "Exit" },
			],
		});

		if (action === "dashboard") {
			await deps.launchDashboard({ path: basePath });
			return;
		}

		if (action === "github-import") {
			await deps.importFromGitHub(basePath);
			return;
		}

		if (action === "status") {
			await deps.showStatus({ path: basePath });
			return;
		}

		if (action === "exit") {
			return;
		}

		const templatesDir = deps.getTemplatesDir();
		const gitignoreSrc = join(templatesDir, "gitignore.template");
		const gitignoreDest = join(basePath, ".gitignore");
		if (existsSync(gitignoreSrc) && !existsSync(gitignoreDest)) {
			copyFileSync(gitignoreSrc, gitignoreDest);
			console.log(chalk.dim("  Synced missing: .gitignore"));
		}

		const skillSyncResult = deps.syncBuiltinSkills(templatesDir, basePath);
		const syncedBuiltins = skillSyncResult.installed.length + skillSyncResult.updated.length;
		if (syncedBuiltins > 0) {
			console.log(chalk.dim(`  Synced built-in skills: ${syncedBuiltins}`));
		}
	} else if (hasExistingIdentityFiles(existing)) {
		console.log(chalk.cyan("  Detected existing agent identity"));
		console.log(chalk.dim(`    ${basePath}`));
		console.log();
		console.log(formatDetectionSummary(existing));
		console.log();

		console.log(chalk.bold("  Signet will:"));
		console.log(chalk.dim("    1. Create agent.yaml manifest pointing to your existing files"));
		console.log(chalk.dim("    2. Import memory logs to SQLite for search"));
		console.log(chalk.dim("    3. Sync built-in skills + unify external skill sources"));
		console.log(chalk.dim("    4. Install connectors for detected harnesses"));
		console.log(chalk.dim("    5. Keep all existing files unchanged"));
		console.log();

		if (nonInteractive) {
			const migrationEmbeddingProvider = deps.normalizeChoice(options.embeddingProvider, EMBEDDING_PROVIDER_CHOICES);
			const migrationExtractionProvider = deps.normalizeChoice(options.extractionProvider, EXTRACTION_PROVIDER_CHOICES);
			if (!migrationEmbeddingProvider) {
				failNonInteractiveSetup(
					"Non-interactive setup requires --embedding-provider (native, ollama, openai, or none).",
				);
			}
			if (!migrationExtractionProvider) {
				failNonInteractiveSetup(
					"Non-interactive setup requires --extraction-provider (claude-code, codex, ollama, opencode, openrouter, or none).",
				);
			}

			await runExistingSetupWizard(basePath, existing, existingConfig, deps, {
				nonInteractive: true,
				openDashboard: options.openDashboard === true,
				skipGit: options.skipGit === true,
				embeddingProvider: migrationEmbeddingProvider,
				embeddingModel: deps.normalizeStringValue(options.embeddingModel) || undefined,
				extractionProvider: migrationExtractionProvider,
				extractionModel: deps.normalizeStringValue(options.extractionModel) || undefined,
			});
			return;
		}

		const proceed = await confirm({
			message: "Proceed with Signet setup?",
			default: true,
		});

		if (!proceed) {
			console.log();
			const manualAction = await select({
				message: "What would you like to do instead?",
				choices: [
					{ value: "fresh", name: "Start fresh (create new identity)" },
					{ value: "github", name: "Import from GitHub repository" },
					{ value: "exit", name: "Exit" },
				],
			});

			if (manualAction === "exit") {
				return;
			}
			if (manualAction === "github") {
				mkdirSync(basePath, { recursive: true });
				mkdirSync(join(basePath, "memory"), { recursive: true });
				await deps.importFromGitHub(basePath);
				return;
			}
		} else {
			await runExistingSetupWizard(basePath, existing, existingConfig, deps);
			return;
		}
	} else {
		console.log(chalk.bold("  Let's set up your agent identity.\n"));

		const setupMethod = nonInteractive
			? "new"
			: await select({
					message: "How would you like to set up?",
					choices: [
						{ value: "new", name: "Create new agent identity" },
						{ value: "github", name: "Import from GitHub repository" },
					],
				});

		if (setupMethod === "github") {
			mkdirSync(basePath, { recursive: true });
			mkdirSync(join(basePath, "memory"), { recursive: true });
			await deps.importFromGitHub(basePath);
			return;
		}
		console.log();
	}

	const configuredName = deps.normalizeStringValue(options.name);
	const agentName = nonInteractive
		? configuredName || existingName
		: await input({
				message: "What should your agent be called?",
				default: existingName,
			});

	const harnessChoices = [
		{ value: "claude-code", name: "Claude Code (Anthropic CLI)", checked: existingHarnesses.includes("claude-code") },
		{ value: "codex", name: "Codex", checked: existingHarnesses.includes("codex") },
		{ value: "opencode", name: "OpenCode", checked: existingHarnesses.includes("opencode") },
		{ value: "openclaw", name: "OpenClaw", checked: existingHarnesses.includes("openclaw") },
	];

	let harnesses: string[] = [];
	if (nonInteractive) {
		const rawParts = (options.harness ?? []).flatMap((value) =>
			value
				.split(",")
				.map((part) => part.trim())
				.filter(Boolean),
		);
		const requestedHarnesses = normalizeHarnessList(options.harness, deps);

		if (rawParts.length > 0 && rawParts.length !== requestedHarnesses.length) {
			const unknown = rawParts.filter((part) => !deps.normalizeChoice(part, SETUP_HARNESS_CHOICES));
			failNonInteractiveSetup(
				`Unknown --harness value(s): ${unknown.join(", ")}. Valid choices: ${SETUP_HARNESS_CHOICES.join(", ")}.`,
			);
		}

		if (requestedHarnesses.length > 0) {
			harnesses = requestedHarnesses;
		} else {
			harnesses = normalizeHarnessList(existingHarnesses, deps);
		}
	} else {
		console.log();
		harnesses = await checkbox({
			message: "Which AI platforms do you use?",
			choices: harnessChoices,
		});
	}

	let configureOpenClawWs = false;
	let openclawRuntimePath: OpenClawRuntimeChoice = "plugin";
	if (harnesses.includes("openclaw")) {
		const connector = new OpenClawConnector();
		const existingConfigs = connector.getDiscoveredConfigPaths();

		if (nonInteractive) {
			configureOpenClawWs = options.configureOpenclawWorkspace === true && existingConfigs.length > 0;
			openclawRuntimePath = deps.normalizeChoice(options.openclawRuntimePath, OPENCLAW_RUNTIME_CHOICES) ?? "plugin";
		} else {
			if (existingConfigs.length > 0) {
				console.log();
				configureOpenClawWs = await confirm({
					message: `Set OpenClaw workspace to ${basePath} in ${existingConfigs.length} config file(s)?`,
					default: true,
				});
			}

			console.log();
			openclawRuntimePath = await select({
				message: "OpenClaw integration mode:",
				choices: [
					{
						value: "plugin",
						name: "Plugin adapter (recommended)",
						description: "@signetai/signet-memory-openclaw — full lifecycle + memory tools",
					},
					{
						value: "legacy",
						name: "Legacy hooks",
						description: "handler.js for /remember, /recall, /context commands",
					},
				],
				default: "plugin",
			});
		}
	}

	const configuredDescription = deps.normalizeStringValue(options.description);
	const agentDescription = nonInteractive
		? configuredDescription || existingDesc
		: await input({
				message: "Short description of your agent:",
				default: existingDesc,
			});

	const requestedEmbeddingProvider = deps.normalizeChoice(options.embeddingProvider, EMBEDDING_PROVIDER_CHOICES);
	const requestedExtractionProvider = deps.normalizeChoice(options.extractionProvider, EXTRACTION_PROVIDER_CHOICES);

	if (nonInteractive && !requestedEmbeddingProvider) {
		failNonInteractiveSetup("Non-interactive setup requires --embedding-provider (native, ollama, openai, or none).");
	}

	if (nonInteractive && !requestedExtractionProvider) {
		failNonInteractiveSetup(
			"Non-interactive setup requires --extraction-provider (claude-code, codex, ollama, opencode, openrouter, or none).",
		);
	}

	let embeddingProvider: EmbeddingProviderChoice;
	if (nonInteractive) {
		const providerFromConfig = deps.normalizeChoice(existingEmbedding.provider, EMBEDDING_PROVIDER_CHOICES);
		embeddingProvider = requestedEmbeddingProvider ?? providerFromConfig ?? "none";
	} else {
		console.log();
		embeddingProvider = await select({
			message: "How should memories be embedded for search?",
			choices: [
				{ value: "native", name: "Built-in (recommended, no setup required)" },
				{ value: "ollama", name: "Ollama (local, requires ollama install)" },
				{ value: "openai", name: "OpenAI API" },
				{ value: "none", name: "Skip embeddings for now" },
			],
		});
	}

	let embeddingModel = "nomic-embed-text";
	let embeddingDimensions = 768;

	if (embeddingProvider === "native") {
		embeddingModel = "nomic-embed-text-v1.5";
		embeddingDimensions = 768;
	} else if (embeddingProvider === "ollama") {
		if (nonInteractive) {
			const configuredModel =
				deps.normalizeStringValue(options.embeddingModel) || deps.normalizeStringValue(existingEmbedding.model) || "nomic-embed-text";
			embeddingModel = configuredModel;
			embeddingDimensions = getEmbeddingDimensions(configuredModel);
		} else {
			console.log();
			const model = await select({
				message: "Which embedding model?",
				choices: [
					{ value: "nomic-embed-text", name: "nomic-embed-text (768d, recommended)" },
					{ value: "all-minilm", name: "all-minilm (384d, faster)" },
					{ value: "mxbai-embed-large", name: "mxbai-embed-large (1024d, better quality)" },
				],
			});

			const preflight = await preflightOllamaEmbedding(model);
			embeddingProvider = preflight.provider;
			embeddingModel = preflight.model ?? embeddingModel;
			embeddingDimensions = preflight.dimensions ?? embeddingDimensions;
		}
	} else if (embeddingProvider === "openai") {
		if (nonInteractive) {
			const configuredModel =
				deps.normalizeChoice(options.embeddingModel, ["text-embedding-3-small", "text-embedding-3-large"]) ||
				deps.normalizeChoice(existingEmbedding.model, ["text-embedding-3-small", "text-embedding-3-large"]) ||
				"text-embedding-3-small";
			embeddingModel = configuredModel;
			embeddingDimensions = getEmbeddingDimensions(configuredModel);
		} else {
			const openaiModel = await promptOpenAIEmbeddingModel();
			embeddingModel = openaiModel.model;
			embeddingDimensions = openaiModel.dimensions;
		}
	}

	const existingSearchBalance = deps.parseSearchBalanceValue(existingSearch.alpha);
	const requestedSearchBalance = deps.parseSearchBalanceValue(options.searchBalance);
	const searchBalance = nonInteractive
		? requestedSearchBalance ?? existingSearchBalance ?? 0.7
		: await select({
				message: "Search style (semantic vs keyword matching):",
				choices: [
					{ value: 0.7, name: "Balanced (70% semantic, 30% keyword) - recommended" },
					{ value: 0.9, name: "Semantic-heavy (90% semantic, 10% keyword)" },
					{ value: 0.5, name: "Equal (50/50)" },
					{ value: 0.3, name: "Keyword-heavy (30% semantic, 70% keyword)" },
				],
			});

	const detectedProvider: ExtractionProviderChoice = hasCommand("claude")
		? "claude-code"
		: hasCommand("codex")
			? "codex"
			: hasCommand("opencode")
				? "opencode"
				: deps.normalizeStringValue(process.env.OPENROUTER_API_KEY)
					? "openrouter"
					: hasCommand("ollama")
						? "ollama"
						: "none";

	let extractionProvider: ExtractionProviderChoice;
	if (nonInteractive) {
		const providerFromConfig =
			deps.normalizeChoice(existingPipeline.extractionProvider, EXTRACTION_PROVIDER_CHOICES) ||
			deps.normalizeChoice(existingExtraction.provider, EXTRACTION_PROVIDER_CHOICES);
		extractionProvider = requestedExtractionProvider ?? providerFromConfig ?? detectedProvider;
	} else {
		console.log();
		const choices = [
			{
				value: "claude-code",
				name: `Claude Code (uses your Claude subscription via CLI)${detectedProvider === "claude-code" ? " — detected" : ""}`,
			},
			{
				value: "codex",
				name: `Codex (uses your OpenAI Codex CLI locally)${detectedProvider === "codex" ? " — detected" : ""}`,
			},
			{
				value: "opencode",
				name: `OpenCode (uses the OpenCode CLI or local server)${detectedProvider === "opencode" ? " — detected" : ""}`,
			},
			{
				value: "openrouter",
				name: `OpenRouter (cloud API, requires OPENROUTER_API_KEY)${detectedProvider === "openrouter" ? " — detected" : ""}`,
			},
			{
				value: "ollama",
				name: `Ollama (local, requires running Ollama server)${detectedProvider === "ollama" ? " — detected" : ""}`,
			},
			{ value: "none", name: "Skip extraction pipeline" },
		];
		extractionProvider = await select({
			message: "Memory extraction provider (analyzes conversations):",
			choices,
			default: detectedProvider,
		});
	}

	let extractionModel = "haiku";
	if (extractionProvider === "claude-code") {
		if (nonInteractive) {
			extractionModel =
				deps.normalizeStringValue(options.extractionModel) ||
				deps.normalizeStringValue(existingPipeline.extractionModel) ||
				deps.normalizeStringValue(existingExtraction.model) ||
				"haiku";
		} else {
			console.log();
			extractionModel = await select({
				message: "Which Claude model for extraction?",
				choices: [
					{ value: "haiku", name: "Haiku (fast, cheap, recommended)" },
					{ value: "sonnet", name: "Sonnet (better quality, slower)" },
				],
			});
		}
	} else if (extractionProvider === "codex") {
		if (nonInteractive) {
			extractionModel =
				deps.normalizeStringValue(options.extractionModel) ||
				deps.normalizeStringValue(existingPipeline.extractionModel) ||
				deps.normalizeStringValue(existingExtraction.model) ||
				"gpt-5.3-codex";
		} else {
			console.log();
			extractionModel = await select({
				message: "Which Codex model for extraction?",
				choices: [
					{ value: "gpt-5.3-codex", name: "gpt-5.3-codex (recommended)" },
					{ value: "gpt-5-codex", name: "gpt-5-codex (stable fallback)" },
					{ value: "gpt-5-codex-mini", name: "gpt-5-codex-mini (faster, lighter)" },
				],
			});
		}
	} else if (extractionProvider === "opencode") {
		if (nonInteractive) {
			extractionModel =
				deps.normalizeStringValue(options.extractionModel) ||
				deps.normalizeStringValue(existingPipeline.extractionModel) ||
				deps.normalizeStringValue(existingExtraction.model) ||
				"anthropic/claude-haiku-4-5-20251001";
		} else {
			console.log();
			extractionModel = await select({
				message: "Which model for OpenCode extraction? (provider/model format)",
				choices: [
					{ value: "anthropic/claude-haiku-4-5-20251001", name: "Claude Haiku (fast, cheap, recommended)" },
					{ value: "anthropic/claude-sonnet-4-5-20250514", name: "Claude Sonnet (better quality, slower)" },
					{ value: "google/gemini-2.5-flash", name: "Gemini 2.5 Flash (fast, multimodal)" },
				],
			});
		}
	} else if (extractionProvider === "openrouter") {
		if (nonInteractive) {
			extractionModel =
				deps.normalizeStringValue(options.extractionModel) ||
				deps.normalizeStringValue(existingPipeline.extractionModel) ||
				deps.normalizeStringValue(existingExtraction.model) ||
				"openai/gpt-4o-mini";
		} else {
			console.log();
			extractionModel = await select({
				message: "Which OpenRouter model for extraction? (provider/model format)",
				choices: [
					{ value: "openai/gpt-4o-mini", name: "openai/gpt-4o-mini (fast, recommended)" },
					{ value: "openai/gpt-4o", name: "openai/gpt-4o (higher quality)" },
					{ value: "anthropic/claude-sonnet-4-6", name: "anthropic/claude-sonnet-4-6 (high quality)" },
					{ value: "google/gemini-2.5-flash", name: "google/gemini-2.5-flash (balanced)" },
				],
			});
		}
	} else if (extractionProvider === "ollama") {
		if (nonInteractive) {
			extractionModel =
				deps.normalizeStringValue(options.extractionModel) ||
				deps.normalizeStringValue(existingPipeline.extractionModel) ||
				deps.normalizeStringValue(existingExtraction.model) ||
				"glm-4.7-flash";
		} else {
			console.log();
			extractionModel = await select({
				message: "Which Ollama model for extraction?",
				choices: [
					{ value: "glm-4.7-flash", name: "glm-4.7-flash (good quality, recommended)" },
					{ value: "qwen3:4b", name: "qwen3:4b (lighter, faster)" },
					{ value: "llama3", name: "llama3 (general purpose)" },
				],
			});
		}
	}

	const wantAdvanced = nonInteractive
		? false
		: await confirm({
				message: "Configure advanced settings?",
				default: false,
			});

	let searchTopK = deps.parseIntegerValue(existingSearch.top_k) ?? 20;
	let searchMinScore = deps.parseSearchBalanceValue(existingSearch.min_score) ?? 0.3;
	let memorySessionBudget = deps.parseIntegerValue(existingMemory.session_budget) ?? 2000;
	let memoryDecayRate = deps.parseSearchBalanceValue(existingMemory.decay_rate) ?? 0.95;

	if (wantAdvanced) {
		console.log();
		console.log(chalk.dim("  Advanced settings:\n"));

		const topKInput = await input({ message: "Search candidates per source (top_k):", default: "20" });
		searchTopK = Number.parseInt(topKInput, 10) || 20;

		const minScoreInput = await input({ message: "Minimum search score threshold (0-1):", default: "0.3" });
		searchMinScore = Number.parseFloat(minScoreInput) || 0.3;

		const budgetInput = await input({ message: "Session context budget (characters):", default: "2000" });
		memorySessionBudget = Number.parseInt(budgetInput, 10) || 2000;

		const decayInput = await input({ message: "Memory importance decay rate per day (0-1):", default: "0.95" });
		memoryDecayRate = Number.parseFloat(decayInput) || 0.95;
	}

	let gitEnabled = false;
	const shouldSkipGit = nonInteractive && options.skipGit === true;

	if (existing.agentsDir) {
		if (deps.isGitRepo(basePath)) {
			gitEnabled = true;
			console.log(chalk.dim("  Git repo detected. Will create backup commit before changes."));
		} else if (!shouldSkipGit) {
			const initGit = nonInteractive
				? true
				: await confirm({
						message: "Initialize git for version history?",
						default: true,
					});

			if (initGit) {
				const initialized = await deps.gitInit(basePath);
				if (initialized) {
					gitEnabled = true;
					console.log(chalk.dim("  ✓ Git initialized"));
				} else {
					console.log(chalk.yellow("  ⚠ Could not initialize git"));
				}
			}
		}
	} else if (!shouldSkipGit) {
		const initGit = nonInteractive
			? true
			: await confirm({
					message: "Initialize git for version history?",
					default: true,
				});
		gitEnabled = initGit;
	}

	const cfg: FreshSetupConfig = {
		basePath,
		agentName,
		agentDescription,
		harnesses,
		openclawRuntimePath,
		configureOpenClawWs,
		embeddingProvider,
		embeddingModel,
		embeddingDimensions,
		extractionProvider,
		extractionModel,
		searchBalance,
		searchTopK,
		searchMinScore,
		memorySessionBudget,
		memoryDecayRate,
		gitEnabled,
		existingAgentsDir: existing.agentsDir,
		nonInteractive,
		openDashboard: options.openDashboard === true,
	};

	await runFreshSetup(cfg, deps);
}
