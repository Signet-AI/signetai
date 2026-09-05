import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OpenClawConnector } from "@signet/connector-openclaw";
import {
	IDENTITY_MODES,
	IDENTITY_PRESETS,
	type IdentityContextFileEntry,
	type IdentityMode,
	type IdentityPresetName,
	type IdentitySpecialFileEntry,
	NETWORK_MODES,
	type NetworkMode,
	disableGraphiqState,
	formatYaml,
	parseSimpleYaml,
	readNetworkMode,
	resolveIdentityModeFromConfig,
} from "@signet/core";
import chalk from "chalk";
import ora from "ora";
import { validateName } from "../commands/agent.js";
import { createDaemonClient } from "../lib/daemon.js";
import { openUrlWithFallback } from "../lib/open-url.js";
import { installGraphiqPlugin } from "./graphiq.js";
import { runFreshSetup } from "./setup-fresh.js";
import { aggregateRecallProviderIds } from "./setup-inference-connect.js";
import { runExistingSetupWizard } from "./setup-migrate.js";
import { defaultAcpxModel, defaultExtractionModel } from "./setup-pipeline.js";
import { isBareDaemonOrigin, parseSetupPlan, setupPlanJsonSchema } from "./setup-plan.js";
import type { SetupApplyContext, SetupPlan } from "./setup-plan.js";
import { readSetupCorePluginEnabled, writeSetupCorePluginRegistry } from "./setup-plugins.js";
import { enforceSetupProtection, printSetupProtectionSummary } from "./setup-protection.js";
import {
	hasCommand,
	hasLlamaCppServer,
	resolveCommandPath,
	validateOllamaModelNonInteractive,
} from "./setup-providers.js";
import {
	DEPLOYMENT_TYPE_CHOICES,
	type DeploymentTypeChoice,
	EMBEDDING_PROVIDER_CHOICES,
	EXTRACTION_PROVIDER_CHOICES,
	type EmbeddingProviderChoice,
	type ExtractionProviderChoice,
	type HarnessChoice,
	OPENCLAW_RUNTIME_CHOICES,
	type OpenClawRuntimeChoice,
	SETUP_HARNESS_CHOICES,
	defaultEmbeddingProviderForDeployment,
	detectExtractionProviderFromAvailable,
	detectPreferredOpenClawWorkspace,
	failNonInteractiveSetup,
	failSetupValidation,
	findUnknownHarnessValues,
	formatDetectionSummary,
	getEmbeddingDimensions,
	hasExistingAgentState,
	hasExistingIdentityFiles,
	normalizeHarnessList,
	readErr,
	readHarnesses,
	readRecord,
	readString,
	resolveSetupExtractionProvider,
} from "./setup-shared.js";
import type { SetupDeps, SetupWizardOptions } from "./setup-types.js";

const DEFAULT_OPENAI_COMPATIBLE_ENDPOINT = "http://127.0.0.1:1234/v1";

function normalizeHttpEndpoint(value: string | null | undefined): string | undefined {
	if (!value) return undefined;
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	try {
		const parsed = new URL(trimmed);
		return parsed.protocol === "http:" || parsed.protocol === "https:" ? trimmed : undefined;
	} catch {
		return undefined;
	}
}

function normalizeDaemonOrigin(value: string | null | undefined): string | undefined {
	const endpoint = normalizeHttpEndpoint(value);
	return endpoint && isBareDaemonOrigin(endpoint) ? endpoint : undefined;
}

function resolveSetupExtractionEndpoint(options: {
	readonly provider: ExtractionProviderChoice;
	readonly requestedEndpoint?: string;
	readonly existingProvider?: ExtractionProviderChoice | null;
	readonly existingEndpoint?: string | null;
}): string | undefined {
	if (options.requestedEndpoint) return options.requestedEndpoint;
	if (options.provider === options.existingProvider && options.existingEndpoint) return options.existingEndpoint;
	if (options.provider === "openai-compatible") return DEFAULT_OPENAI_COMPATIBLE_ENDPOINT;
	return undefined;
}

const IDENTITY_PRESET_CHOICES = ["minimal", "hermes", "openclaw", "custom"] as const;
const IDENTITY_MODE_CHOICES = IDENTITY_MODES;

function cloneStartupFiles(preset: IdentityPresetName): IdentityContextFileEntry[] {
	return IDENTITY_PRESETS[preset].startup.map((entry) => ({ ...entry }));
}

function cloneSpecialFiles(preset: IdentityPresetName): IdentitySpecialFileEntry[] {
	return IDENTITY_PRESETS[preset].special.map((entry) => ({ ...entry }));
}

function writeCapabilitySelection(
	basePath: string,
	existingConfig: Record<string, unknown>,
	identityMode: IdentityMode,
	signetSecretsEnabled: boolean,
): void {
	const existingCapabilities = readRecord(existingConfig.capabilities);
	writeFileSync(
		join(basePath, "agent.yaml"),
		formatYaml({
			...existingConfig,
			capabilities: {
				...existingCapabilities,
				memory: { ...readRecord(existingCapabilities.memory), enabled: true, autoInject: true, memoryHead: true },
				secrets: { ...readRecord(existingCapabilities.secrets), enabled: signetSecretsEnabled },
				identity: { ...readRecord(existingCapabilities.identity), mode: identityMode },
			},
		}),
	);
}

