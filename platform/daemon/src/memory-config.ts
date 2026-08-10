import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	DEFAULT_PIPELINE_TIMEOUT_MS,
	DEFAULT_PROVIDER_RATE_LIMIT,
	DEFAULT_TELEMETRY_FLUSH_BATCH_SIZE,
	DEFAULT_TELEMETRY_FLUSH_INTERVAL_MS,
	DEFAULT_TELEMETRY_POSTHOG_API_KEY,
	DEFAULT_TELEMETRY_POSTHOG_HOST,
	type DreamingConfig,
	PIPELINE_FLAGS,
	type PipelineFlag,
	type PipelineV2Config,
	TELEMETRY_DEPLOYMENT_ROLES,
	TELEMETRY_INSTALL_CHANNELS,
	parseSimpleYaml,
} from "@signet/core";
import { type AuthConfig, parseAuthConfig } from "./auth";
import type { EmbeddingCostProvider, EmbeddingCostRates } from "./embedding-cost";
import { logger } from "./logger";

export interface EmbeddingConfig {
	provider: "native" | "llama-cpp" | "ollama" | "openai" | "none";
	model: string;
	dimensions: number;
	base_url: string;
	/** USD per million input tokens, keyed by billing provider. */
	costRates?: EmbeddingCostRates;
	/** Internal retrieval formatting contract. Omitted means legacy raw text until a generation migration promotes a profile. */
	profile?: string;
	/** Internal marker: only the migration worker may bypass active resolution. */
	indexGeneration?: "staging";
	api_key?: string;
	promptSubmitTimeoutMs?: number;
	llamaCppMaxInputTokens?: number;
	/**
	 * Kill-switch for the native ONNX path (#1073). When false, the daemon
	 * never warms or routes to native even if the active embedding profile is
	 * native — callers fall through to the llama.cpp/ollama fallback chain.
	 * Defaults to true (native allowed). Set via config `embedding.warmNative`
	 * or env `SIGNET_EMBEDDING_WARM_NATIVE`.
	 */
	warmNative?: boolean;
}

export interface MemorySearchConfig {
	alpha: number;
	top_k: number;
	min_score: number;
	rehearsal_enabled: boolean;
	rehearsal_weight: number;
	rehearsal_half_life_days: number;
	temporal_prior_enabled: boolean;
	temporal_prior_weight: number;
	temporal_prior_half_life_days: number;
}

export { PIPELINE_FLAGS };
export type { PipelineFlag, PipelineV2Config, DreamingConfig };

/** IANA timezone of the machine the daemon runs on. Falls back to UTC on any failure. */
export function detectLocalTimeZone(): string {
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
	} catch {
		return "UTC";
	}
}

function isValidTimeZone(timeZone: string): boolean {
	try {
		new Intl.DateTimeFormat("en-US", { timeZone });
		return true;
	} catch {
		return false;
	}
}

const DEFAULT_DREAMING_SURPRISAL = {
	enabled: false,
	sampleSize: 128,
	maxCandidates: 5,
	minObservations: 20,
	neighborCount: 5,
	treeLeafSize: 10,
	minScore: 0.75,
} as const;

export const DEFAULT_DREAMING: DreamingConfig = {
	tokenThreshold: 100_000,
	maxInterval: 6 * 60 * 60 * 1_000,
	timeout: 20 * 60 * 1_000, // 20 minutes
	maxInputTokens: 128_000,
	maxOutputTokens: 16_000,
	backfillOnFirstRun: true,
	surprisal: DEFAULT_DREAMING_SURPRISAL,
};

class PipelineConfigValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PipelineConfigValidationError";
	}
}

export type ResolvedPipelineV2Config = Omit<PipelineV2Config, "guardrails"> & {
	readonly guardrails: Omit<PipelineV2Config["guardrails"], "contextBudgetChars"> & {
		readonly contextBudgetChars: number;
	};
};

