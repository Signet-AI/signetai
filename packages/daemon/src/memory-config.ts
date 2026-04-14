import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	DEFAULT_PIPELINE_TIMEOUT_MS,
	DEFAULT_PROVIDER_RATE_LIMIT,
	type DreamingConfig,
	PIPELINE_FLAGS,
	type PipelineFlag,
	type PipelineV2Config,
	defaultPipelineModel,
	isPipelineProvider,
	parseSimpleYaml,
} from "@signet/core";
import { type AuthConfig, parseAuthConfig } from "./auth/config";
import { logger } from "./logger";

export interface EmbeddingConfig {
	provider: "native" | "llama-cpp" | "ollama" | "openai" | "none";
	model: string;
	dimensions: number;
	base_url: string;
	api_key?: string;
}

export interface MemorySearchConfig {
	alpha: number;
	top_k: number;
	min_score: number;
	rehearsal_enabled: boolean;
	rehearsal_weight: number;
	rehearsal_half_life_days: number;
}

export { PIPELINE_FLAGS };
export type { PipelineFlag, PipelineV2Config, DreamingConfig };

export const DEFAULT_DREAMING: DreamingConfig = {
	enabled: false,
	tokenThreshold: 100_000,
	timeout: 300_000,
	maxInputTokens: 128_000,
	maxOutputTokens: 16_000,
	backfillOnFirstRun: true,
};

class PipelineConfigValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PipelineConfigValidationError";
	}
}

export const DEFAULT_PIPELINE_V2: PipelineV2Config = {
	enabled: true,
	paused: false,
	shadowMode: false,
	nativeShadowEnabled: false,
	mutationsFrozen: false,
	semanticContradictionEnabled: true,
	semanticContradictionTimeoutMs: 120000,
	extraction: {
		provider: "llama-cpp",
		fallbackProvider: "llama-cpp",
		model: "qwen3.5:4b",
		strength: "low",
		endpoint: undefined,
		timeout: DEFAULT_PIPELINE_TIMEOUT_MS,
		minConfidence: 0.7,
		command: undefined,
		escalation: {
			maxNewEntitiesPerChunk: 10,
			maxNewAttributesPerEntity: 20,
			level2MaxEntities: 5,
		},
	},
	worker: {
		pollMs: 2000,
		maxRetries: 3,
		leaseTimeoutMs: 300000,
		maxLoadPerCpu: 0.8,
		overloadBackoffMs: 30000,
	},
	graph: {
		enabled: true,
		boostWeight: 0.15,
		boostTimeoutMs: 500,
	},
	traversal: {
		enabled: true,
		primary: true,
		maxAspectsPerEntity: 10,
		maxAttributesPerAspect: 20,
		maxDependencyHops: 10,
		minDependencyStrength: 0.3,
		maxBranching: 4,
		maxTraversalPaths: 50,
		minConfidence: 0.5,
		timeoutMs: 500,
		boostWeight: 0.2,
		constraintBudgetChars: 1000,
	},
	reranker: {
		enabled: true,
		model: "",
		useExtractionModel: false,
		topN: 20,
		timeoutMs: 2000,
	},
	autonomous: {
		enabled: true,
		frozen: false,
		allowUpdateDelete: true,
		maintenanceIntervalMs: 30 * 60 * 1000, // 30 min
		maintenanceMode: "execute",
	},
	repair: {
		reembedCooldownMs: 300000, // 5 min
		reembedHourlyBudget: 10,
		requeueCooldownMs: 60000, // 1 min
		requeueHourlyBudget: 50,
		dedupCooldownMs: 600000, // 10 min
		dedupHourlyBudget: 3,
		dedupSemanticThreshold: 0.92,
		dedupBatchSize: 100,
	},
	documents: {
		workerIntervalMs: 10000,
		chunkSize: 2000,
		chunkOverlap: 200,
		maxContentBytes: 10 * 1024 * 1024, // 10 MB
	},
	guardrails: {
		maxContentChars: 800,
		chunkTargetChars: 600,
		recallTruncateChars: 500,
		// Total character budget for the injected <signet-memory> block per
		// prompt turn. Memories are greedily included from highest score until
		// this limit is reached. Prevents context window overruns on long sessions.
		contextBudgetChars: 4000,
	},
	continuity: {
		enabled: true,
		promptInterval: 10,
		timeIntervalMs: 900_000, // 15 min
		maxCheckpointsPerSession: 50,
		retentionDays: 7,
		recoveryBudgetChars: 2000,
	},
	telemetryEnabled: false,
	telemetry: {
		posthogHost: "",
		posthogApiKey: "",
		flushIntervalMs: 60000,
		flushBatchSize: 50,
		retentionDays: 90,
	},
	embeddingTracker: {
		enabled: true,
		pollMs: 5000,
		batchSize: 8,
	},
	synthesis: {
		enabled: true,
		provider: "ollama",
		model: "qwen3:4b",
		endpoint: undefined,
		timeout: 120000,
		maxTokens: 8000,
		idleGapMinutes: 15,
	},
	procedural: {
		enabled: true,
		decayRate: 0.99,
		minImportance: 0.3,
		importanceOnInstall: 0.7,
		enrichOnInstall: true,
		enrichMinDescription: 30,
		reconcileIntervalMs: 60000,
	},
	structural: {
		enabled: true,
		classifyBatchSize: 8,
		dependencyBatchSize: 5,
		pollIntervalMs: 10000,
		synthesisEnabled: true,
		synthesisIntervalMs: 60_000,
		synthesisTopEntities: 20,
		synthesisMaxFacts: 10,
		synthesisMaxStallMs: 30 * 60_000,
		supersessionEnabled: true,
		supersessionSweepEnabled: true,
		supersessionSemanticFallback: true,
		supersessionMinConfidence: 0.7,
	},
	feedback: {
		enabled: true,
		ftsWeightDelta: 0.02,
		maxAspectWeight: 1.0,
		minAspectWeight: 0.1,
		decayEnabled: true,
		decayRate: 0.005,
		staleDays: 14,
		decayIntervalSessions: 10,
	},
	significance: {
		enabled: true,
		minTurns: 5,
		minEntityOverlap: 1,
		noveltyThreshold: 0.15,
	},
	writeGate: {
		enabled: true,
		threshold: 0.4,
		continuityDiscount: 0.15,
	},
	predictor: {
		enabled: true,
		trainIntervalSessions: 10,
		minTrainingSessions: 10,
		scoreTimeoutMs: 120,
		trainTimeoutMs: 30000,
		crashDisableThreshold: 3,
		rrfK: 12,
		explorationRate: 0.05,
		driftResetWindow: 10,
	},
	predictorPipeline: {
		agentFeedback: true,
		trainingTelemetry: false,
	},
	modelRegistry: {
		enabled: true,
		refreshIntervalMs: 3600_000,
	},
	hints: {
		enabled: true,
		max: 5,
		timeout: 60000,
		maxTokens: 256,
		poll: 5000,
	},
};