/**
 * Scaffold minimal identity files when switching from off to managed.
 * Only creates files that do not already exist.
 */
function scaffoldIdentityIfNeeded(basePath: string, identityMode: IdentityMode, previousMode: IdentityMode): void {
	if (identityMode !== "managed" || previousMode === "managed") return;
	const requiredFiles: Record<string, string> = {
		"AGENTS.md": "# Agent Instructions\n\nYour agent instructions live here. Run `/onboarding` for a guided setup.\n",
		"SOUL.md": "# Soul\n\nYour agent's persona and character live here.\n",
		"IDENTITY.md": "# Identity\n\nYour agent's name and vibe live here.\n",
		"USER.md": "# About Your User\n\nYour preferences and profile live here.\n",
	};
	for (const [name, content] of Object.entries(requiredFiles)) {
		const filePath = join(basePath, name);
		if (!existsSync(filePath)) {
			writeFileSync(filePath, content);
		}
	}
}

interface ExtractionEnvironment {
	readonly availableExtractionProviders: ExtractionProviderChoice[];
	readonly acpxBin: string | undefined;
	readonly detectedProvider: ExtractionProviderChoice;
	readonly llamaCppServerAvailable: boolean;
}

/**
 * Parse a non-interactive --agent flag: "name:policy" or "name:policy:group".
 * policy is isolated|shared|group. Fails loudly on malformed input rather than
 * silently dropping it.
 */
function parseAgentFlag(raw: string): {
	name: string;
	memoryPolicy: "isolated" | "shared" | "group";
	memoryGroup?: string;
} {
	const parts = raw
		.split(":")
		.map((p) => p.trim())
		.filter(Boolean);
	if (parts.length < 2) {
		failSetupValidation(
			`Invalid --agent value: "${raw}". Expected name:policy[:group] (policy: isolated|shared|group).`,
		);
	}
	const [name, policyRaw, group] = parts;
	const nameErr = validateName(name);
	if (nameErr) {
		failSetupValidation(`Invalid --agent name "${name}": ${nameErr}`);
	}
	if (policyRaw !== "isolated" && policyRaw !== "shared" && policyRaw !== "group") {
		failSetupValidation(`Invalid --agent policy "${policyRaw}" in "${raw}". Expected isolated|shared|group.`);
	}
	if (policyRaw === "group" && !group) {
		failSetupValidation(`--agent "${name}:group" requires a group name: "${name}:group:<group>".`);
	}
	return { name, memoryPolicy: policyRaw, memoryGroup: group || undefined };
}

/**
 * Probe the local machine for extraction-capable tools (claude/codex/ollama/
 * opencode CLIs, llama.cpp server, acpx runner). Shared by the interactive
 * wizard and the headless plan path so detection never diverges.
 */
async function probeExtractionEnvironment(): Promise<ExtractionEnvironment> {
	const hasClaudeCommand = hasCommand("claude");
	const hasCodexCommand = hasCommand("codex");
	const hasOllamaCommand = hasCommand("ollama");
	const hasOpenCodeCommand = hasCommand("opencode");
	const hasKimiCommand = hasCommand("kimi");
	const acpxBin = resolveCommandPath("bunx") ?? resolveCommandPath("npx");
	const llamaCppServerAvailable = await hasLlamaCppServer();
	const availableExtractionProviders: ExtractionProviderChoice[] = [];
	if (acpxBin && (hasClaudeCommand || hasCodexCommand || hasOpenCodeCommand || hasKimiCommand))
		availableExtractionProviders.push("acpx");
	if (llamaCppServerAvailable) availableExtractionProviders.push("llama-cpp");
	if (hasClaudeCommand) availableExtractionProviders.push("claude-code");
	if (hasCodexCommand) availableExtractionProviders.push("codex");
	if (hasOllamaCommand) availableExtractionProviders.push("ollama");
	if (hasOpenCodeCommand) availableExtractionProviders.push("opencode");
	const detectedProvider = detectExtractionProviderFromAvailable(availableExtractionProviders);
	return { availableExtractionProviders, acpxBin, detectedProvider, llamaCppServerAvailable };
}

/**
 * Load and validate a {@link SetupPlan} from `--file` or `--json`. Headless only —
 * the returned plan carries no runtime context, which is built separately by
 * {@link buildHeadlessApplyContext}.
 */
function loadPlanFromOptions(options: SetupWizardOptions): SetupPlan {
	if (options.file && options.json) {
		failSetupValidation("Pass either --file or --json, not both.");
	}
	let raw: string;
	if (options.file) {
		try {
			raw = readFileSync(options.file, "utf-8");
		} catch (err) {
			failSetupValidation(`Could not read plan file ${options.file}: ${readErr(err)}`);
		}
	} else {
		raw = options.json ?? "";
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		failSetupValidation(`Setup plan is not valid JSON: ${readErr(err)}`);
	}
	try {
		return parseSetupPlan(parsed);
	} catch (err) {
		failSetupValidation(err instanceof Error ? err.message : String(err));
	}
}