export const DEFAULT_PIPELINE_V2: ResolvedPipelineV2Config = {
	enabled: true,
	paused: false,
	shadowMode: false,
	mutationsFrozen: false,
	semanticContradictionEnabled: true,
	semanticContradictionTimeoutMs: 120000,
	extraction: {
		strength: "low",
		timeout: DEFAULT_PIPELINE_TIMEOUT_MS,
		minConfidence: 0.7,
	},
	worker: {
		maxRetries: 3,
		leaseTimeoutMs: 300000,
		maxLlmConcurrency: 2,
	},
	claudeCode: {
		allowApiKeyEnv: false,
		cooldownMs: 300000,
	},
	graph: {
		enabled: true,
		boostWeight: 0.15,
		boostTimeoutMs: 500,
	},
	traversal: {
		enabled: true,
		primary: true,
		maxAspectsPerEntity: 20,
		maxAttributesPerAspect: 50,
		maxWriteAspectsPerEntity: 20,
		maxWriteAttributesPerAspect: 50,
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
		allowUpdateDelete: false,
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
	subagents: {
		inheritContext: true,
		tailChars: 3000,
	},
	telemetryEnabled: true,
	telemetry: {
		// PostHog cloud (US). On by default so Signet can understand how it
		// runs in the wild; set telemetryEnabled: false to opt out. Sends
		// only when both host and api key are configured. The project API
		// key is a public ingest key (PostHog design); it is not a secret.
		posthogHost: DEFAULT_TELEMETRY_POSTHOG_HOST,
		posthogApiKey: DEFAULT_TELEMETRY_POSTHOG_API_KEY,
		flushIntervalMs: DEFAULT_TELEMETRY_FLUSH_INTERVAL_MS,
		flushBatchSize: DEFAULT_TELEMETRY_FLUSH_BATCH_SIZE,
		retentionDays: 90,
		memorySearchQaEnabled: false,
		deploymentRole: "unknown",
		installChannel: "unknown",
	},
	embeddingTracker: {
		enabled: true,
		pollMs: 5000,
		batchSize: 8,
	},
	procedural: {
		enabled: true,
		decayRate: 0.99,
		minImportance: 0.3,
		importanceOnInstall: 0.7,
		reconcileIntervalMs: 60000,
	},
	feedback: {
		enabled: true,
		ftsWeightDelta: 0.02,
		maxAspectWeight: 1.0,
		minAspectWeight: 0.1,
		decayEnabled: false,
		decayRate: 0,
		staleDays: 14,
		decayIntervalSessions: 10,
	},
	significance: {
		enabled: true,
		minTurns: 5,
		minEntityOverlap: 1,
		noveltyThreshold: 0.15,
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
	reflections: {
		enabled: true,
		model: "qwen3:4b",
		timeout: 120000,
		maxTokens: 4000,
		schedule: "0 6 * * *",
		timezone: detectLocalTimeZone(),
		count: 3,
		timeWindowHours: 24,
		maxMemories: 50,
		maxSummaries: 10,
	},
};

export const DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434";
export const DEFAULT_LLAMACPP_BASE_URL = "http://localhost:8080";
export const DEFAULT_LLAMACPP_MAX_INPUT_TOKENS = 1400;
export const MIN_LLAMACPP_MAX_INPUT_TOKENS = 128;
export const MAX_LLAMACPP_MAX_INPUT_TOKENS = 131072;
export const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
export const DEFAULT_PROMPT_SUBMIT_EMBEDDING_TIMEOUT_MS = 1000;
export const MIN_PROMPT_SUBMIT_EMBEDDING_TIMEOUT_MS = 1000;
export const MAX_PROMPT_SUBMIT_EMBEDDING_TIMEOUT_MS = 300000;

export interface ResolvedMemoryConfig {
	embedding: EmbeddingConfig;
	search: MemorySearchConfig;
	pipelineV2: ResolvedPipelineV2Config;
	dreaming: DreamingConfig;
	auth: AuthConfig;
}

class MemoryConfigValidationError extends Error {}

function clampPositive(raw: unknown, min: number, max: number, fallback: number): number {
	if (typeof raw !== "number" || !Number.isFinite(raw)) return fallback;
	// Bounds are inclusive; a few config fields intentionally use 0 as a disable sentinel.
	return Math.max(min, Math.min(max, raw));
}

function resolveTelemetryValue<T extends string>(raw: unknown, allowed: readonly T[], fallback: T): T {
	if (typeof raw !== "string") return fallback;
	const normalized = raw.trim().toLowerCase();
	return (allowed as readonly string[]).includes(normalized) ? (normalized as T) : fallback;
}

function clampNonNegative(raw: unknown, max: number, fallback: number): number {
	if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) return fallback;
	return Math.min(max, raw);
}

function parseOptionalPositive(raw: unknown, min: number, max: number): number | undefined {
	if (typeof raw !== "number" || !Number.isFinite(raw)) return undefined;
	return Math.max(min, Math.min(max, raw));
}

const EMBEDDING_COST_PROVIDERS: readonly EmbeddingCostProvider[] = [
	"native",
	"llama-cpp",
	"ollama",
	"openai",
	"openrouter",
];

function parseEmbeddingCostRates(raw: unknown): EmbeddingCostRates | undefined {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const source = raw as Record<string, unknown>;
	const rates: Partial<Record<EmbeddingCostProvider, number>> = {};
	for (const provider of EMBEDDING_COST_PROVIDERS) {
		const value = source[provider];
		if (typeof value === "number" && Number.isFinite(value) && value >= 0) rates[provider] = value;
	}
	return Object.keys(rates).length > 0 ? rates : undefined;
}

function clampFraction(raw: unknown, fallback: number): number {
	if (typeof raw !== "number" || !Number.isFinite(raw)) return fallback;
	return Math.max(0, Math.min(1, raw));
}

function isExtractionStrength(v: unknown): v is "low" | "medium" | "high" {
	return typeof v === "string" && ["low", "medium", "high"].includes(v);
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

function resolveMaxLlmConcurrency(rawValue: unknown, defaultValue: number): number {
	const env = process.env.SIGNET_MAX_LLM_CONCURRENCY;
	const candidate: unknown = env !== undefined ? Number(env) : rawValue;
	const isValidCandidate = typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate >= 1;
	if (env !== undefined && !isValidCandidate) {
		logger.warn("pipeline", "SIGNET_MAX_LLM_CONCURRENCY is not a valid positive integer, using config/default", {
			value: env,
		});
		return clampPositive(rawValue, 1, 16, defaultValue);
	}
	return clampPositive(candidate, 1, 16, defaultValue);
}

/** Parse a boolean env override ("1"/"true"/"yes" vs "0"/"false"/"no"). */
function envBool(name: string): boolean | undefined {
	const value = process.env[name];
	if (value === undefined) return undefined;
	const normalized = value.trim().toLowerCase();
	if (["1", "true", "yes", "on"].includes(normalized)) return true;
	if (["0", "false", "no", "off"].includes(normalized)) return false;
	return undefined;
}

function parseClaudeCodeConfig(raw: unknown, fallback: PipelineV2Config["claudeCode"]): PipelineV2Config["claudeCode"] {
	if (!isRecord(raw)) return fallback;
	const allowApiKeyEnv =
		typeof raw.allowApiKeyEnv === "boolean"
			? raw.allowApiKeyEnv
			: raw.billingMode === "api-key"
				? true
				: raw.billingMode === "subscription"
					? false
					: fallback.allowApiKeyEnv;
	const maxBudgetUsd = parseOptionalPositive(raw.maxBudgetUsd, 0.01, 1000);
	const cooldownMs = clampPositive(raw.cooldownMs, 1000, 3600000, fallback.cooldownMs);
	return {
		allowApiKeyEnv,
		...(maxBudgetUsd !== undefined ? { maxBudgetUsd } : {}),
		cooldownMs,
	};
}

/**
 * Load pipeline config from YAML, supporting both nested and flat key formats.
 * Flat extraction keys (dashboard-written) take precedence over nested keys.
 * Provider and model are paired — if flat provider wins, flat model wins too.
 */
export function loadPipelineConfig(yaml: Record<string, unknown>): ResolvedPipelineV2Config {
	const mem = yaml.memory as Record<string, unknown> | undefined;
	const raw = mem?.pipelineV2 as Record<string, unknown> | undefined;
	if (mem?.synthesis !== undefined) {
		throw new PipelineConfigValidationError(
			"memory.synthesis is retired; MEMORY.md synthesis follows the canonical inference workload instead.",
		);
	}
	if (!raw) return { ...DEFAULT_PIPELINE_V2 };

	// Read nested sub-objects (may be undefined for old flat configs)
	const extractionRaw = raw.extraction as Record<string, unknown> | undefined;
	const workerRaw = raw.worker as Record<string, unknown> | undefined;
	const claudeCodeRaw = raw.claudeCode as Record<string, unknown> | undefined;
	const graphRaw = raw.graph as Record<string, unknown> | undefined;
	const traversalRaw = raw.traversal as Record<string, unknown> | undefined;
	const rerankerRaw = raw.reranker as Record<string, unknown> | undefined;
	const autonomousRaw = raw.autonomous as Record<string, unknown> | undefined;
	const repairRaw = raw.repair as Record<string, unknown> | undefined;
	const documentsRaw = raw.documents as Record<string, unknown> | undefined;
	const guardrailsRaw = raw.guardrails as Record<string, unknown> | undefined;
	const telemetryRaw = raw.telemetry as Record<string, unknown> | undefined;
	const continuityRaw = raw.continuity as Record<string, unknown> | undefined;
	const subagentsRaw = raw.subagents as Record<string, unknown> | undefined;
	const embeddingTrackerRaw = raw.embeddingTracker as Record<string, unknown> | undefined;
	const synthesisValue = raw.synthesis;
	const synthesisRaw = isRecord(synthesisValue) ? synthesisValue : undefined;
	const proceduralRaw = raw.procedural as Record<string, unknown> | undefined;
	const feedbackRaw = raw.feedback as Record<string, unknown> | undefined;
	const significanceRaw = raw.significance as Record<string, unknown> | undefined;
	const modelRegistryRaw = raw.modelRegistry as Record<string, unknown> | undefined;
	const hintsRaw = raw.hints as Record<string, unknown> | undefined;
	const reflectionsRaw = raw.reflections as Record<string, unknown> | undefined;

	// Helper: resolve with flat-fallback (non-extraction fields still nested-first)
	const d = DEFAULT_PIPELINE_V2;

	function resolveBool(nested: unknown, flat: unknown, fallback: boolean): boolean {
		if (typeof nested === "boolean") return nested;
		if (typeof flat === "boolean") return flat;
		return fallback;
	}

	// Provider and model selection belongs to inference.workloads. Keep the
	// legacy keys as a loud error instead of allowing a stale config to select a
	// local fallback with an unrelated model (#1266, #1267).
	const legacyRoutingKeys = [
		["memory.pipelineV2.extractionProvider", raw.extractionProvider],
		["memory.pipelineV2.extractionModel", raw.extractionModel],
		["memory.pipelineV2.extractionEndpoint", raw.extractionEndpoint],
		["memory.pipelineV2.extractionBaseUrl", raw.extractionBaseUrl],
		["memory.pipelineV2.extractionFallbackProvider", raw.extractionFallbackProvider],
		["memory.pipelineV2.allowRemoteProviders", raw.allowRemoteProviders],
		["memory.pipelineV2.extraction.provider", extractionRaw?.provider],
		["memory.pipelineV2.extraction.model", extractionRaw?.model],
		["memory.pipelineV2.extraction.endpoint", extractionRaw?.endpoint],
		["memory.pipelineV2.extraction.base_url", extractionRaw?.base_url],
		["memory.pipelineV2.extraction.baseUrl", extractionRaw?.baseUrl],
		["memory.pipelineV2.extraction.fallbackProvider", extractionRaw?.fallbackProvider],
		["memory.pipelineV2.extraction.allowRemoteProviders", extractionRaw?.allowRemoteProviders],
		["memory.pipelineV2.synthesis.provider", synthesisRaw?.provider],
		["memory.pipelineV2.synthesis.model", synthesisRaw?.model],
		["memory.pipelineV2.synthesis.endpoint", synthesisRaw?.endpoint],
		["memory.pipelineV2.synthesis.base_url", synthesisRaw?.base_url],
		["memory.pipelineV2.synthesis.baseUrl", synthesisRaw?.baseUrl],
	];
	const legacyRoutingKey = legacyRoutingKeys.find(([, value]) => value !== undefined);
	if (legacyRoutingKey) {
		throw new PipelineConfigValidationError(
			`${legacyRoutingKey[0]} is retired; configure the canonical inference workload instead.`,
		);
	}
	if (extractionRaw?.command !== undefined || raw.extractionCommand !== undefined) {
		throw new PipelineConfigValidationError(
			"memory.pipelineV2.extraction command configuration is retired; configure the canonical inference workload instead.",
		);
	}
	if (synthesisValue !== undefined) {
		throw new PipelineConfigValidationError(
			"memory.pipelineV2.synthesis is retired; configure the canonical inference workload instead.",
		);
	}
	if (
		raw.writeGate !== undefined ||
		raw.durability !== undefined ||
		raw.writeGateEnabled !== undefined ||
		raw.writeGateThreshold !== undefined ||
		raw.writeGateContinuityDiscount !== undefined
	) {
		throw new PipelineConfigValidationError(
			"memory.pipelineV2.writeGate and durability configuration is retired; Dreaming is the sole semantic writer.",
		);
	}
	if (proceduralRaw?.enrichOnInstall !== undefined || proceduralRaw?.enrichMinDescription !== undefined) {
		throw new PipelineConfigValidationError(
			"memory.pipelineV2.procedural enrichment configuration is retired; skill frontmatter is used as authored.",
		);
	}

	const resolvedTimeout = clampPositive(
		extractionRaw?.timeout ?? raw.extractionTimeout,
		5000,
		300000,
		d.extraction.timeout,
	);

	// Normalize aspect weights: clamp independently, then enforce min <= max
	const maxAW = clampFraction(feedbackRaw?.maxAspectWeight, d.feedback.maxAspectWeight);
	const minAW = clampFraction(feedbackRaw?.minAspectWeight, d.feedback.minAspectWeight);
	const validatedMinAW = minAW > maxAW ? maxAW : minAW;

	return {
		enabled: typeof raw.enabled === "boolean" ? raw.enabled : d.enabled,
		paused: typeof raw.paused === "boolean" ? raw.paused : d.paused,
		shadowMode: typeof raw.shadowMode === "boolean" ? raw.shadowMode : d.shadowMode,
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
			strength: (() => {
				// Flat keys win when set (dashboard writes these); nested is fallback
				const candidate = raw.extractionStrength ?? extractionRaw?.strength;
				return isExtractionStrength(candidate) ? candidate : d.extraction.strength;
			})(),
			timeout: resolvedTimeout,
			minConfidence: clampFraction(
				extractionRaw?.minConfidence ?? raw.minFactConfidenceForWrite,
				d.extraction.minConfidence,
			),
			rateLimit: parseRateLimitConfig(extractionRaw?.rateLimit),
			structuredOutput: (() => {
				const candidate = extractionRaw?.structuredOutput;
				return typeof candidate === "boolean" ? candidate : undefined;
			})(),
		},

		worker: {
			maxRetries: clampPositive(workerRaw?.maxRetries ?? raw.workerMaxRetries, 1, 10, d.worker.maxRetries),
			leaseTimeoutMs: clampPositive(
				workerRaw?.leaseTimeoutMs ?? raw.leaseTimeoutMs,
				10000,
				600000,
				d.worker.leaseTimeoutMs,
			),
			maxLlmConcurrency: resolveMaxLlmConcurrency(workerRaw?.maxLlmConcurrency, d.worker.maxLlmConcurrency),
		},
		claudeCode: parseClaudeCodeConfig(claudeCodeRaw, d.claudeCode),

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
				d.traversal?.maxAspectsPerEntity ?? 20,
			),
			maxAttributesPerAspect: clampPositive(
				traversalRaw?.maxAttributesPerAspect,
				1,
				200,
				d.traversal?.maxAttributesPerAspect ?? 50,
			),
			maxWriteAspectsPerEntity: clampPositive(
				traversalRaw?.maxWriteAspectsPerEntity,
				1,
				50,
				d.traversal?.maxWriteAspectsPerEntity ?? 20,
			),
			maxWriteAttributesPerAspect: clampPositive(
				traversalRaw?.maxWriteAttributesPerAspect,
				1,
				100,
				d.traversal?.maxWriteAttributesPerAspect ?? 50,
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
		subagents: {
			inheritContext: resolveBool(subagentsRaw?.inheritContext, undefined, d.subagents?.inheritContext ?? true),
			tailChars: clampNonNegative(subagentsRaw?.tailChars, 20000, d.subagents?.tailChars ?? 3000),
		},

		telemetryEnabled: typeof raw.telemetryEnabled === "boolean" ? raw.telemetryEnabled : d.telemetryEnabled,
		telemetry: {
			posthogHost: typeof telemetryRaw?.posthogHost === "string" ? telemetryRaw.posthogHost : d.telemetry.posthogHost,
			posthogApiKey:
				typeof telemetryRaw?.posthogApiKey === "string" ? telemetryRaw.posthogApiKey : d.telemetry.posthogApiKey,
			flushIntervalMs: clampPositive(telemetryRaw?.flushIntervalMs, 5000, 600000, d.telemetry.flushIntervalMs),
			flushBatchSize: clampPositive(telemetryRaw?.flushBatchSize, 1, 500, d.telemetry.flushBatchSize),
			retentionDays: clampPositive(telemetryRaw?.retentionDays, 1, 365, d.telemetry.retentionDays),
			memorySearchQaEnabled: resolveBool(
				telemetryRaw?.memorySearchQaEnabled,
				undefined,
				d.telemetry.memorySearchQaEnabled,
			),
			deploymentRole: resolveTelemetryValue(
				telemetryRaw?.deploymentRole,
				TELEMETRY_DEPLOYMENT_ROLES,
				d.telemetry.deploymentRole ?? "unknown",
			),
			installChannel: resolveTelemetryValue(
				telemetryRaw?.installChannel,
				TELEMETRY_INSTALL_CHANNELS,
				d.telemetry.installChannel ?? "unknown",
			),
		},

		embeddingTracker: {
			enabled: resolveBool(embeddingTrackerRaw?.enabled, undefined, d.embeddingTracker.enabled),
			pollMs: clampPositive(embeddingTrackerRaw?.pollMs, 1000, 60000, d.embeddingTracker.pollMs),
			batchSize: clampPositive(embeddingTrackerRaw?.batchSize, 1, 20, d.embeddingTracker.batchSize),
		},

		procedural: {
			enabled: resolveBool(proceduralRaw?.enabled, undefined, d.procedural.enabled),
			decayRate: clampFraction(proceduralRaw?.decayRate, d.procedural.decayRate),
			minImportance: clampFraction(proceduralRaw?.minImportance, d.procedural.minImportance),
			importanceOnInstall: clampFraction(proceduralRaw?.importanceOnInstall, d.procedural.importanceOnInstall),
			reconcileIntervalMs: clampPositive(
				proceduralRaw?.reconcileIntervalMs,
				10000,
				600000,
				d.procedural.reconcileIntervalMs,
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

		reflections: {
			enabled: resolveBool(reflectionsRaw?.enabled, undefined, d.reflections.enabled),
			model:
				typeof reflectionsRaw?.model === "string" && reflectionsRaw.model.trim().length > 0
					? reflectionsRaw.model
					: d.reflections.model,
			timeout: clampPositive(reflectionsRaw?.timeout, 5000, 300000, d.reflections.timeout),
			maxTokens: clampPositive(reflectionsRaw?.maxTokens, 500, 16000, d.reflections.maxTokens),
			schedule:
				typeof reflectionsRaw?.schedule === "string" && reflectionsRaw.schedule.trim().length > 0
					? reflectionsRaw.schedule
					: d.reflections.schedule,
			timezone:
				typeof reflectionsRaw?.timezone === "string" && isValidTimeZone(reflectionsRaw.timezone)
					? reflectionsRaw.timezone
					: d.reflections.timezone,
			count: clampPositive(reflectionsRaw?.count, 1, 6, d.reflections.count),
			timeWindowHours: clampPositive(reflectionsRaw?.timeWindowHours, 1, 168, d.reflections.timeWindowHours),
			maxMemories: clampPositive(reflectionsRaw?.maxMemories, 5, 500, d.reflections.maxMemories),
			maxSummaries: clampPositive(reflectionsRaw?.maxSummaries, 1, 50, d.reflections.maxSummaries),
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
	const defaultSurprisal = dd.surprisal ?? DEFAULT_DREAMING_SURPRISAL;
	const surprisal = raw.surprisal as Record<string, unknown> | undefined;
	return {
		tokenThreshold: clampWarn("tokenThreshold", raw.tokenThreshold, 10_000, 1_000_000, dd.tokenThreshold),
		maxInterval: clampWarn("maxInterval", raw.maxInterval, 5 * 60 * 1_000, 7 * 24 * 60 * 60 * 1_000, dd.maxInterval),
		timeout: clampWarn("timeout", raw.timeout, 30_000, 1_800_000, dd.timeout),
		maxInputTokens: clampWarn("maxInputTokens", raw.maxInputTokens, 8_000, 1_000_000, dd.maxInputTokens),
		maxOutputTokens: clampWarn("maxOutputTokens", raw.maxOutputTokens, 1_000, 128_000, dd.maxOutputTokens),
		backfillOnFirstRun: typeof raw.backfillOnFirstRun === "boolean" ? raw.backfillOnFirstRun : dd.backfillOnFirstRun,
		surprisal: {
			enabled: typeof surprisal?.enabled === "boolean" ? surprisal.enabled : defaultSurprisal.enabled,
			sampleSize: clampWarn("surprisal.sampleSize", surprisal?.sampleSize, 20, 500, defaultSurprisal.sampleSize),
			maxCandidates: clampWarn(
				"surprisal.maxCandidates",
				surprisal?.maxCandidates,
				1,
				20,
				defaultSurprisal.maxCandidates,
			),
			minObservations: clampWarn(
				"surprisal.minObservations",
				surprisal?.minObservations,
				8,
				500,
				defaultSurprisal.minObservations,
			),
			neighborCount: clampWarn(
				"surprisal.neighborCount",
				surprisal?.neighborCount,
				1,
				32,
				defaultSurprisal.neighborCount,
			),
			treeLeafSize: clampWarn("surprisal.treeLeafSize", surprisal?.treeLeafSize, 2, 64, defaultSurprisal.treeLeafSize),
			minScore: clampWarn("surprisal.minScore", surprisal?.minScore, 0, 1, defaultSurprisal.minScore),
		},
	};
}

/** Write-path graph caps from the traversal config, with defaults. */
export function graphWriteCaps(cfg: ResolvedMemoryConfig): {
	readonly maxAspectsPerEntity: number;
	readonly maxAttributesPerAspect: number;
} {
	const traversal = cfg.pipelineV2.traversal;
	return {
		maxAspectsPerEntity: traversal?.maxWriteAspectsPerEntity ?? 20,
		maxAttributesPerAspect: traversal?.maxWriteAttributesPerAspect ?? 50,
	};
}

export function loadMemoryConfig(agentsDir: string): ResolvedMemoryConfig {
	const defaults: ResolvedMemoryConfig = {
		embedding: {
			provider: "native",
			model: "nomic-embed-text-v1.5",
			dimensions: 768,
			base_url: "",
			promptSubmitTimeoutMs: DEFAULT_PROMPT_SUBMIT_EMBEDDING_TIMEOUT_MS,
			llamaCppMaxInputTokens: DEFAULT_LLAMACPP_MAX_INPUT_TOKENS,
			warmNative: true,
		},
		search: {
			alpha: 0.7,
			top_k: 20,
			min_score: 0.1,
			rehearsal_enabled: true,
			rehearsal_weight: 0.1,
			rehearsal_half_life_days: 30,
			// Default-on is deliberate for #903: explicit freshness language gets
			// only a bounded near-tie boost, while timeless and ranged queries skip it.
			temporal_prior_enabled: true,
			temporal_prior_weight: 0.15,
			temporal_prior_half_life_days: 14,
		},
		pipelineV2: { ...DEFAULT_PIPELINE_V2 },
		dreaming: { ...DEFAULT_DREAMING },
		auth: parseAuthConfig(undefined, agentsDir),
	};

	const paths = [join(agentsDir, "agent.yaml"), join(agentsDir, "AGENT.yaml"), join(agentsDir, "config.yaml")];
	const envWarmNative = envBool("SIGNET_EMBEDDING_WARM_NATIVE");

	for (const path of paths) {
		if (!existsSync(path)) continue;
		try {
			const yaml = parseSimpleYaml(readFileSync(path, "utf-8"));
			const emb =
				(yaml.embedding as Record<string, unknown> | undefined) ??
				((yaml.memory as Record<string, unknown> | undefined)?.embeddings as Record<string, unknown> | undefined) ??
				(yaml.embeddings as Record<string, unknown> | undefined) ??
				{};
			const configuredCostRates = parseEmbeddingCostRates(emb.costRates ?? emb.cost_rates);
			if (configuredCostRates) defaults.embedding.costRates = configuredCostRates;
			const srch = (yaml.search as Record<string, unknown> | undefined) ?? {};

			defaults.embedding.promptSubmitTimeoutMs = clampPositive(
				emb.promptSubmitTimeoutMs,
				MIN_PROMPT_SUBMIT_EMBEDDING_TIMEOUT_MS,
				MAX_PROMPT_SUBMIT_EMBEDDING_TIMEOUT_MS,
				defaults.embedding.promptSubmitTimeoutMs ?? DEFAULT_PROMPT_SUBMIT_EMBEDDING_TIMEOUT_MS,
			);
			defaults.embedding.llamaCppMaxInputTokens = clampPositive(
				emb.llamaCppMaxInputTokens,
				MIN_LLAMACPP_MAX_INPUT_TOKENS,
				MAX_LLAMACPP_MAX_INPUT_TOKENS,
				defaults.embedding.llamaCppMaxInputTokens ?? DEFAULT_LLAMACPP_MAX_INPUT_TOKENS,
			);
			if (typeof emb.warmNative === "boolean") {
				defaults.embedding.warmNative = emb.warmNative;
			}

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
			if (srch.temporal_prior_enabled !== undefined) {
				defaults.search.temporal_prior_enabled = srch.temporal_prior_enabled === true;
			}
			if (typeof srch.temporal_prior_weight === "number") {
				defaults.search.temporal_prior_weight = Math.max(0, Math.min(1, srch.temporal_prior_weight));
			}
			if (typeof srch.temporal_prior_half_life_days === "number") {
				defaults.search.temporal_prior_half_life_days = Math.max(1, Math.min(365, srch.temporal_prior_half_life_days));
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
	if (envWarmNative !== undefined) {
		defaults.embedding.warmNative = envWarmNative;
	}

	return defaults;
}