export const DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434";
export const DEFAULT_LLAMACPP_BASE_URL = "http://localhost:8080";
export const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";

export interface ResolvedMemoryConfig {
	embedding: EmbeddingConfig;
	search: MemorySearchConfig;
	pipelineV2: PipelineV2Config;
	dreaming: DreamingConfig;
	auth: AuthConfig;
}

class MemoryConfigValidationError extends Error {}

function clampPositive(raw: unknown, min: number, max: number, fallback: number): number {
	if (typeof raw !== "number" || !Number.isFinite(raw)) return fallback;
	// Bounds are inclusive; a few config fields intentionally use 0 as a disable sentinel.
	return Math.max(min, Math.min(max, raw));
}

function clampNonNegative(raw: unknown, max: number, fallback: number): number {
	if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) return fallback;
	return Math.min(max, raw);
}

function parseOptionalPositive(raw: unknown, min: number, max: number): number | undefined {
	if (typeof raw !== "number" || !Number.isFinite(raw)) return undefined;
	return Math.max(min, Math.min(max, raw));
}

function clampFraction(raw: unknown, fallback: number): number {
	if (typeof raw !== "number" || !Number.isFinite(raw)) return fallback;
	return Math.max(0, Math.min(1, raw));
}

function isExtractionStrength(v: unknown): v is "low" | "medium" | "high" {
	return typeof v === "string" && ["low", "medium", "high"].includes(v);
}

function isExtractionFallbackProvider(v: unknown): v is "llama-cpp" | "ollama" | "none" {
	return v === "llama-cpp" || v === "ollama" || v === "none";
}

function resolveExtractionFallbackProvider(
	raw: unknown,
	fallback: "llama-cpp" | "ollama" | "none",
): "llama-cpp" | "ollama" | "none" {
	if (raw === undefined || raw === null) return fallback;
	if (isExtractionFallbackProvider(raw)) return raw;
	throw new MemoryConfigValidationError(
		`Invalid extraction fallbackProvider "${String(raw)}"; expected "llama-cpp", "ollama", or "none"`,
	);
}