/**
 * Build the runtime {@link SetupApplyContext} for a headless plan by probing the
 * environment (tool detection, OpenClaw configs) the same way the wizard does.
 */
async function buildHeadlessApplyContext(
	options: SetupWizardOptions,
	basePath: string,
	plan: SetupPlan,
	_deps: SetupDeps,
	existingAgentsDir: boolean,
): Promise<SetupApplyContext> {
	const { availableExtractionProviders, acpxBin } = await probeExtractionEnvironment();
	let openclawConfigCount = 0;
	if (plan.harnesses.includes("openclaw")) {
		openclawConfigCount = new OpenClawConnector().getDiscoveredConfigPaths().length;
	}
	return {
		basePath,
		existingAgentsDir,
		nonInteractive: true,
		allowUnprotectedWorkspace: options.allowUnprotectedWorkspace === true,
		createLocalBackup: options.createLocalBackup === true,
		availableExtractionProviders,
		acpxBin,
		openclawConfigCount,
		openDashboard: options.openDashboard === true,
	};
}

/** Interactive setup boots the workspace; the dashboard owns provider connection. */
export async function setupWizard(options: SetupWizardOptions, deps: SetupDeps): Promise<void> {
	if (options.nonInteractive || options.schema || options.file || options.json || options.dryRun) {
		await applySetupOptions(options, deps);
		return;
	}
	if (!process.stdin.isTTY) {
		failSetupValidation(
			"signet setup is interactive and requires a TTY.",
			"For headless use, pass --non-interactive with explicit flags, or --file/--json with a setup plan (see --schema).",
		);
	}
	const basePath = deps.normalizeAgentPath(deps.normalizeStringValue(options.path) ?? deps.AGENTS_DIR);
	const existing = deps.detectExistingSetup(basePath);
	if (existing.agentYaml || existing.configYaml || existing.memoryDb) {
		const changes = Object.entries(options).filter(
			([key, value]) =>
				key !== "path" &&
				key !== "openDashboard" &&
				value !== undefined &&
				value !== false &&
				(!Array.isArray(value) || value.length > 0),
		);
		if (changes.length)
			throw new Error(
				"Use --non-interactive to apply configuration flags to an existing workspace, or run signet setup to open its settings.",
			);
	}
	console.log(deps.signetBanner());
	console.log(chalk.dim(`  Workspace: ${basePath}`));
	if (!existing.agentYaml && !existing.configYaml && !existing.memoryDb) {
		const harnesses = options.harness ?? [];
		await applySetupOptions(
			{
				...options,
				path: basePath,
				nonInteractive: true,
				harness: harnesses,
				identityMode: options.identityMode ?? "off",
				extractionProvider: options.extractionProvider ?? "none",
				openDashboard: false,
			},
			deps,
		);
	}
	const client = createDaemonClient(deps.DEFAULT_PORT, basePath);
	if (existing.agentYaml || existing.configYaml || existing.memoryDb) {
		// Resuming onboarding never regenerates configuration or user-authored files.
		if (client.localWorkspace && !(await deps.startDaemon(basePath))) {
			throw new Error("Could not start Signet. Run signet doctor for recovery details; your workspace was preserved.");
		}
	}
	const status = await client.fetchDaemonResult<{ agentsDir: string }>("/api/status");
	if (!status.ok)
		throw new Error(`Signet is not ready: ${status.error ?? status.reason}. Run signet doctor, then retry setup.`);
	if (client.localWorkspace && status.data.agentsDir !== basePath)
		throw new Error(
			"Another workspace is running at this address. Stop it or select its workspace before continuing setup.",
		);
	const url = `${client.url}/#setup`;
	console.log(chalk.cyan(`  Continue setup: ${url}`));
	console.log(chalk.dim("  Connect your provider, select a memory model, and test the connection."));
	await openUrlWithFallback(url);
}

