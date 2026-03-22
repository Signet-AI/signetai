import { checkbox, confirm, input, select } from "@inquirer/prompts";
import { OpenClawConnector } from "@signet/connector-openclaw";
import {
	Database as CoreDatabase,
	ensureUnifiedSchema,
	formatYaml,
	importMemoryLogs,
	parseSimpleYaml,
	resolvePrimaryPackageManager,
	runMigrations,
	type ImportResult,
	type SetupDetection,
	type SkillsResult,
	unifySkills,
} from "@signet/core";
import chalk from "chalk";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import open from "open";
import ora from "ora";
import { spawn, spawnSync } from "node:child_process";
import Database from "../sqlite.js";

export interface SetupWizardOptions {
	path?: string;
	nonInteractive?: boolean;
	name?: string;
	description?: string;
	harness?: string[];
	embeddingProvider?: string;
	embeddingModel?: string;
	extractionProvider?: string;
	extractionModel?: string;
	searchBalance?: string;
	skipGit?: boolean;
	openDashboard?: boolean;
	openclawRuntimePath?: string;
	configureOpenclawWorkspace?: boolean;
}

type HarnessChoice = "claude-code" | "opencode" | "openclaw" | "codex";
type EmbeddingProviderChoice = "native" | "ollama" | "openai" | "none";
type ExtractionProviderChoice = "claude-code" | "ollama" | "opencode" | "codex" | "openrouter" | "none";
type OpenClawRuntimeChoice = "plugin" | "legacy";

const SETUP_HARNESS_CHOICES: readonly HarnessChoice[] = ["claude-code", "opencode", "openclaw", "codex"];
const EMBEDDING_PROVIDER_CHOICES: readonly EmbeddingProviderChoice[] = ["native", "ollama", "openai", "none"];
const EXTRACTION_PROVIDER_CHOICES: readonly ExtractionProviderChoice[] = [
	"claude-code",
	"ollama",
	"opencode",
	"codex",
	"openrouter",
	"none",
];
const OPENCLAW_RUNTIME_CHOICES: readonly OpenClawRuntimeChoice[] = ["plugin", "legacy"];