function parseOptionalUrl(raw: unknown): string | undefined {
	if (typeof raw !== "string") return undefined;
	const trimmed = raw.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRateLimitConfig(raw: unknown): PipelineV2Config["extraction"]["rateLimit"] | undefined {
	if (!isRecord(raw)) return undefined;
	const maxCallsPerHour = parseOptionalPositive(raw.maxCallsPerHour, 0, 10000);
	const burstSize = parseOptionalPositive(raw.burstSize, 1, 1000);
	const waitTimeoutMs = parseOptionalPositive(raw.waitTimeoutMs, 0, 60000);
	if (maxCallsPerHour === undefined && burstSize === undefined && waitTimeoutMs === undefined) return undefined;
	return {
		maxCallsPerHour: maxCallsPerHour ?? DEFAULT_PROVIDER_RATE_LIMIT.maxCallsPerHour,
		burstSize: burstSize ?? DEFAULT_PROVIDER_RATE_LIMIT.burstSize,
		waitTimeoutMs: waitTimeoutMs ?? DEFAULT_PROVIDER_RATE_LIMIT.waitTimeoutMs,
	};
}

function parseCommandArgv(raw: string): { bin: string; args: string[] } | null {
	const tokens = raw.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g);
	if (!tokens || tokens.length === 0) return null;
	const argv = tokens.map((token) => token.replace(/^["']|["']$/g, "")).filter((token) => token.length > 0);
	if (argv.length === 0) return null;
	return {
		bin: argv[0],
		args: argv.slice(1),
	};
}

function parseCommandConfig(raw: unknown): PipelineV2Config["extraction"]["command"] | undefined {
	if (typeof raw === "string") {
		const parsed = parseCommandArgv(raw);
		if (!parsed) return undefined;
		return {
			bin: parsed.bin,
			args: parsed.args,
		};
	}

	if (!isRecord(raw)) {
		return undefined;
	}

	const record = raw;
	const candidateBin = typeof record.bin === "string" ? record.bin : "";
	const bin = candidateBin.trim();
	if (bin.length === 0) return undefined;

	let args: string[] = [];
	if (Array.isArray(record.args)) {
		if (record.args.some((item) => typeof item !== "string")) {
			return undefined;
		}
		args = [...record.args];
	}
	const cwd = typeof record.cwd === "string" && record.cwd.trim().length > 0 ? record.cwd.trim() : undefined;

	let env: Record<string, string> | undefined;
	if (typeof record.env === "object" && record.env !== null && !Array.isArray(record.env)) {
		for (const [key, value] of Object.entries(record.env)) {
			if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
			if (typeof value !== "string") continue;
			if (!env) env = {};
			env[key] = value;
		}
	}

	return {
		bin,
		args,
		cwd,
		env,
	};
}

/**
 * Load pipeline config from YAML, supporting both nested and flat key formats.
 * Flat extraction keys (dashboard-written) take precedence over nested keys.
 * Provider and model are paired — if flat provider wins, flat model wins too.
 */
export function loadPipelineConfig(yaml: Record<string, unknown>): PipelineV2Config {
	const mem = yaml.memory as Record<string, unknown> | undefined;
	const raw = mem?.pipelineV2 as Record<string, unknown> | undefined;
	if (!raw) return { ...DEFAULT_PIPELINE_V2 };

	// Read nested sub-objects (may be undefined for old flat configs)
	const extractionRaw = raw.extraction as Record<string, unknown> | undefined;
	const escalationRaw = extractionRaw?.escalation as Record<string, unknown> | undefined;
	const workerRaw = raw.worker as Record<string, unknown> | undefined;
	const graphRaw = raw.graph as Record<string, unknown> | undefined;
	const traversalRaw = raw.traversal as Record<string, unknown> | undefined;
	const rerankerRaw = raw.reranker as Record<string, unknown> | undefined;
	const autonomousRaw = raw.autonomous as Record<string, unknown> | undefined;
	const repairRaw = raw.repair as Record<string, unknown> | undefined;
	const documentsRaw = raw.documents as Record<string, unknown> | undefined;
	const guardrailsRaw = raw.guardrails as Record<string, unknown> | undefined;
	const telemetryRaw = raw.telemetry as Record<string, unknown> | undefined;
	const continuityRaw = raw.continuity as Record<string, unknown> | undefined;
	const embeddingTrackerRaw = raw.embeddingTracker as Record<string, unknown> | undefined;
	const synthesisRaw = raw.synthesis as Record<string, unknown> | undefined;
	const proceduralRaw = raw.procedural as Record<string, unknown> | undefined;
	const structuralRaw = raw.structural as Record<string, unknown> | undefined;
	const dependencySynthesisRaw = raw.dependencySynthesis as Record<string, unknown> | undefined;
	const feedbackRaw = raw.feedback as Record<string, unknown> | undefined;
	const significanceRaw = raw.significance as Record<string, unknown> | undefined;
	const writeGateRaw = raw.writeGate as Record<string, unknown> | undefined;
	const predictorRaw = raw.predictor as Record<string, unknown> | undefined;
	const predictorPipelineRaw = raw.predictorPipeline as Record<string, unknown> | undefined;
	const modelRegistryRaw = raw.modelRegistry as Record<string, unknown> | undefined;
	const hintsRaw = raw.hints as Record<string, unknown> | undefined;

	// Helper: resolve with flat-fallback (non-extraction fields still nested-first)
	const d = DEFAULT_PIPELINE_V2;

	function resolveBool(nested: unknown, flat: unknown, fallback: boolean): boolean {
		if (typeof nested === "boolean") return nested;
		if (typeof flat === "boolean") return flat;
		return fallback;
	}

	// -- Extraction provider resolution --
	// Flat keys win when set (dashboard writes these); nested is fallback.
	// Provider and model must stay paired — if flat provider won, use flat model.
	const nestedProvider = extractionRaw?.provider;
	const flatProvider = raw.extractionProvider;
	const flatModel = raw.extractionModel;

	type ProviderKind = Parameters<typeof defaultPipelineModel>[0];
	type SynthesisProviderKind = Exclude<ProviderKind, "command">;
	const isExtractionProvider = (value: unknown): value is ProviderKind =>
		value === "command" || isPipelineProvider(value);
	const isSynthesisProvider = (value: unknown): value is SynthesisProviderKind =>
		isExtractionProvider(value) && value !== "command";

	function resolveModel(provider: ProviderKind, raw: unknown, fallback?: string): string {
		if (typeof raw === "string" && raw.trim().length > 0) {
			return raw;
		}
		if (typeof fallback === "string" && fallback.trim().length > 0) {
			return fallback;
		}
		return defaultPipelineModel(provider);
	}

	const flatProviderWon = isExtractionProvider(flatProvider);
	const nestedProviderWon = isExtractionProvider(nestedProvider);
	// Model-only flat key: no provider set anywhere, but extractionModel is
	// present.  Default to "llama-cpp" so the model isn't silently discarded.
	const flatModelOnly = !flatProviderWon && !nestedProviderWon && typeof flatModel === "string";
	const resolvedProvider: ProviderKind = flatProviderWon
		? flatProvider
		: nestedProviderWon
			? nestedProvider
			: flatModelOnly
				? "llama-cpp"
				: d.extraction.provider;
	const resolvedModel = flatProviderWon
		? resolveModel(resolvedProvider, flatModel)
		: nestedProviderWon && typeof extractionRaw?.model === "string"
			? extractionRaw.model
			: flatModelOnly
				? resolveModel(resolvedProvider, flatModel)
				: resolveModel(resolvedProvider, undefined, d.extraction.model);
	const resolvedEndpoint =
		parseOptionalUrl(extractionRaw?.endpoint) ??
		parseOptionalUrl(extractionRaw?.base_url) ??
		parseOptionalUrl(raw.extractionEndpoint) ??
		parseOptionalUrl(raw.extractionBaseUrl);
	const resolvedTimeout = clampPositive(
		extractionRaw?.timeout ?? raw.extractionTimeout,
		5000,
		300000,
		d.extraction.timeout,
	);
	const resolvedFallbackProvider = resolveExtractionFallbackProvider(
		extractionRaw?.fallbackProvider ?? raw.extractionFallbackProvider,
		d.extraction.fallbackProvider,
	);
	const resolvedCommandConfig = parseCommandConfig(extractionRaw?.command ?? raw.extractionCommand);
	if (resolvedProvider === "command" && !resolvedCommandConfig) {
		throw new PipelineConfigValidationError(
			"memory.pipelineV2.extraction.command is required when extraction.provider='command'.",
		);
	}
	if (synthesisRaw?.provider === "command") {
		throw new PipelineConfigValidationError(
			"memory.pipelineV2.synthesis.provider='command' is not supported. Use memory.pipelineV2.extraction.provider='command' instead.",
		);
	}

	const synthesisProviderWon = isSynthesisProvider(synthesisRaw?.provider);
	const resolvedSynthesisProvider: SynthesisProviderKind = synthesisProviderWon
		? synthesisRaw.provider
		: resolvedProvider === "command"
			? d.synthesis.provider
			: resolvedProvider;
	const resolvedSynthesisModel =
		typeof synthesisRaw?.model === "string" && synthesisRaw.model.trim().length > 0
			? synthesisRaw.model
			: synthesisProviderWon
				? defaultPipelineModel(resolvedSynthesisProvider)
				: resolvedProvider === "command"
					? d.synthesis.model
					: resolvedModel;
	const resolvedSynthesisEndpoint =
		parseOptionalUrl(synthesisRaw?.endpoint) ??
		parseOptionalUrl(synthesisRaw?.base_url) ??
		(synthesisProviderWon || resolvedProvider === "command" ? undefined : resolvedEndpoint);
	const resolvedSynthesisTimeout = clampPositive(
		synthesisRaw?.timeout,
		5000,
		300000,
		synthesisProviderWon || resolvedProvider === "command" ? d.synthesis.timeout : resolvedTimeout,
	);
	const resolvedSynthesisEnabled =
		resolvedSynthesisProvider === "none" ? false : resolveBool(synthesisRaw?.enabled, undefined, d.synthesis.enabled);

	// Normalize aspect weights: clamp independently, then enforce min <= max
	const maxAW = clampFraction(feedbackRaw?.maxAspectWeight, d.feedback.maxAspectWeight);
	const minAW = clampFraction(feedbackRaw?.minAspectWeight, d.feedback.minAspectWeight);
	const validatedMinAW = minAW > maxAW ? maxAW : minAW;

	return {
		enabled: typeof raw.enabled === "boolean" ? raw.enabled : d.enabled,
		paused: typeof raw.paused === "boolean" ? raw.paused : d.paused,
		shadowMode: typeof raw.shadowMode === "boolean" ? raw.shadowMode : d.shadowMode,
		nativeShadowEnabled: typeof raw.nativeShadowEnabled === "boolean" ? raw.nativeShadowEnabled : d.nativeShadowEnabled,
		mutationsFrozen: typeof raw.mutationsFrozen === "boolean" ? raw.mutationsFrozen : d.mutationsFrozen,
		semanticContradictionEnabled:
			typeof raw.semanticContradictionEnabled === "boolean"
				? raw.semanticContradictionEnabled
				: d.semanticContradictionEnabled,
		semanticContradictionTimeoutMs: clampPositive(
			raw.semanticContradictionTimeoutMs,
			5000,
			300000,
			d.semanticContradictionTimeoutMs,
		),

		extraction: {
			provider: resolvedProvider,
			fallbackProvider: resolvedFallbackProvider,
			model: resolvedModel,
			strength: (() => {
				// Flat keys win when set (dashboard writes these); nested is fallback
				const candidate = raw.extractionStrength ?? extractionRaw?.strength;
				return isExtractionStrength(candidate) ? candidate : d.extraction.strength;
			})(),
			endpoint: resolvedEndpoint,
			timeout: resolvedTimeout,
			minConfidence: clampFraction(
				extractionRaw?.minConfidence ?? raw.minFactConfidenceForWrite,
				d.extraction.minConfidence,
			),
			command: resolvedCommandConfig,
			escalation: {
				maxNewEntitiesPerChunk: clampPositive(
					escalationRaw?.maxNewEntitiesPerChunk,
					1,
					100,
					d.extraction.escalation?.maxNewEntitiesPerChunk ?? 10,
				),
				maxNewAttributesPerEntity: clampPositive(
					escalationRaw?.maxNewAttributesPerEntity,
					1,
					200,
					d.extraction.escalation?.maxNewAttributesPerEntity ?? 20,
				),
				level2MaxEntities: clampPositive(
					escalationRaw?.level2MaxEntities,
					1,
					50,
					d.extraction.escalation?.level2MaxEntities ?? 5,
				),
			},
			rateLimit: parseRateLimitConfig(extractionRaw?.rateLimit),
			structuredOutput: (() => {
				const candidate = extractionRaw?.structuredOutput;
				return typeof candidate === "boolean" ? candidate : undefined;
			})(),
		},

		worker: {
			pollMs: clampPositive(workerRaw?.pollMs ?? raw.workerPollMs, 100, 60000, d.worker.pollMs),
			maxRetries: clampPositive(workerRaw?.maxRetries ?? raw.workerMaxRetries, 1, 10, d.worker.maxRetries),
			leaseTimeoutMs: clampPositive(
				workerRaw?.leaseTimeoutMs ?? raw.leaseTimeoutMs,
				10000,
				600000,
				d.worker.leaseTimeoutMs,
			),
			maxLoadPerCpu: clampPositive(workerRaw?.maxLoadPerCpu ?? raw.workerMaxLoadPerCpu, 0.1, 8, d.worker.maxLoadPerCpu),
			overloadBackoffMs: clampPositive(
				workerRaw?.overloadBackoffMs ?? raw.workerOverloadBackoffMs,
				1000,
				300000,
				d.worker.overloadBackoffMs,
			),
		},

		graph: {
			enabled: resolveBool(graphRaw?.enabled, raw.graphEnabled, d.graph.enabled),
			boostWeight: clampFraction(graphRaw?.boostWeight ?? raw.graphBoostWeight, d.graph.boostWeight),
			boostTimeoutMs: clampPositive(
				graphRaw?.boostTimeoutMs ?? raw.graphBoostTimeoutMs,
				50,
				5000,
				d.graph.boostTimeoutMs,
			),
		},

		traversal: {
			enabled: resolveBool(traversalRaw?.enabled, undefined, d.traversal?.enabled ?? true),
			primary: resolveBool(traversalRaw?.primary, undefined, d.traversal?.primary ?? true),
			maxAspectsPerEntity: clampPositive(
				traversalRaw?.maxAspectsPerEntity,
				1,
				100,
				d.traversal?.maxAspectsPerEntity ?? 10,
			),
			maxAttributesPerAspect: clampPositive(
				traversalRaw?.maxAttributesPerAspect,
				1,
				200,
				d.traversal?.maxAttributesPerAspect ?? 20,
			),
			maxDependencyHops: clampPositive(traversalRaw?.maxDependencyHops, 1, 200, d.traversal?.maxDependencyHops ?? 10),
			minDependencyStrength: clampFraction(
				traversalRaw?.minDependencyStrength,
				d.traversal?.minDependencyStrength ?? 0.3,
			),
			maxBranching: clampPositive(traversalRaw?.maxBranching, 1, 50, d.traversal?.maxBranching ?? 4),
			maxTraversalPaths: clampPositive(traversalRaw?.maxTraversalPaths, 1, 500, d.traversal?.maxTraversalPaths ?? 50),
			minConfidence: clampFraction(traversalRaw?.minConfidence, d.traversal?.minConfidence ?? 0.5),
			timeoutMs: clampPositive(traversalRaw?.timeoutMs, 50, 5000, d.traversal?.timeoutMs ?? 500),
			boostWeight: clampFraction(traversalRaw?.boostWeight, d.traversal?.boostWeight ?? 0.2),
			constraintBudgetChars: clampPositive(
				traversalRaw?.constraintBudgetChars,
				200,
				10000,
				d.traversal?.constraintBudgetChars ?? 1000,
			),
		},

		reranker: {
			enabled: resolveBool(rerankerRaw?.enabled, raw.rerankerEnabled, d.reranker.enabled),
			model:
				typeof rerankerRaw?.model === "string"
					? rerankerRaw.model
					: typeof raw.rerankerModel === "string"
						? (raw.rerankerModel as string)
						: d.reranker.model,
			useExtractionModel: resolveBool(
				rerankerRaw?.useExtractionModel,
				raw.rerankerUseExtractionModel,
				d.reranker.useExtractionModel,
			),
			topN: clampPositive(rerankerRaw?.topN ?? raw.rerankerTopN, 1, 100, d.reranker.topN),
			timeoutMs: clampPositive(rerankerRaw?.timeoutMs ?? raw.rerankerTimeoutMs, 100, 30000, d.reranker.timeoutMs),
		},

		autonomous: {
			enabled: resolveBool(autonomousRaw?.enabled, raw.autonomousEnabled, d.autonomous.enabled),
			frozen: resolveBool(autonomousRaw?.frozen, raw.autonomousFrozen, d.autonomous.frozen),
			allowUpdateDelete: resolveBool(
				autonomousRaw?.allowUpdateDelete,
				raw.allowUpdateDelete,
				d.autonomous.allowUpdateDelete,
			),
			maintenanceIntervalMs: clampPositive(
				autonomousRaw?.maintenanceIntervalMs ?? raw.maintenanceIntervalMs,
				60000,
				86400000,
				d.autonomous.maintenanceIntervalMs,
			),
			maintenanceMode: (() => {
				const v = autonomousRaw?.maintenanceMode ?? raw.maintenanceMode;
				if (v === "execute" || v === "observe") return v;
				return d.autonomous.maintenanceMode;
			})(),
		},

		repair: {
			reembedCooldownMs: clampPositive(
				repairRaw?.reembedCooldownMs ?? raw.repairReembedCooldownMs,
				10000,
				3600000,
				d.repair.reembedCooldownMs,
			),
			reembedHourlyBudget: clampPositive(
				repairRaw?.reembedHourlyBudget ?? raw.repairReembedHourlyBudget,
				1,
				1000,
				d.repair.reembedHourlyBudget,
			),
			requeueCooldownMs: clampPositive(
				repairRaw?.requeueCooldownMs ?? raw.repairRequeueCooldownMs,
				5000,
				3600000,
				d.repair.requeueCooldownMs,
			),
			requeueHourlyBudget: clampPositive(
				repairRaw?.requeueHourlyBudget ?? raw.repairRequeueHourlyBudget,
				1,
				1000,
				d.repair.requeueHourlyBudget,
			),
			dedupCooldownMs: clampPositive(
				repairRaw?.dedupCooldownMs ?? raw.repairDedupCooldownMs,
				10000,
				3600000,
				d.repair.dedupCooldownMs,
			),
			dedupHourlyBudget: clampPositive(
				repairRaw?.dedupHourlyBudget ?? raw.repairDedupHourlyBudget,
				1,
				100,
				d.repair.dedupHourlyBudget,
			),
			dedupSemanticThreshold: clampFraction(
				repairRaw?.dedupSemanticThreshold ?? raw.repairDedupSemanticThreshold,
				d.repair.dedupSemanticThreshold,
			),
			dedupBatchSize: clampPositive(
				repairRaw?.dedupBatchSize ?? raw.repairDedupBatchSize,
				10,
				1000,
				d.repair.dedupBatchSize,
			),
		},

		documents: {
			workerIntervalMs: clampPositive(
				documentsRaw?.workerIntervalMs ?? raw.documentWorkerIntervalMs,
				1000,
				300000,
				d.documents.workerIntervalMs,
			),
			chunkSize: clampPositive(documentsRaw?.chunkSize ?? raw.documentChunkSize, 200, 50000, d.documents.chunkSize),
			chunkOverlap: clampPositive(
				documentsRaw?.chunkOverlap ?? raw.documentChunkOverlap,
				0,
				10000,
				d.documents.chunkOverlap,
			),
			maxContentBytes: clampPositive(
				documentsRaw?.maxContentBytes ?? raw.documentMaxContentBytes,
				1024,
				100 * 1024 * 1024,
				d.documents.maxContentBytes,
			),
		},

		guardrails: {
			maxContentChars: clampPositive(guardrailsRaw?.maxContentChars, 50, 100000, d.guardrails.maxContentChars),
			chunkTargetChars: clampPositive(guardrailsRaw?.chunkTargetChars, 50, 50000, d.guardrails.chunkTargetChars),
			recallTruncateChars: clampPositive(
				guardrailsRaw?.recallTruncateChars,
				50,
				100000,
				d.guardrails.recallTruncateChars,
			),
			contextBudgetChars: clampPositive(
				guardrailsRaw?.contextBudgetChars,
				200,
				100000,
				d.guardrails.contextBudgetChars,
			),
		},

		continuity: {
			enabled: resolveBool(continuityRaw?.enabled, undefined, d.continuity.enabled),
			promptInterval: clampPositive(continuityRaw?.promptInterval, 1, 1000, d.continuity.promptInterval),
			timeIntervalMs: clampPositive(continuityRaw?.timeIntervalMs, 60000, 3600000, d.continuity.timeIntervalMs),
			maxCheckpointsPerSession: clampPositive(
				continuityRaw?.maxCheckpointsPerSession,
				1,
				500,
				d.continuity.maxCheckpointsPerSession,
			),
			retentionDays: clampPositive(continuityRaw?.retentionDays, 1, 90, d.continuity.retentionDays),
			recoveryBudgetChars: clampPositive(
				continuityRaw?.recoveryBudgetChars,
				200,
				10000,
				d.continuity.recoveryBudgetChars,
			),
		},

		telemetryEnabled: typeof raw.telemetryEnabled === "boolean" ? raw.telemetryEnabled : d.telemetryEnabled,
		telemetry: {
			posthogHost: typeof telemetryRaw?.posthogHost === "string" ? telemetryRaw.posthogHost : d.telemetry.posthogHost,
			posthogApiKey:
				typeof telemetryRaw?.posthogApiKey === "string" ? telemetryRaw.posthogApiKey : d.telemetry.posthogApiKey,
			flushIntervalMs: clampPositive(telemetryRaw?.flushIntervalMs, 5000, 600000, d.telemetry.flushIntervalMs),
			flushBatchSize: clampPositive(telemetryRaw?.flushBatchSize, 1, 500, d.telemetry.flushBatchSize),
			retentionDays: clampPositive(telemetryRaw?.retentionDays, 1, 365, d.telemetry.retentionDays),
		},

		embeddingTracker: {
			enabled: resolveBool(embeddingTrackerRaw?.enabled, undefined, d.embeddingTracker.enabled),
			pollMs: clampPositive(embeddingTrackerRaw?.pollMs, 1000, 60000, d.embeddingTracker.pollMs),
			batchSize: clampPositive(embeddingTrackerRaw?.batchSize, 1, 20, d.embeddingTracker.batchSize),
		},

		synthesis: {
			enabled: resolvedSynthesisEnabled,
			provider: resolvedSynthesisProvider,
			model: resolvedSynthesisModel,
			endpoint: resolvedSynthesisEndpoint,
			timeout: resolvedSynthesisTimeout,
			maxTokens: clampPositive(synthesisRaw?.maxTokens ?? synthesisRaw?.max_tokens, 1000, 32000, d.synthesis.maxTokens),
			idleGapMinutes: clampPositive(synthesisRaw?.idleGapMinutes, 1, 1440, d.synthesis.idleGapMinutes),
			structuredOutput: (() => {
				const candidate = synthesisRaw?.structuredOutput;
				if (typeof candidate === "boolean") return candidate;
				const extractionCandidate = extractionRaw?.structuredOutput;
				return typeof extractionCandidate === "boolean" ? extractionCandidate : undefined;
			})(),
			rateLimit: parseRateLimitConfig(synthesisRaw?.rateLimit),
		},
		procedural: {
			enabled: resolveBool(proceduralRaw?.enabled, undefined, d.procedural.enabled),
			decayRate: clampFraction(proceduralRaw?.decayRate, d.procedural.decayRate),
			minImportance: clampFraction(proceduralRaw?.minImportance, d.procedural.minImportance),
			importanceOnInstall: clampFraction(proceduralRaw?.importanceOnInstall, d.procedural.importanceOnInstall),
			enrichOnInstall: resolveBool(proceduralRaw?.enrichOnInstall, undefined, d.procedural.enrichOnInstall),
			enrichMinDescription: clampPositive(
				proceduralRaw?.enrichMinDescription,
				10,
				500,
				d.procedural.enrichMinDescription,
			),
			reconcileIntervalMs: clampPositive(
				proceduralRaw?.reconcileIntervalMs,
				10000,
				600000,
				d.procedural.reconcileIntervalMs,
			),
		},

		structural: {
			enabled: resolveBool(structuralRaw?.enabled, undefined, d.structural.enabled),
			classifyBatchSize: clampPositive(structuralRaw?.classifyBatchSize, 1, 20, d.structural.classifyBatchSize),
			dependencyBatchSize: clampPositive(structuralRaw?.dependencyBatchSize, 1, 10, d.structural.dependencyBatchSize),
			pollIntervalMs: clampPositive(structuralRaw?.pollIntervalMs, 2000, 120000, d.structural.pollIntervalMs),
			synthesisEnabled: resolveBool(structuralRaw?.synthesisEnabled, undefined, d.structural.synthesisEnabled),
			synthesisIntervalMs: clampPositive(
				structuralRaw?.synthesisIntervalMs,
				10000,
				600000,
				d.structural.synthesisIntervalMs,
			),
			synthesisTopEntities: clampPositive(
				structuralRaw?.synthesisTopEntities,
				5,
				100,
				d.structural.synthesisTopEntities,
			),
			synthesisMaxFacts: clampPositive(structuralRaw?.synthesisMaxFacts, 3, 50, d.structural.synthesisMaxFacts),
			synthesisMaxStallMs: clampNonNegative(
				structuralRaw?.synthesisMaxStallMs ??
					dependencySynthesisRaw?.maxStallMs ??
					dependencySynthesisRaw?.synthesisMaxStallMs,
				24 * 60 * 60_000,
				d.structural.synthesisMaxStallMs,
			),
			supersessionEnabled: resolveBool(structuralRaw?.supersessionEnabled, undefined, d.structural.supersessionEnabled),
			supersessionSweepEnabled: resolveBool(
				structuralRaw?.supersessionSweepEnabled,
				undefined,
				d.structural.supersessionSweepEnabled,
			),
			supersessionSemanticFallback: resolveBool(
				structuralRaw?.supersessionSemanticFallback,
				undefined,
				d.structural.supersessionSemanticFallback,
			),
			supersessionMinConfidence: clampPositive(
				structuralRaw?.supersessionMinConfidence,
				0.1,
				1.0,
				d.structural.supersessionMinConfidence,
			),
		},

		feedback: {
			enabled: resolveBool(feedbackRaw?.enabled, undefined, d.feedback.enabled),
			ftsWeightDelta: clampFraction(feedbackRaw?.ftsWeightDelta, d.feedback.ftsWeightDelta),
			maxAspectWeight: maxAW,
			minAspectWeight: validatedMinAW,
			decayEnabled: resolveBool(feedbackRaw?.decayEnabled, undefined, d.feedback.decayEnabled),
			decayRate: clampFraction(feedbackRaw?.decayRate, d.feedback.decayRate),
			staleDays: clampPositive(feedbackRaw?.staleDays, 1, 365, d.feedback.staleDays),
			decayIntervalSessions: clampPositive(
				feedbackRaw?.decayIntervalSessions,
				1,
				1000,
				d.feedback.decayIntervalSessions,
			),
		},

		significance: {
			enabled: resolveBool(significanceRaw?.enabled, undefined, d.significance?.enabled ?? true),
			minTurns: clampPositive(significanceRaw?.minTurns, 1, 100, d.significance?.minTurns ?? 5),
			minEntityOverlap: clampPositive(significanceRaw?.minEntityOverlap, 0, 100, d.significance?.minEntityOverlap ?? 1),
			noveltyThreshold: clampFraction(significanceRaw?.noveltyThreshold, d.significance?.noveltyThreshold ?? 0.15),
		},
		writeGate: {
			enabled: resolveBool(writeGateRaw?.enabled, raw.writeGateEnabled, d.writeGate?.enabled ?? true),
			threshold: clampFraction(writeGateRaw?.threshold ?? raw.writeGateThreshold, d.writeGate?.threshold ?? 0.4),
			continuityDiscount: clampFraction(
				writeGateRaw?.continuityDiscount ?? raw.writeGateContinuityDiscount,
				d.writeGate?.continuityDiscount ?? 0.15,
			),
		},

		predictor: {
			enabled: resolveBool(predictorRaw?.enabled, undefined, d.predictor?.enabled ?? true),
			trainIntervalSessions: clampPositive(
				predictorRaw?.trainIntervalSessions,
				1,
				1000,
				d.predictor?.trainIntervalSessions ?? 10,
			),
			minTrainingSessions: clampPositive(
				predictorRaw?.minTrainingSessions,
				1,
				1000,
				d.predictor?.minTrainingSessions ?? 10,
			),
			scoreTimeoutMs: clampPositive(predictorRaw?.scoreTimeoutMs, 10, 10000, d.predictor?.scoreTimeoutMs ?? 120),
			trainTimeoutMs: clampPositive(predictorRaw?.trainTimeoutMs, 1000, 120000, d.predictor?.trainTimeoutMs ?? 30000),
			crashDisableThreshold: clampPositive(
				predictorRaw?.crashDisableThreshold,
				1,
				20,
				d.predictor?.crashDisableThreshold ?? 3,
			),
			rrfK: clampPositive(predictorRaw?.rrfK, 1, 100, d.predictor?.rrfK ?? 12),
			explorationRate: clampFraction(predictorRaw?.explorationRate, d.predictor?.explorationRate ?? 0.05),
			driftResetWindow: clampPositive(predictorRaw?.driftResetWindow, 1, 100, d.predictor?.driftResetWindow ?? 10),
			binaryPath: typeof predictorRaw?.binaryPath === "string" ? predictorRaw.binaryPath : d.predictor?.binaryPath,
			checkpointPath:
				typeof predictorRaw?.checkpointPath === "string" ? predictorRaw.checkpointPath : d.predictor?.checkpointPath,
		},

		predictorPipeline: {
			agentFeedback: resolveBool(predictorPipelineRaw?.agentFeedback, undefined, d.predictorPipeline.agentFeedback),
			trainingTelemetry: resolveBool(
				predictorPipelineRaw?.trainingTelemetry,
				undefined,
				d.predictorPipeline.trainingTelemetry,
			),
		},

		modelRegistry: {
			enabled: resolveBool(modelRegistryRaw?.enabled, undefined, d.modelRegistry.enabled),
			refreshIntervalMs: clampPositive(
				modelRegistryRaw?.refreshIntervalMs,
				60000,
				86400000,
				d.modelRegistry.refreshIntervalMs,
			),
		},

		hints: {
			enabled: resolveBool(hintsRaw?.enabled, undefined, d.hints?.enabled ?? true),
			max: clampPositive(hintsRaw?.max, 1, 10, d.hints?.max ?? 5),
			timeout: clampPositive(hintsRaw?.timeout, 5000, 120000, d.hints?.timeout ?? 60000),
			maxTokens: clampPositive(hintsRaw?.maxTokens, 64, 1024, d.hints?.maxTokens ?? 256),
			poll: clampPositive(hintsRaw?.poll, 1000, 60000, d.hints?.poll ?? 5000),
		},
	};
}

function clampWarn(field: string, raw: unknown, min: number, max: number, fallback: number): number {
	if (typeof raw !== "number" || !Number.isFinite(raw)) return fallback;
	const clamped = Math.max(min, Math.min(max, raw));
	if (clamped !== raw) {
		logger.warn("config", `dreaming.${field} out of range [${min}, ${max}]: ${raw} → clamped to ${clamped}`);
	}
	return clamped;
}

export function loadDreamingConfig(yaml: Record<string, unknown>): DreamingConfig {
	const mem = yaml.memory as Record<string, unknown> | undefined;
	const raw = mem?.dreaming as Record<string, unknown> | undefined;
	if (!raw) return { ...DEFAULT_DREAMING };
	const dd = DEFAULT_DREAMING;
	return {
		enabled: typeof raw.enabled === "boolean" ? raw.enabled : dd.enabled,
		tokenThreshold: clampWarn("tokenThreshold", raw.tokenThreshold, 10_000, 1_000_000, dd.tokenThreshold),
		timeout: clampWarn("timeout", raw.timeout, 30_000, 600_000, dd.timeout),
		maxInputTokens: clampWarn("maxInputTokens", raw.maxInputTokens, 8_000, 1_000_000, dd.maxInputTokens),
		maxOutputTokens: clampWarn("maxOutputTokens", raw.maxOutputTokens, 1_000, 128_000, dd.maxOutputTokens),
		backfillOnFirstRun: typeof raw.backfillOnFirstRun === "boolean" ? raw.backfillOnFirstRun : dd.backfillOnFirstRun,
	};
}

export function loadMemoryConfig(agentsDir: string): ResolvedMemoryConfig {
	const defaults: ResolvedMemoryConfig = {
		embedding: {
			provider: "native",
			model: "nomic-embed-text-v1.5",
			dimensions: 768,
			base_url: "",
		},
		search: {
			alpha: 0.7,
			top_k: 20,
			min_score: 0.1,
			rehearsal_enabled: true,
			rehearsal_weight: 0.1,
			rehearsal_half_life_days: 30,
		},
		pipelineV2: { ...DEFAULT_PIPELINE_V2 },
		dreaming: { ...DEFAULT_DREAMING },
		auth: parseAuthConfig(undefined, agentsDir),
	};

	const paths = [join(agentsDir, "agent.yaml"), join(agentsDir, "AGENT.yaml"), join(agentsDir, "config.yaml")];

	for (const path of paths) {
		if (!existsSync(path)) continue;
		try {
			const yaml = parseSimpleYaml(readFileSync(path, "utf-8"));
			const emb =
				(yaml.embedding as Record<string, unknown> | undefined) ??
				((yaml.memory as Record<string, unknown> | undefined)?.embeddings as Record<string, unknown> | undefined) ??
				(yaml.embeddings as Record<string, unknown> | undefined) ??
				{};
			const srch = (yaml.search as Record<string, unknown> | undefined) ?? {};

			if (emb.provider === "none") {
				defaults.embedding.provider = "none";
			} else if (emb.provider) {
				const rawProvider = String(emb.provider);
				defaults.embedding.provider =
					rawProvider === "local" ? "native" : (rawProvider as "native" | "llama-cpp" | "ollama" | "openai");
				defaults.embedding.model = (emb.model as string | undefined) ?? defaults.embedding.model;
				defaults.embedding.dimensions = Number.parseInt(String(emb.dimensions ?? "768"), 10);
				const explicitBaseUrl =
					(typeof emb.base_url === "string" ? emb.base_url : undefined) ??
					(typeof emb.endpoint === "string" ? emb.endpoint : undefined);
				if (defaults.embedding.provider === "ollama") {
					defaults.embedding.base_url =
						typeof explicitBaseUrl === "string" && explicitBaseUrl.trim().length > 0
							? explicitBaseUrl
							: DEFAULT_OLLAMA_BASE_URL;
				} else if (defaults.embedding.provider === "llama-cpp") {
					defaults.embedding.base_url =
						typeof explicitBaseUrl === "string" && explicitBaseUrl.trim().length > 0
							? explicitBaseUrl
							: DEFAULT_LLAMACPP_BASE_URL;
				} else if (defaults.embedding.provider === "openai") {
					defaults.embedding.base_url =
						typeof explicitBaseUrl === "string" && explicitBaseUrl.trim().length > 0
							? explicitBaseUrl
							: DEFAULT_OPENAI_BASE_URL;
				} else {
					defaults.embedding.base_url = explicitBaseUrl ?? defaults.embedding.base_url;
				}
				defaults.embedding.api_key = emb.api_key as string | undefined;
			}

			if (srch.alpha !== undefined) {
				defaults.search.alpha = Number.parseFloat(String(srch.alpha));
				defaults.search.top_k = Number.parseInt(String(srch.top_k ?? "20"), 10);
				defaults.search.min_score = Number.parseFloat(String(srch.min_score ?? "0.3"));
			}
			if (srch.rehearsal_enabled !== undefined) {
				defaults.search.rehearsal_enabled = srch.rehearsal_enabled === true;
			}
			if (typeof srch.rehearsal_weight === "number") {
				defaults.search.rehearsal_weight = Math.max(0, Math.min(1, srch.rehearsal_weight));
			}
			if (typeof srch.rehearsal_half_life_days === "number") {
				defaults.search.rehearsal_half_life_days = Math.max(1, srch.rehearsal_half_life_days);
			}

			defaults.pipelineV2 = loadPipelineConfig(yaml);
			defaults.dreaming = loadDreamingConfig(yaml);
			defaults.auth = parseAuthConfig(yaml.auth, agentsDir);

			break;
		} catch (error) {
			if (error instanceof MemoryConfigValidationError || error instanceof PipelineConfigValidationError) {
				throw error;
			}
			// ignore parse errors, try next file
		}
	}

	return defaults;
}