async function applySetupOptions(options: SetupWizardOptions, deps: SetupDeps): Promise<void> {
	if (options.schema) {
		console.log(JSON.stringify(setupPlanJsonSchema(), null, 2));
		return;
	}

	// Headless plan path: apply a validated plan from --file/--json with no
	// prompts. The runtime context is probed from the environment.
	if (options.file || options.json) {
		const explicitPath = deps.normalizeStringValue(options.path);
		const basePath = deps.normalizeAgentPath(explicitPath ?? deps.AGENTS_DIR);
		const plan = loadPlanFromOptions(options);
		if (options.dryRun) {
			console.log(JSON.stringify(plan, null, 2));
			return;
		}
		const existing = deps.detectExistingSetup(basePath);
		if (hasExistingAgentState(existing)) {
			failSetupValidation(
				`An existing Signet installation was found at ${basePath}.`,
				"--file/--json performs a fresh setup. To reconfigure an existing install, run the interactive wizard or use --non-interactive with flags.",
			);
		}
		const context = await buildHeadlessApplyContext(options, basePath, plan, deps, existing.agentsDir);
		await runFreshSetup(plan, context, deps);
		return;
	}

	// Fail closed: never block on an interactive prompt when stdin is not a TTY
	// (piped, agent, CI). Headless callers must opt in via --non-interactive
	// (flags) or --file/--json (plan). Checking stdin (not stdout) still allows
	// `signet setup | tee log` where stdin remains interactive.
	if (!options.nonInteractive && !process.stdin.isTTY) {
		failSetupValidation(
			"signet setup is interactive and requires a TTY.",
			"For headless use, pass --non-interactive with explicit flags, or --file/--json with a setup plan (see --schema).",
		);
	}

	console.log(deps.signetLogo());

	console.log();
	const explicitPath = deps.normalizeStringValue(options.path);
	let basePath = deps.normalizeAgentPath(explicitPath ?? deps.AGENTS_DIR);

	if (!explicitPath) {
		const defaultDetection = deps.detectExistingSetup(basePath);
		if (!hasExistingAgentState(defaultDetection)) {
			const openClawWorkspace = detectPreferredOpenClawWorkspace(basePath, deps);
			if (openClawWorkspace) {
				basePath = openClawWorkspace;
			}
		}
	}

	const existing = deps.detectExistingSetup(basePath);

	console.log(chalk.dim("  Running in non-interactive mode"));
	if (!explicitPath && basePath !== deps.AGENTS_DIR) {
		console.log(chalk.dim(`  Using detected OpenClaw workspace: ${basePath}`));
	}
	console.log();

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
	const existingExtractionEndpoint =
		readString(existingPipeline.extractionEndpoint) ??
		readString(existingPipeline.extractionBaseUrl) ??
		readString(existingExtraction.endpoint) ??
		readString(existingExtraction.base_url);
	const rawDeploymentType = deps.normalizeStringValue(options.deploymentType);
	const requestedDeploymentType = deps.normalizeChoice(rawDeploymentType, DEPLOYMENT_TYPE_CHOICES);
	const rawEmbeddingProvider = deps.normalizeStringValue(options.embeddingProvider);
	const requestedEmbeddingProvider = deps.normalizeChoice(rawEmbeddingProvider, EMBEDDING_PROVIDER_CHOICES);
	const rawExtractionProvider = deps.normalizeStringValue(options.extractionProvider);
	const requestedExtractionProvider = deps.normalizeChoice(rawExtractionProvider, EXTRACTION_PROVIDER_CHOICES);
	const rawExtractionEndpoint = deps.normalizeStringValue(options.extractionEndpoint);
	const requestedExtractionEndpoint = normalizeHttpEndpoint(rawExtractionEndpoint);
	const requestedAggregateRecallProvider = deps.normalizeChoice(
		options.aggregateRecallProvider,
		aggregateRecallProviderIds(),
	);
	if (options.aggregateRecallProvider && !requestedAggregateRecallProvider) {
		failSetupValidation(
			`Unknown --aggregate-recall-provider value: ${options.aggregateRecallProvider}. Valid choices: ${aggregateRecallProviderIds().join(", ")}.`,
		);
	}
	const existingName = readString(existingConfig.name) ?? readString(existingAgent.name) ?? "My Agent";
	const existingDesc =
		readString(existingConfig.description) ?? readString(existingAgent.description) ?? "Personal AI assistant";
	const existingHarnesses = readHarnesses(existingConfig.harnesses);
	const normalizedExistingHarnesses = normalizeHarnessList(existingHarnesses, deps);
	const existingNetworkMode = readNetworkMode(existingConfig);
	const existingIdentity = readRecord(existingConfig.identity);
	const configuredIdentityMode = deps.normalizeChoice(options.identityMode, IDENTITY_MODE_CHOICES);
	const existingIdentityMode = resolveIdentityModeFromConfig(existingConfig);
	// Passthrough remains readable for existing installs, but fresh setup no
	// longer writes or offers it. Reconfiguring explicitly selects a current mode.
	const existingSetupIdentityMode: IdentityMode = existingIdentityMode === "passthrough" ? "off" : existingIdentityMode;
	const configuredIdentityPreset = deps.normalizeChoice(options.identityPreset, IDENTITY_PRESET_CHOICES);
	const existingIdentityPreset = deps.normalizeChoice(existingIdentity.preset, IDENTITY_PRESET_CHOICES);
	if (options.identityMode && !configuredIdentityMode) {
		failSetupValidation(
			`Unknown --identity-mode value: ${options.identityMode}. Valid choices: ${IDENTITY_MODE_CHOICES.join(", ")}.`,
		);
	}
	if (options.identityPreset && !configuredIdentityPreset) {
		failSetupValidation(
			`Unknown --identity-preset value: ${options.identityPreset}. Valid choices: ${IDENTITY_PRESET_CHOICES.join(", ")}.`,
		);
	}
	const {
		availableExtractionProviders: availableToolExtractionProviders,
		acpxBin,
		detectedProvider,
	} = await probeExtractionEnvironment();

	if (rawDeploymentType && !requestedDeploymentType) {
		failSetupValidation(
			`Unknown --deployment-type value: ${rawDeploymentType}. Valid choices: ${DEPLOYMENT_TYPE_CHOICES.join(", ")}.`,
		);
	}
	if (rawEmbeddingProvider && !requestedEmbeddingProvider) {
		failSetupValidation(
			`Unknown --embedding-provider value: ${rawEmbeddingProvider}. Valid choices: ${EMBEDDING_PROVIDER_CHOICES.join(", ")}.`,
		);
	}
	if (rawExtractionProvider && !requestedExtractionProvider) {
		failSetupValidation(
			`Unknown --extraction-provider value: ${rawExtractionProvider}. Valid choices: ${EXTRACTION_PROVIDER_CHOICES.join(", ")}.`,
		);
	}
	if (rawExtractionEndpoint && !requestedExtractionEndpoint) {
		failSetupValidation("--extraction-endpoint must be an http:// or https:// URL.");
	}
	const unknownHarnessValues = findUnknownHarnessValues(options.harness, deps);
	if (unknownHarnessValues.length > 0) {
		failNonInteractiveSetup(
			`Unknown --harness value(s): ${unknownHarnessValues.join(", ")}. Valid choices: ${SETUP_HARNESS_CHOICES.join(", ")}.`,
		);
	}

	if (existing.agentsDir && existing.memoryDb) {
		console.log(chalk.green("  ✓ Existing Signet installation detected"));
		console.log(chalk.dim(`    ${basePath}`));
		console.log();

		const protection = await enforceSetupProtection({
			basePath,
			nonInteractive: true,
			allowUnprotectedWorkspace: options.allowUnprotectedWorkspace === true,
			createLocalBackup: options.createLocalBackup === true,
		});
		const signetSecretsEnabled = await resolveSignetSecretsCorePluginSelection(basePath, options);
		const graphiqEnabled = await resolveGraphiqPluginSelection(basePath, options);
		if (existing.agentYaml) {
			writeCapabilitySelection(
				basePath,
				existingConfig,
				configuredIdentityMode ?? existingSetupIdentityMode,
				signetSecretsEnabled,
			);
			scaffoldIdentityIfNeeded(
				basePath,
				configuredIdentityMode ?? existingSetupIdentityMode,
				existingSetupIdentityMode,
			);
		}
		writeSetupCorePluginRegistry(basePath, { signetSecretsEnabled, graphiqEnabled });
		if (graphiqEnabled) {
			await installGraphiqPlugin({ agentsDir: basePath });
		} else {
			disableGraphiqState(basePath);
		}

		const resolvedIdentityMode = configuredIdentityMode ?? existingSetupIdentityMode;

		// When identity mode changes to off, run stale identity cleanup
		// for all detected and configured harnesses even if --harness was not passed.
		if (resolvedIdentityMode !== "managed" && existingIdentityMode === "managed") {
			const h = existing.harnesses;
			const detectedIds = new Set<string>();
			if (h.claudeCode) detectedIds.add("claude-code");
			if (h.openclaw) detectedIds.add("openclaw");
			if (h.opencode) detectedIds.add("opencode");
			if (h.forge) detectedIds.add("forge");
			if (h.codex) detectedIds.add("codex");
			if (h.kimi) detectedIds.add("kimi");
			if (h.ohMyPi) detectedIds.add("oh-my-pi");
			if (h.pi) detectedIds.add("pi");
			if (h.hermesAgent) detectedIds.add("hermes-agent");
			if (h.gemini) detectedIds.add("gemini");
			// Also include harnesses listed in agent.yaml config
			const configured = deps.loadConfiguredHarnesses?.(basePath) ?? [];
			for (const id of configured) detectedIds.add(id);
			for (const harness of detectedIds) {
				try {
					await deps.configureHarnessHooks(harness, basePath);
				} catch {
					// best-effort cleanup
				}
			}
		}

		const requestedHarnesses = normalizeHarnessList(options.harness, deps);
		if (requestedHarnesses.length > 0) {
			// Hooks are installed before the daemon starts. This is safe because
			// connectors only write static files with a baked-in loopback default.
			// The installed runtime reads SIGNET_DAEMON_URL at runtime and only
			// falls back to that default when no explicit override is present.
			for (const harness of requestedHarnesses) {
				try {
					await deps.configureHarnessHooks(harness, basePath);
				} catch (err) {
					// best-effort — non-interactive should not fail on hook errors
					console.warn(
						chalk.yellow(`  ⚠ Could not configure ${harness}: ${err instanceof Error ? err.message : String(err)}`),
					);
				}
			}
		}

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
			await openUrlWithFallback(`http://127.0.0.1:${deps.DEFAULT_PORT}`);
		}

		printSetupProtectionSummary(protection);
		return;
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

		const deploymentType: DeploymentTypeChoice = requestedDeploymentType ?? "local";
		const existingEmbeddingProvider = deps.normalizeChoice(existingEmbedding.provider, EMBEDDING_PROVIDER_CHOICES);
		const existingExtractionProvider =
			deps.normalizeChoice(existingPipeline.extractionProvider, EXTRACTION_PROVIDER_CHOICES) ||
			deps.normalizeChoice(existingExtraction.provider, EXTRACTION_PROVIDER_CHOICES);
		const migrationEmbeddingProvider =
			requestedEmbeddingProvider ?? existingEmbeddingProvider ?? defaultEmbeddingProviderForDeployment(deploymentType);
		const migrationExtractionProvider = resolveSetupExtractionProvider({
			deploymentType,
			requestedProvider: requestedExtractionProvider,
			providerFromConfig: existingExtractionProvider,
			preserveExisting: true,
			detectedProvider,
			availableProviders: availableToolExtractionProviders,
			preferredHarnesses: normalizedExistingHarnesses,
		});
		const migrationExtractionEndpoint = resolveSetupExtractionEndpoint({
			provider: migrationExtractionProvider,
			requestedEndpoint: requestedExtractionEndpoint,
			existingProvider: existingExtractionProvider,
			existingEndpoint: existingExtractionEndpoint,
		});

		const signetSecretsEnabled = await resolveSignetSecretsCorePluginSelection(basePath, options);
		const graphiqEnabled = await resolveGraphiqPluginSelection(basePath, options);

		await runExistingSetupWizard(basePath, existing, existingConfig, deps, {
			nonInteractive: true,
			identityMode: configuredIdentityMode ?? existingSetupIdentityMode,
			openDashboard: options.openDashboard === true,
			skipGit: options.skipGit === true,
			allowUnprotectedWorkspace: options.allowUnprotectedWorkspace === true,
			createLocalBackup: options.createLocalBackup === true,
			embeddingProvider: migrationEmbeddingProvider,
			embeddingModel: deps.normalizeStringValue(options.embeddingModel) || undefined,
			extractionProvider: migrationExtractionProvider,
			extractionModel: deps.normalizeStringValue(options.extractionModel) || undefined,
			extractionEndpoint: migrationExtractionEndpoint,
			availableExtractionProviders: availableToolExtractionProviders,
			acpxBin,
			dreamingEnabled: options.enableDreaming === true,
			signetSecretsEnabled,
			graphiqEnabled,
		});
		return;
	} else {
		console.log(chalk.bold("  Let's set up your Signet workspace.\n"));

		console.log();
	}

	const identityMode: IdentityMode = configuredIdentityMode ?? existingSetupIdentityMode;

	const identityPreset: IdentityPresetName = configuredIdentityPreset ?? existingIdentityPreset ?? "minimal";

	const startupIdentityFiles = identityMode === "managed" ? cloneStartupFiles(identityPreset) : [];
	const specialIdentityFiles = identityMode === "managed" ? cloneSpecialFiles(identityPreset) : [];

	const configuredName = deps.normalizeStringValue(options.name);
	const agentName = configuredName || existingName;

	let harnesses: HarnessChoice[] = [];

	const requestedHarnesses = normalizeHarnessList(options.harness, deps);

	if (requestedHarnesses.length > 0) {
		harnesses = requestedHarnesses;
	} else {
		harnesses = normalizeHarnessList(existingHarnesses, deps);
	}

	let configureOpenClawWs = false;
	let openclawRuntimePath: OpenClawRuntimeChoice = "plugin";
	let openclawConfigCount = 0;
	if (harnesses.includes("openclaw")) {
		const connector = new OpenClawConnector();
		const existingConfigs = connector.getDiscoveredConfigPaths();
		openclawConfigCount = existingConfigs.length;

		configureOpenClawWs = options.configureOpenclawWorkspace === true && existingConfigs.length > 0;
		openclawRuntimePath = deps.normalizeChoice(options.openclawRuntimePath, OPENCLAW_RUNTIME_CHOICES) ?? "plugin";
	}

	const configuredDescription = deps.normalizeStringValue(options.description);
	const agentDescription = configuredDescription || existingDesc;

	const signetSecretsEnabled = await resolveSignetSecretsCorePluginSelection(basePath, options);
	const graphiqEnabled = await resolveGraphiqPluginSelection(basePath, options);

	// One question covers both how a local daemon binds AND whether to skip a
	// local daemon entirely in favor of a remote one. (networkMode is irrelevant
	// when remote — no local daemon is started.)
	let networkMode: NetworkMode;
	let daemonUrl: string | undefined;
	const requestedRemoteUrl = normalizeDaemonOrigin(deps.normalizeStringValue(options.remoteUrl));
	if (options.remoteUrl && !requestedRemoteUrl) {
		failSetupValidation("--remote-url must be a bare http:// or https:// origin (no path, query, or credentials).");
	}

	networkMode = deps.normalizeChoice(options.networkMode, NETWORK_MODES) ?? existingNetworkMode;
	daemonUrl = requestedRemoteUrl ?? undefined;

	// Deployment type only tailors non-interactive/reconfigure defaults (e.g.
	// VPS prefers non-local extraction providers). It has no effect in the
	// interactive fresh-setup flow, so we don't prompt for it — the flag still
	// works for non-interactive use.
	const deploymentType: DeploymentTypeChoice = requestedDeploymentType ?? "local";

	let embeddingProvider: EmbeddingProviderChoice;

	const providerFromConfig = deps.normalizeChoice(existingEmbedding.provider, EMBEDDING_PROVIDER_CHOICES);
	embeddingProvider =
		requestedEmbeddingProvider ?? providerFromConfig ?? defaultEmbeddingProviderForDeployment(deploymentType);

	let embeddingModel = "nomic-embed-text";
	let embeddingDimensions = 768;

	if (embeddingProvider === "native") {
		embeddingModel = "nomic-embed-text-v1.5";
		embeddingDimensions = 768;
	} else if (embeddingProvider === "ollama") {
		const configuredModel =
			deps.normalizeStringValue(options.embeddingModel) ||
			deps.normalizeStringValue(existingEmbedding.model) ||
			"nomic-embed-text";
		embeddingModel = configuredModel;
		embeddingDimensions = getEmbeddingDimensions(configuredModel);

		const ollamaCheck = await validateOllamaModelNonInteractive(configuredModel);
		if (!ollamaCheck.available || !ollamaCheck.modelInstalled) {
			console.log(chalk.yellow(`  ⚠ ${ollamaCheck.error ?? "Ollama embedding model not available"}`));
			console.log(chalk.yellow("  Downgrading embedding provider to 'native' (built-in ONNX)."));
			embeddingProvider = "native";
			embeddingModel = "nomic-embed-text-v1.5";
			embeddingDimensions = 768;
		}
	} else if (embeddingProvider === "openai") {
		const configuredModel =
			deps.normalizeChoice(options.embeddingModel, ["text-embedding-3-small", "text-embedding-3-large"]) ||
			deps.normalizeChoice(existingEmbedding.model, ["text-embedding-3-small", "text-embedding-3-large"]) ||
			"text-embedding-3-small";
		embeddingModel = configuredModel;
		embeddingDimensions = getEmbeddingDimensions(configuredModel);
	}

	const existingSearchBalance = deps.parseSearchBalanceValue(existingSearch.alpha);
	const requestedSearchBalance = deps.parseSearchBalanceValue(options.searchBalance);
	const searchBalance = requestedSearchBalance ?? existingSearchBalance ?? 0.7;

	const existingSetupExtractionProvider =
		deps.normalizeChoice(existingPipeline.extractionProvider, EXTRACTION_PROVIDER_CHOICES) ||
		deps.normalizeChoice(existingExtraction.provider, EXTRACTION_PROVIDER_CHOICES);
	let extractionProvider: ExtractionProviderChoice;
	let extractionModel = "haiku";

	extractionProvider = resolveSetupExtractionProvider({
		deploymentType,
		requestedProvider: requestedExtractionProvider,
		providerFromConfig: existingSetupExtractionProvider,
		preserveExisting: false,
		detectedProvider,
		availableProviders: availableToolExtractionProviders,
		preferredHarnesses: harnesses,
	});

	if (extractionProvider === "acpx") {
		extractionModel =
			deps.normalizeStringValue(options.extractionModel) ||
			deps.normalizeStringValue(existingPipeline.extractionModel) ||
			deps.normalizeStringValue(existingExtraction.model) ||
			defaultAcpxModel(harnesses, availableToolExtractionProviders);
	} else if (extractionProvider === "claude-code") {
		extractionModel =
			deps.normalizeStringValue(options.extractionModel) ||
			deps.normalizeStringValue(existingPipeline.extractionModel) ||
			deps.normalizeStringValue(existingExtraction.model) ||
			defaultExtractionModel("claude-code");
	} else if (extractionProvider === "codex") {
		extractionModel =
			deps.normalizeStringValue(options.extractionModel) ||
			deps.normalizeStringValue(existingPipeline.extractionModel) ||
			deps.normalizeStringValue(existingExtraction.model) ||
			defaultExtractionModel("codex");
	} else if (extractionProvider === "opencode") {
		extractionModel =
			deps.normalizeStringValue(options.extractionModel) ||
			deps.normalizeStringValue(existingPipeline.extractionModel) ||
			deps.normalizeStringValue(existingExtraction.model) ||
			defaultExtractionModel("opencode");
	} else if (extractionProvider === "openrouter") {
		extractionModel =
			deps.normalizeStringValue(options.extractionModel) ||
			deps.normalizeStringValue(existingPipeline.extractionModel) ||
			deps.normalizeStringValue(existingExtraction.model) ||
			defaultExtractionModel("openrouter");
	} else if (extractionProvider === "openai-compatible") {
		extractionModel =
			deps.normalizeStringValue(options.extractionModel) ||
			deps.normalizeStringValue(existingPipeline.extractionModel) ||
			deps.normalizeStringValue(existingExtraction.model) ||
			defaultExtractionModel("openai-compatible");
	} else if (extractionProvider === "ollama") {
		extractionModel =
			deps.normalizeStringValue(options.extractionModel) ||
			deps.normalizeStringValue(existingPipeline.extractionModel) ||
			deps.normalizeStringValue(existingExtraction.model) ||
			defaultExtractionModel("ollama");
	}

	const extractionEndpoint = resolveSetupExtractionEndpoint({
		provider: extractionProvider,
		requestedEndpoint: requestedExtractionEndpoint,
		existingProvider: existingSetupExtractionProvider,
		existingEndpoint: existingExtractionEndpoint,
	});

	// Optional distinct provider for aggregate recall (query-time evidence
	// synthesis). pi-ai-only (no harness subprocess). When unset, aggregate
	// recall falls through to the default policy (the extraction provider).
	let aggregateRecallProvider: string | undefined;
	let aggregateRecallModel: string | undefined;
	let aggregateRecallEndpoint: string | undefined;

	aggregateRecallProvider =
		deps.normalizeChoice(options.aggregateRecallProvider, aggregateRecallProviderIds()) ?? undefined ?? undefined;
	aggregateRecallModel = deps.normalizeStringValue(options.aggregateRecallModel) ?? undefined;
	aggregateRecallEndpoint =
		normalizeHttpEndpoint(deps.normalizeStringValue(options.aggregateRecallEndpoint)) ??
		(aggregateRecallProvider === "openai-compatible" ? DEFAULT_OPENAI_COMPATIBLE_ENDPOINT : undefined);

	const searchTopK = deps.parseIntegerValue(existingSearch.top_k) ?? 20;
	const searchMinScore = deps.parseSearchBalanceValue(existingSearch.min_score) ?? 0.3;
	const memorySessionBudget = deps.parseIntegerValue(existingMemory.session_budget) ?? 2000;
	const memoryDecayRate = deps.parseSearchBalanceValue(existingMemory.decay_rate) ?? 0.95;

	const dreamingEnabled = options.enableDreaming === true;

	let gitEnabled = false;
	const shouldSkipGit = options.skipGit === true;

	if (existing.agentsDir) {
		if (deps.isGitRepo(basePath)) {
			gitEnabled = true;
			console.log(chalk.dim("  Git repo detected. Will create backup commit before changes."));
		} else if (!shouldSkipGit) {
			const initGit = true;

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
		const initGit = true;
		gitEnabled = initGit;
	}

	// Multi-agent roster: additional named agents beyond the default. Each gets
	// a memory read-policy; the daemon reconciles agents.roster into the
	// `agents` table at boot (syncAgentRoster).
	const agents: { name: string; memoryPolicy: "isolated" | "shared" | "group"; memoryGroup?: string }[] = [];

	const seen = new Set<string>();
	for (const raw of options.agent ?? []) {
		const parsed = parseAgentFlag(raw);
		if (seen.has(parsed.name)) {
			console.warn(chalk.yellow(`  ⚠ duplicate --agent "${parsed.name}" ignored`));
			continue;
		}
		seen.add(parsed.name);
		agents.push(parsed);
	}

	// Obsidian vault sources (config files the daemon indexes at boot).
	const sources: { type: "obsidian"; path: string; name?: string }[] = [];

	for (const raw of options.obsidianSource ?? []) {
		const [path, name] = raw.split("::").map((p) => p.trim());
		if (path) sources.push({ type: "obsidian", path, name: name || undefined });
	}

	const plan: SetupPlan = {
		agentName,
		agentDescription,
		networkMode,
		harnesses,
		openclawRuntimePath,
		configureOpenClawWs,
		embeddingProvider,
		embeddingModel,
		embeddingDimensions,
		extractionProvider,
		extractionModel,
		extractionEndpoint,
		aggregateRecallProvider,
		aggregateRecallModel,
		aggregateRecallEndpoint,
		searchBalance,
		searchTopK,
		searchMinScore,
		memorySessionBudget,
		memoryDecayRate,
		gitEnabled,
		signetSecretsEnabled,
		graphiqEnabled,
		identityMode,
		identityPreset,
		startupIdentityFiles,
		specialIdentityFiles,
		dreamingEnabled,
		daemonUrl,
		agents: agents.length > 0 ? agents : undefined,
		sources: sources.length > 0 ? sources : undefined,
	};

	const context: SetupApplyContext = {
		basePath,
		existingAgentsDir: existing.agentsDir,
		nonInteractive: true,
		allowUnprotectedWorkspace: options.allowUnprotectedWorkspace === true,
		createLocalBackup: options.createLocalBackup === true,
		availableExtractionProviders: availableToolExtractionProviders,
		acpxBin,
		openclawConfigCount,
		openDashboard: options.openDashboard === true,
	};

	// Enforce the same cross-field invariants the headless --file path gets via
	// parseSetupPlan (e.g. synthesis requires extraction; group needs a group).
	try {
		parseSetupPlan(plan);
	} catch (err) {
		failSetupValidation(err instanceof Error ? err.message : String(err));
	}

	if (options.dryRun) {
		console.log(JSON.stringify(plan, null, 2));
		return;
	}

	await runFreshSetup(plan, context, deps);
}

async function resolveGraphiqPluginSelection(basePath: string, options: SetupWizardOptions): Promise<boolean> {
	const current = readSetupCorePluginEnabled(basePath, "signet.graphiq");
	const defaultEnabled = current ?? false;
	if (options.withGraphiq === true) return true;
	if (options.disableGraphiq === true) return false;
	return defaultEnabled;
}

async function resolveSignetSecretsCorePluginSelection(
	basePath: string,
	options: SetupWizardOptions,
): Promise<boolean> {
	const current = readSetupCorePluginEnabled(basePath);
	const defaultEnabled = current ?? true;
	if (options.disableSignetSecrets === true) return false;
	return defaultEnabled;
}