interface SetupDeps {
	readonly AGENTS_DIR: string;
	readonly DEFAULT_PORT: number;
	readonly configureHarnessHooks: (
		harness: string,
		basePath: string,
		options?: {
			configureOpenClawWorkspace?: boolean;
			openclawRuntimePath?: OpenClawRuntimeChoice;
		},
	) => Promise<void>;
	readonly copyDirRecursive: (src: string, dest: string) => void;
	readonly detectExistingSetup: (basePath: string) => SetupDetection;
	readonly gitAddAndCommit: (dir: string, message: string) => Promise<boolean>;
	readonly getTemplatesDir: () => string;
	readonly gitInit: (dir: string) => Promise<boolean>;
	readonly importFromGitHub: (basePath: string) => Promise<void>;
	readonly isDaemonRunning: () => Promise<boolean>;
	readonly isGitRepo: (dir: string) => boolean;
	readonly launchDashboard: (options: { path?: string }) => Promise<void>;
	readonly normalizeAgentPath: (pathValue: string) => string;
	readonly normalizeChoice: <T extends string>(value: unknown, allowed: readonly T[]) => T | null;
	readonly normalizeStringValue: (value: unknown) => string | null;
	readonly parseIntegerValue: (value: unknown) => number | null;
	readonly parseSearchBalanceValue: (value: unknown) => number | null;
	readonly showStatus: (options: { path?: string; json?: boolean }) => Promise<void>;
	readonly signetLogo: () => string;
	readonly startDaemon: (agentsDir?: string) => Promise<boolean>;
	readonly syncBuiltinSkills: (
		templatesDir: string,
		basePath: string,
	) => { installed: string[]; updated: string[]; skipped: string[] };
}

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
		console.log(chalk.dim("    1. Create AGENT.yaml manifest pointing to your existing files"));
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

			await existingSetupWizard(basePath, existing, existingConfig, deps, {
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
			await existingSetupWizard(basePath, existing, existingConfig, deps);
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

	console.log();
	const spinner = ora("Setting up Signet...").start();

	try {
		const templatesDir = deps.getTemplatesDir();
		mkdirSync(basePath, { recursive: true });

		const gitignoreSource = join(templatesDir, "gitignore.template");
		if (existsSync(gitignoreSource)) {
			copyFileSync(gitignoreSource, join(basePath, ".gitignore"));
		}

		if (gitEnabled && !deps.isGitRepo(basePath)) {
			spinner.text = "Initializing git...";
			await deps.gitInit(basePath);
		}

		if (gitEnabled && existing.agentsDir) {
			spinner.text = "Creating backup commit...";
			const date = new Date().toISOString().split("T")[0];
			await deps.gitAddAndCommit(basePath, `${date}_pre-signet-backup`);
		}

		mkdirSync(join(basePath, "memory", "scripts"), { recursive: true });
		mkdirSync(join(basePath, "harnesses"), { recursive: true });

		spinner.text = "Installing memory system...";
		const scriptsSource = join(templatesDir, "memory", "scripts");
		if (existsSync(scriptsSource)) {
			deps.copyDirRecursive(scriptsSource, join(basePath, "memory", "scripts"));
		}

		const requirementsSource = join(templatesDir, "memory", "requirements.txt");
		if (existsSync(requirementsSource)) {
			copyFileSync(requirementsSource, join(basePath, "memory", "requirements.txt"));
		}

		const utilScriptsSource = join(templatesDir, "scripts");
		if (existsSync(utilScriptsSource)) {
			mkdirSync(join(basePath, "scripts"), { recursive: true });
			deps.copyDirRecursive(utilScriptsSource, join(basePath, "scripts"));
		}

		spinner.text = "Installing built-in skills...";
		deps.syncBuiltinSkills(templatesDir, basePath);

		spinner.text = "Creating agent identity...";
		const agentsTemplate = join(templatesDir, "AGENTS.md.template");
		let agentsMd: string;
		if (existsSync(agentsTemplate)) {
			agentsMd = readFileSync(agentsTemplate, "utf-8").replace(/\{\{AGENT_NAME\}\}/g, agentName);
		} else {
			agentsMd = `# ${agentName}\n\nThis is your agent identity file. Define your agent's personality, capabilities,\nand behaviors here. This file is shared across all your AI tools.\n\n## Personality\n\n${agentName} is a helpful assistant.\n\n## Instructions\n\n- Be concise and direct\n- Ask clarifying questions when needed\n- Remember user preferences\n`;
		}
		writeFileSync(join(basePath, "AGENTS.md"), agentsMd);

		spinner.text = "Writing configuration...";
		const now = new Date().toISOString();
		const packageManager = resolvePrimaryPackageManager({ agentsDir: basePath, env: process.env });
		const config: Record<string, unknown> = {
			version: 1,
			schema: "signet/v1",
			agent: {
				name: agentName,
				description: agentDescription,
				created: now,
				updated: now,
			},
			harnesses,
			install: {
				primary_package_manager: packageManager.family,
				source: packageManager.source,
			},
			memory: {
				database: "memory/memories.db",
				session_budget: memorySessionBudget,
				decay_rate: memoryDecayRate,
			},
			search: {
				alpha: searchBalance,
				top_k: searchTopK,
				min_score: searchMinScore,
			},
		};

		if (embeddingProvider !== "none") {
			config.embedding = {
				provider: embeddingProvider,
				model: embeddingModel,
				dimensions: embeddingDimensions,
			};
		}

		if (extractionProvider !== "none") {
			const memory = readRecord(config.memory);
			memory.pipelineV2 = {
				enabled: true,
				extraction: {
					provider: extractionProvider,
					model: extractionModel,
				},
				semanticContradictionEnabled: true,
				graph: { enabled: true },
				reranker: { enabled: true },
				autonomous: {
					enabled: true,
					allowUpdateDelete: true,
					maintenanceMode: "execute",
				},
				predictor: { enabled: true },
				predictorPipeline: { agentFeedback: true, trainingTelemetry: false },
			};
			config.memory = memory;
		}

		writeFileSync(join(basePath, "agent.yaml"), formatYaml(config));

		const docFiles = [
			{ name: "MEMORY.md", template: "MEMORY.md.template" },
			{ name: "SOUL.md", template: "SOUL.md.template" },
			{ name: "IDENTITY.md", template: "IDENTITY.md.template" },
			{ name: "USER.md", template: "USER.md.template" },
		];

		for (const doc of docFiles) {
			const templatePath = join(templatesDir, doc.template);
			const destPath = join(basePath, doc.name);
			if (existsSync(destPath)) {
				continue;
			}
			if (existsSync(templatePath)) {
				const content = readFileSync(templatePath, "utf-8").replace(/\{\{AGENT_NAME\}\}/g, agentName);
				writeFileSync(destPath, content);
			}
		}

		spinner.text = "Initializing database...";
		const dbPath = join(basePath, "memory", "memories.db");
		const db = Database(dbPath);
		ensureUnifiedSchema(db);
		runMigrations(db);
		db.close();

		spinner.text = "Configuring harness hooks...";
		const configuredHarnesses: string[] = [];
		for (const harness of harnesses) {
			try {
				await deps.configureHarnessHooks(harness, basePath, { openclawRuntimePath });
				configuredHarnesses.push(harness);
			} catch (err) {
				console.warn(`\n  ⚠ Could not configure ${harness}: ${readErr(err)}`);
			}
		}

		if (configureOpenClawWs) {
			spinner.text = "Configuring OpenClaw workspace...";
			const patched = await new OpenClawConnector().configureWorkspace(basePath);
			if (patched.length > 0) {
				console.log(chalk.dim(`\n  ✓ OpenClaw workspace set to ${basePath}`));
			}
		}

		spinner.text = "Starting daemon...";
		const daemonStarted = await deps.startDaemon(basePath);

		spinner.succeed(chalk.green("Signet initialized!"));

		console.log();
		console.log(chalk.dim("  Files created:"));
		console.log(chalk.dim(`    ${basePath}/`));
		console.log(chalk.dim("    ├── agent.yaml    manifest & config"));
		console.log(chalk.dim("    ├── AGENTS.md     agent instructions"));
		console.log(chalk.dim("    ├── SOUL.md       personality & tone"));
		console.log(chalk.dim("    ├── IDENTITY.md   agent identity"));
		console.log(chalk.dim("    ├── USER.md       your profile"));
		console.log(chalk.dim("    ├── MEMORY.md     working memory"));
		console.log(chalk.dim("    └── memory/       database & vectors"));

		if (configuredHarnesses.length > 0) {
			console.log();
			console.log(chalk.dim("  Hooks configured for:"));
			for (const harness of configuredHarnesses) {
				console.log(chalk.dim(`    ✓ ${harness}`));
			}
		}

		if (daemonStarted) {
			console.log();
			console.log(chalk.green(`  ● Daemon running at http://localhost:${deps.DEFAULT_PORT}`));
		}

		console.log();
		if (gitEnabled) {
			const date = new Date().toISOString().split("T")[0];
			const committed = await deps.gitAddAndCommit(basePath, `${date}_signet-setup`);
			if (committed) {
				console.log(chalk.dim("  ✓ Changes committed to git"));
			}
		}

		if (nonInteractive) {
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
	} catch (err) {
		spinner.fail(chalk.red("Setup failed"));
		console.error(err);
		process.exit(1);
	}
}

async function existingSetupWizard(
	basePath: string,
	detection: SetupDetection,
	existingConfig: Record<string, unknown>,
	deps: SetupDeps,
	options?: {
		nonInteractive?: boolean;
		openDashboard?: boolean;
		skipGit?: boolean;
		embeddingProvider?: EmbeddingProviderChoice;
		embeddingModel?: string;
		extractionProvider?: ExtractionProviderChoice;
		extractionModel?: string;
	},
): Promise<void> {
	const spinner = ora("Setting up Signet for existing identity...").start();

	try {
		const templatesDir = deps.getTemplatesDir();

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
		const packageManager = resolvePrimaryPackageManager({ agentsDir: basePath, env: process.env });
		const existingAgent = readRecord(existingConfig.agent);

		const config: Record<string, unknown> = {
			version: 1,
			schema: "signet/v1",
			agent: {
				name: agentName,
				description: readString(existingConfig.description) ?? readString(existingAgent.description) ?? "Personal AI assistant",
				created: now,
				updated: now,
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
			const model = options.embeddingModel || (options.embeddingProvider === "openai" ? "text-embedding-3-small" : "nomic-embed-text");
			config.embedding = {
				provider: options.embeddingProvider,
				model,
				dimensions: getEmbeddingDimensions(model),
			};
		}

		if (options?.extractionProvider && options.extractionProvider !== "none") {
			const memory = readRecord(config.memory);
			memory.pipelineV2 = {
				enabled: true,
				extraction: {
					provider: options.extractionProvider,
					model:
						options.extractionModel ||
						(options.extractionProvider === "claude-code"
							? "haiku"
							: options.extractionProvider === "codex"
								? "gpt-5.3-codex"
								: options.extractionProvider === "opencode"
									? "anthropic/claude-haiku-4-5-20251001"
									: options.extractionProvider === "openrouter"
										? "openai/gpt-4o-mini"
										: "glm-4.7-flash"),
				},
				semanticContradictionEnabled: true,
				graph: { enabled: true },
				reranker: { enabled: true },
				autonomous: { enabled: true, allowUpdateDelete: true },
				predictor: { enabled: true },
				predictorPipeline: { agentFeedback: true, trainingTelemetry: false },
			};
			config.memory = memory;
		}

		if (!existsSync(join(basePath, "agent.yaml"))) {
			writeFileSync(join(basePath, "agent.yaml"), formatYaml(config));
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

		let importResult: ImportResult | null = null;
		if (detection.hasMemoryDir && detection.memoryLogCount > 0) {
			spinner.text = `Importing ${detection.memoryLogCount} memory logs...`;
			try {
				const coreDb = new CoreDatabase(dbPath);
				importResult = importMemoryLogs(basePath, coreDb);
				coreDb.close();
			} catch (err) {
				console.warn(`\n  ⚠ Memory import warning: ${readErr(err)}`);
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
			console.log(chalk.dim(`  Skills unified: ${skillsResult.imported} imported, ${skillsResult.symlinked} symlinked`));
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
			console.log(chalk.green(`  ● Daemon running at http://localhost:${deps.DEFAULT_PORT}`));
		}

		if (options?.skipGit !== true && gitEnabled) {
			const date = new Date().toISOString().split("T")[0];
			const committed = await deps.gitAddAndCommit(basePath, `${date}_signet-setup`);
			if (committed) {
				console.log(chalk.dim("  ✓ Changes committed to git"));
			}
		}

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
	} catch (err) {
		spinner.fail(chalk.red("Setup failed"));
		console.error(err);
		process.exit(1);
	}
}

function hasExistingIdentityFiles(detection: SetupDetection): boolean {
	return detection.identityFiles.length > 0;
}

function formatDetectionSummary(detection: SetupDetection): string {
	const lines = ["  Found:"];
	for (const file of detection.identityFiles) {
		lines.push(`    ✓ ${file}`);
	}
	if (detection.hasMemoryDir) {
		lines.push(`    ✓ memory/ (${detection.memoryLogCount} daily logs)`);
	}
	const harnesses = [];
	if (detection.harnesses.claudeCode) harnesses.push("Claude Code");
	if (detection.harnesses.openclaw) harnesses.push("OpenClaw");
	if (detection.harnesses.opencode) harnesses.push("OpenCode");
	if (detection.harnesses.codex) harnesses.push("Codex");
	if (harnesses.length > 0) {
		lines.push(`    ✓ Harnesses: ${harnesses.join(", ")}`);
	}
	return lines.join("\n");
}

function hasExistingAgentState(detection: SetupDetection): boolean {
	return detection.memoryDb || detection.agentYaml || detection.identityFiles.length > 0;
}

function scoreOpenClawWorkspace(pathValue: string, deps: SetupDeps): number {
	const detection = deps.detectExistingSetup(pathValue);
	let score = 0;
	if (detection.memoryDb) score += 100;
	if (detection.agentYaml) score += 60;
	if (detection.identityFiles.length >= 2) score += 40;
	if (detection.agentsDir) score += 10;
	return score;
}

function detectPreferredOpenClawWorkspace(defaultPath: string, deps: SetupDeps): string | null {
	const connector = new OpenClawConnector();
	const normalizedDefault = deps.normalizeAgentPath(defaultPath);
	const discovered = connector
		.getDiscoveredWorkspacePaths()
		.map((workspacePath) => deps.normalizeAgentPath(workspacePath))
		.filter((workspacePath) => workspacePath !== normalizedDefault);

	if (discovered.length === 0) {
		return null;
	}

	const unique = [...new Set(discovered)];
	const ranked = unique
		.map((workspacePath) => ({ workspacePath, score: scoreOpenClawWorkspace(workspacePath, deps) }))
		.sort((a, b) => b.score - a.score);

	if (ranked[0].score > 0) {
		return ranked[0].workspacePath;
	}

	return ranked.length === 1 ? ranked[0].workspacePath : null;
}

function normalizeHarnessList(rawValues: readonly string[] | undefined, deps: SetupDeps): HarnessChoice[] {
	if (!rawValues || rawValues.length === 0) {
		return [];
	}

	const harnesses: HarnessChoice[] = [];
	for (const rawValue of rawValues) {
		const parts = rawValue
			.split(",")
			.map((part) => part.trim())
			.filter((part) => part.length > 0);

		for (const part of parts) {
			const harness = deps.normalizeChoice(part, SETUP_HARNESS_CHOICES);
			if (harness && !harnesses.includes(harness)) {
				harnesses.push(harness);
			}
		}
	}

	return harnesses;
}

function failNonInteractiveSetup(message: string): never {
	console.error(chalk.red(`  ${message}`));
	console.error(chalk.dim("  Ask the user for explicit provider choices and pass them as CLI flags."));
	process.exit(1);
}

function getEmbeddingDimensions(model: string): number {
	switch (model) {
		case "all-minilm":
			return 384;
		case "mxbai-embed-large":
			return 1024;
		case "text-embedding-3-large":
			return 3072;
		case "text-embedding-3-small":
			return 1536;
		default:
			return 768;
	}
}

async function promptOpenAIEmbeddingModel(): Promise<{ provider: "openai"; model: string; dimensions: number }> {
	console.log();
	const model = await select({
		message: "Which embedding model?",
		choices: [
			{ value: "text-embedding-3-small", name: "text-embedding-3-small (1536d, cheaper)" },
			{ value: "text-embedding-3-large", name: "text-embedding-3-large (3072d, better)" },
		],
	});

	return { provider: "openai", model, dimensions: getEmbeddingDimensions(model) };
}

async function runCommandWithOutput(
	command: string,
	args: string[],
	options?: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number },
): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		const proc = spawn(command, args, {
			cwd: options?.cwd,
			env: options?.env,
			timeout: options?.timeout,
			windowsHide: true,
		});

		let stdout = "";
		let stderr = "";

		proc.stdout?.on("data", (data: Buffer) => {
			stdout += data.toString();
		});
		proc.stderr?.on("data", (data: Buffer) => {
			stderr += data.toString();
		});

		proc.on("close", (code) => {
			resolve({ code: code ?? 1, stdout, stderr });
		});
		proc.on("error", (err) => {
			resolve({ code: 1, stdout, stderr: err.message });
		});
	});
}

function hasCommand(command: string): boolean {
	try {
		const result = spawnSync(command, ["--version"], { stdio: "ignore", windowsHide: true });
		return result.status === 0;
	} catch {
		return false;
	}
}

function printOllamaInstallInstructions(): void {
	console.log(chalk.dim("  Install Ollama:"));
	if (platform() === "darwin") {
		console.log(chalk.dim("    brew install ollama"));
		console.log(chalk.dim("    open -a Ollama"));
		return;
	}
	if (platform() === "linux") {
		console.log(chalk.dim("    curl -fsSL https://ollama.com/install.sh | sh"));
		console.log(chalk.dim("    ollama serve"));
		return;
	}
	console.log(chalk.dim("    https://ollama.com/download"));
}

async function offerOllamaInstallFlow(): Promise<boolean> {
	const installNow = await confirm({ message: "Ollama is not installed. Try to install it now?", default: true });
	if (!installNow) {
		printOllamaInstallInstructions();
		return false;
	}

	if (platform() === "darwin") {
		if (!hasCommand("brew")) {
			console.log(chalk.yellow("  Homebrew not found, cannot auto-install."));
			printOllamaInstallInstructions();
			return false;
		}

		const spinner = ora("Installing Ollama with Homebrew...").start();
		const result = await runCommandWithOutput("brew", ["install", "ollama"], {
			env: { ...process.env },
			timeout: 300000,
		});
		if (result.code !== 0) {
			spinner.fail("Ollama install failed");
			if (result.stderr.trim()) {
				console.log(chalk.dim(`  ${result.stderr.trim()}`));
			}
			printOllamaInstallInstructions();
			return false;
		}
		spinner.succeed("Ollama installed");
		return hasCommand("ollama");
	}

	if (platform() === "linux") {
		const spinner = ora("Installing Ollama...").start();
		const result = await runCommandWithOutput("sh", ["-c", "curl -fsSL https://ollama.com/install.sh | sh"], {
			env: { ...process.env },
			timeout: 300000,
		});
		if (result.code !== 0) {
			spinner.fail("Ollama install failed");
			if (result.stderr.trim()) {
				console.log(chalk.dim(`  ${result.stderr.trim()}`));
			}
			printOllamaInstallInstructions();
			return false;
		}
		spinner.succeed("Ollama installed");
		return hasCommand("ollama");
	}

	console.log(chalk.yellow("  Automated install is not available on this platform."));
	printOllamaInstallInstructions();
	return false;
}

async function queryOllamaModels(baseUrl = "http://localhost:11434"): Promise<{ available: boolean; models: string[]; error?: string }> {
	try {
		const response = await fetch(`${baseUrl.replace(/\/$/, "")}/api/tags`, {
			signal: AbortSignal.timeout(5000),
		});
		if (!response.ok) {
			return { available: false, models: [], error: `Ollama returned ${response.status}` };
		}

		const data = (await response.json()) as { models?: Array<{ name?: string }> };
		const models = (data.models ?? []).map((model) => model.name?.trim()).filter((model): model is string => Boolean(model));
		return { available: true, models };
	} catch (err) {
		return { available: false, models: [], error: readErr(err) };
	}
}

function hasOllamaModel(models: string[], model: string): boolean {
	return models.some((entry) => entry === model || entry.startsWith(`${model}:`));
}

async function pullOllamaModel(model: string): Promise<boolean> {
	const spinner = ora(`Pulling ${model}...`).start();
	const result = await runCommandWithOutput("ollama", ["pull", model], {
		env: { ...process.env },
		timeout: 600000,
	});
	if (result.code !== 0) {
		spinner.fail(`Failed to pull ${model}`);
		if (result.stderr.trim()) {
			console.log(chalk.dim(`  ${result.stderr.trim()}`));
		}
		return false;
	}
	spinner.succeed(`Model ${model} is ready`);
	return true;
}

async function promptOllamaFailureFallback(): Promise<"retry" | "native" | "openai" | "none"> {
	console.log();
	return select({
		message: "How do you want to continue?",
		choices: [
			{ value: "native", name: "Use built-in embeddings (recommended)" },
			{ value: "retry", name: "Retry Ollama checks" },
			{ value: "openai", name: "Switch to OpenAI" },
			{ value: "none", name: "Continue without embeddings" },
		],
	});
}

async function preflightOllamaEmbedding(model: string): Promise<{
	provider: "native" | "ollama" | "openai" | "none";
	model?: string;
	dimensions?: number;
}> {
	while (true) {
		if (!hasCommand("ollama")) {
			console.log(chalk.yellow("  Ollama is not installed."));
			const installed = await offerOllamaInstallFlow();
			if (!installed) {
				const fallback = await promptOllamaFailureFallback();
				if (fallback === "retry") continue;
				if (fallback === "native") {
					return { provider: "native", model: "nomic-embed-text-v1.5", dimensions: 768 };
				}
				if (fallback === "openai") {
					return promptOpenAIEmbeddingModel();
				}
				return { provider: "none" };
			}
		}

		const service = await queryOllamaModels();
		if (!service.available) {
			console.log(chalk.yellow("  Ollama is installed but not reachable."));
			if (service.error) console.log(chalk.dim(`  ${service.error}`));
			console.log(chalk.dim("  Start Ollama with: ollama serve"));

			const fallback = await promptOllamaFailureFallback();
			if (fallback === "retry") continue;
			if (fallback === "native") {
				return { provider: "native", model: "nomic-embed-text-v1.5", dimensions: 768 };
			}
			if (fallback === "openai") {
				return promptOpenAIEmbeddingModel();
			}
			return { provider: "none" };
		}

		if (!hasOllamaModel(service.models, model)) {
			console.log(chalk.yellow(`  Model '${model}' is not installed.`));
			const pullNow = await confirm({
				message: `Pull '${model}' now with ollama pull ${model}?`,
				default: true,
			});

			if (pullNow) {
				const pulled = await pullOllamaModel(model);
				if (pulled) {
					continue;
				}
			}

			const fallback = await promptOllamaFailureFallback();
			if (fallback === "retry") continue;
			if (fallback === "native") {
				return { provider: "native", model: "nomic-embed-text-v1.5", dimensions: 768 };
			}
			if (fallback === "openai") {
				return promptOpenAIEmbeddingModel();
			}
			return { provider: "none" };
		}

		return { provider: "ollama", model, dimensions: getEmbeddingDimensions(model) };
	}
}

function readErr(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function readRecord(value: unknown): Record<string, unknown> {
	return isRecord(value) ? value : {};
}

function readString(value: unknown): string | null {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readHarnesses(value: unknown): string[] {
	if (Array.isArray(value)) {
		return value.flatMap((entry) => (typeof entry === "string" && entry.trim().length > 0 ? [entry.trim()] : []));
	}
	if (typeof value === "string") {
		return value
			.split(",")
			.map((entry) => entry.trim())
			.filter((entry) => entry.length > 0);
	}
	return [];
}
