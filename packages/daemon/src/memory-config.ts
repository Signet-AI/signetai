import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	parseSimpleYaml,
	PIPELINE_FLAGS,
	type PipelineFlag,
	type PipelineV2Config,
} from "@signet/core";
import { parseAuthConfig, type AuthConfig } from "./auth/config";

export interface EmbeddingConfig {
	provider: "native" | "ollama" | "openai" | "none";
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
export type { PipelineFlag, PipelineV2Config };

export const DEFAULT_PIPELINE_V2: PipelineV2Config = {
	enabled: true,
	shadowMode: false,
	mutationsFrozen: false,
	semanticContradictionEnabled: false,
	extraction: {
		provider: "claude-code",
		model: "haiku",
		timeout: 90000,
		minConfidence: 0.7,
	},
	worker: {
		pollMs: 2000,
		maxRetries: 3,
		leaseTimeoutMs: 300000,
	},
	graph: {
		enabled: true,
		boostWeight: 0.15,
		boostTimeoutMs: 500,
	},
	traversal: {
		enabled: true,
		maxAspectsPerEntity: 10,
		maxAttributesPerAspect: 20,
		maxDependencyHops: 30,
		minDependencyStrength: 0.3,
		timeoutMs: 500,
		boostWeight: 0.2,
		constraintBudgetChars: 1000,
	},
	reranker: {
		enabled: true,
		model: "",
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
		maxContentChars: 500,
		chunkTargetChars: 300,
		recallTruncateChars: 500,
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
		provider: "claude-code",
		model: "haiku",
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
	predictor: {
		enabled: false,
		trainIntervalSessions: 10,
		minTrainingSessions: 10,
		scoreTimeoutMs: 120,
		trainTimeoutMs: 30000,
		crashDisableThreshold: 3,
		rrfK: 12,
		explorationRate: 0.05,
		driftResetWindow: 10,
	},
};

export const DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434";
export const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";

export interface ResolvedMemoryConfig {
	embedding: EmbeddingConfig;
	search: MemorySearchConfig;
	pipelineV2: PipelineV2Config;
	auth: AuthConfig;
}

function clampPositive(
	raw: unknown,
	min: number,
	max: number,
	fallback: number,
): number {
	if (typeof raw !== "number" || !Number.isFinite(raw)) return fallback;
	return Math.max(min, Math.min(max, raw));
}

function clampFraction(raw: unknown, fallback: number): number {
	if (typeof raw !== "number" || !Number.isFinite(raw)) return fallback;
	return Math.max(0, Math.min(1, raw));
}

/**
 * Load pipeline config from YAML, supporting both nested and flat key formats.
 * Nested keys take precedence when both are present.
 */
export function loadPipelineConfig(
	yaml: Record<string, unknown>,
): PipelineV2Config {
	const mem = yaml.memory as Record<string, unknown> | undefined;
	const raw = mem?.pipelineV2 as Record<string, unknown> | undefined;
	if (!raw) return { ...DEFAULT_PIPELINE_V2 };

	// Read nested sub-objects (may be undefined for old flat configs)
	const extractionRaw = raw.extraction as Record<string, unknown> | undefined;
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
	const feedbackRaw = raw.feedback as Record<string, unknown> | undefined;
	const predictorRaw = raw.predictor as Record<string, unknown> | undefined;

	// Helper: resolve nested-first, flat-fallback
	const d = DEFAULT_PIPELINE_V2;

	function resolveBool(nested: unknown, flat: unknown, fallback: boolean): boolean {
		if (typeof nested === "boolean") return nested;
		if (typeof flat === "boolean") return flat;
		return fallback;
	}

	// -- Extraction provider resolution --
	// Nested wins; flat fallback preserves legacy ollama inference
	const nestedProvider = extractionRaw?.provider;
	const flatProvider = raw.extractionProvider;
	const flatModel = raw.extractionModel;
	const resolvedProvider: "ollama" | "claude-code" | "opencode" | "codex" =
		nestedProvider === "codex" || flatProvider === "codex"
			? "codex"
			: nestedProvider === "opencode" || flatProvider === "opencode"
			? "opencode"
			: nestedProvider === "claude-code" || flatProvider === "claude-code"
				? "claude-code"
				: nestedProvider === "ollama" || flatProvider === "ollama"
					? "ollama"
					: typeof (extractionRaw?.model ?? flatModel) === "string" &&
						  nestedProvider === undefined &&
						  flatProvider === undefined
						? "ollama"
						: d.extraction.provider;

	return {
		enabled: typeof raw.enabled === "boolean" ? raw.enabled : d.enabled,
		shadowMode: typeof raw.shadowMode === "boolean" ? raw.shadowMode : d.shadowMode,
		mutationsFrozen:
			typeof raw.mutationsFrozen === "boolean" ? raw.mutationsFrozen : d.mutationsFrozen,
		semanticContradictionEnabled:
			typeof raw.semanticContradictionEnabled === "boolean"
				? raw.semanticContradictionEnabled
				: d.semanticContradictionEnabled,

		extraction: {
			provider: resolvedProvider,
			model:
				typeof extractionRaw?.model === "string"
					? extractionRaw.model
					: typeof flatModel === "string"
						? (flatModel as string)
						: d.extraction.model,
			timeout: clampPositive(
				extractionRaw?.timeout ?? raw.extractionTimeout,
				5000,
				300000,
				d.extraction.timeout,
			),
			minConfidence: clampFraction(
				extractionRaw?.minConfidence ?? raw.minFactConfidenceForWrite,
				d.extraction.minConfidence,
			),
		},

		worker: {
			pollMs: clampPositive(
				workerRaw?.pollMs ?? raw.workerPollMs,
				100,
				60000,
				d.worker.pollMs,
			),
			maxRetries: clampPositive(
				workerRaw?.maxRetries ?? raw.workerMaxRetries,
				1,
				10,
				d.worker.maxRetries,
			),
			leaseTimeoutMs: clampPositive(
				workerRaw?.leaseTimeoutMs ?? raw.leaseTimeoutMs,
				10000,
				600000,
				d.worker.leaseTimeoutMs,
			),
		},

		graph: {
			enabled: resolveBool(graphRaw?.enabled, raw.graphEnabled, d.graph.enabled),
			boostWeight: clampFraction(
				graphRaw?.boostWeight ?? raw.graphBoostWeight,
				d.graph.boostWeight,
			),
			boostTimeoutMs: clampPositive(
				graphRaw?.boostTimeoutMs ?? raw.graphBoostTimeoutMs,
				50,
				5000,
				d.graph.boostTimeoutMs,
			),
		},

		traversal: {
			enabled: resolveBool(
				traversalRaw?.enabled, undefined, d.traversal?.enabled ?? true,
			),
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
			maxDependencyHops: clampPositive(
				traversalRaw?.maxDependencyHops,
				1,
				200,
				d.traversal?.maxDependencyHops ?? 30,
			),
			minDependencyStrength: clampFraction(
				traversalRaw?.minDependencyStrength,
				d.traversal?.minDependencyStrength ?? 0.3,
			),
			timeoutMs: clampPositive(
				traversalRaw?.timeoutMs,
				50,
				5000,
				d.traversal?.timeoutMs ?? 500,
			),
			boostWeight: clampFraction(
				traversalRaw?.boostWeight,
				d.traversal?.boostWeight ?? 0.2,
			),
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
			topN: clampPositive(
				rerankerRaw?.topN ?? raw.rerankerTopN,
				1,
				100,
				d.reranker.topN,
			),
			timeoutMs: clampPositive(
				rerankerRaw?.timeoutMs ?? raw.rerankerTimeoutMs,
				100,
				30000,
				d.reranker.timeoutMs,
			),
		},

		autonomous: {
			enabled: resolveBool(autonomousRaw?.enabled, raw.autonomousEnabled, d.autonomous.enabled),
			frozen: resolveBool(autonomousRaw?.frozen, raw.autonomousFrozen, d.autonomous.frozen),
			allowUpdateDelete: resolveBool(
				autonomousRaw?.allowUpdateDelete, raw.allowUpdateDelete, d.autonomous.allowUpdateDelete,
			),
			maintenanceIntervalMs: clampPositive(
				autonomousRaw?.maintenanceIntervalMs ??
					raw.maintenanceIntervalMs,
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
				repairRaw?.reembedHourlyBudget ??
					raw.repairReembedHourlyBudget,
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
				repairRaw?.requeueHourlyBudget ??
					raw.repairRequeueHourlyBudget,
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
				repairRaw?.dedupSemanticThreshold ??
					raw.repairDedupSemanticThreshold,
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
				documentsRaw?.workerIntervalMs ??
					raw.documentWorkerIntervalMs,
				1000,
				300000,
				d.documents.workerIntervalMs,
			),
			chunkSize: clampPositive(
				documentsRaw?.chunkSize ?? raw.documentChunkSize,
				200,
				50000,
				d.documents.chunkSize,
			),
			chunkOverlap: clampPositive(
				documentsRaw?.chunkOverlap ?? raw.documentChunkOverlap,
				0,
				10000,
				d.documents.chunkOverlap,
			),
			maxContentBytes: clampPositive(
				documentsRaw?.maxContentBytes ??
					raw.documentMaxContentBytes,
				1024,
				100 * 1024 * 1024,
				d.documents.maxContentBytes,
			),
		},

		guardrails: {
			maxContentChars: clampPositive(
				guardrailsRaw?.maxContentChars,
				50,
				100000,
				d.guardrails.maxContentChars,
			),
			chunkTargetChars: clampPositive(
				guardrailsRaw?.chunkTargetChars,
				50,
				50000,
				d.guardrails.chunkTargetChars,
			),
			recallTruncateChars: clampPositive(
				guardrailsRaw?.recallTruncateChars,
				50,
				100000,
				d.guardrails.recallTruncateChars,
			),
		},

		continuity: {
			enabled: resolveBool(continuityRaw?.enabled, undefined, d.continuity.enabled),
			promptInterval: clampPositive(
				continuityRaw?.promptInterval,
				1,
				1000,
				d.continuity.promptInterval,
			),
			timeIntervalMs: clampPositive(
				continuityRaw?.timeIntervalMs,
				60000,
				3600000,
				d.continuity.timeIntervalMs,
			),
			maxCheckpointsPerSession: clampPositive(
				continuityRaw?.maxCheckpointsPerSession,
				1,
				500,
				d.continuity.maxCheckpointsPerSession,
			),
			retentionDays: clampPositive(
				continuityRaw?.retentionDays,
				1,
				90,
				d.continuity.retentionDays,
			),
			recoveryBudgetChars: clampPositive(
				continuityRaw?.recoveryBudgetChars,
				200,
				10000,
				d.continuity.recoveryBudgetChars,
			),
		},

		telemetryEnabled:
			typeof raw.telemetryEnabled === "boolean" ? raw.telemetryEnabled : d.telemetryEnabled,
		telemetry: {
			posthogHost:
				typeof telemetryRaw?.posthogHost === "string"
					? telemetryRaw.posthogHost
					: d.telemetry.posthogHost,
			posthogApiKey:
				typeof telemetryRaw?.posthogApiKey === "string"
					? telemetryRaw.posthogApiKey
					: d.telemetry.posthogApiKey,
			flushIntervalMs: clampPositive(
				telemetryRaw?.flushIntervalMs,
				5000,
				600000,
				d.telemetry.flushIntervalMs,
			),
			flushBatchSize: clampPositive(
				telemetryRaw?.flushBatchSize,
				1,
				500,
				d.telemetry.flushBatchSize,
			),
			retentionDays: clampPositive(
				telemetryRaw?.retentionDays,
				1,
				365,
				d.telemetry.retentionDays,
			),
		},

		embeddingTracker: {
			enabled: resolveBool(
				embeddingTrackerRaw?.enabled, undefined, d.embeddingTracker.enabled,
			),
			pollMs: clampPositive(
				embeddingTrackerRaw?.pollMs,
				1000,
				60000,
				d.embeddingTracker.pollMs,
			),
			batchSize: clampPositive(
				embeddingTrackerRaw?.batchSize,
				1,
				20,
				d.embeddingTracker.batchSize,
			),
		},

		synthesis: {
			enabled: resolveBool(synthesisRaw?.enabled, undefined, d.synthesis.enabled),
			provider: (() => {
				const p = synthesisRaw?.provider;
				if (p === "ollama" || p === "claude-code" || p === "opencode") return p;
				return d.synthesis.provider;
			})(),
			model:
				typeof synthesisRaw?.model === "string"
					? synthesisRaw.model
					: d.synthesis.model,
			timeout: clampPositive(
				synthesisRaw?.timeout,
				5000,
				300000,
				d.synthesis.timeout,
			),
			maxTokens: clampPositive(
				synthesisRaw?.maxTokens ?? synthesisRaw?.max_tokens,
				1000,
				32000,
				d.synthesis.maxTokens,
			),
			idleGapMinutes: clampPositive(
				synthesisRaw?.idleGapMinutes,
				1,
				1440,
				d.synthesis.idleGapMinutes,
			),
		},
		procedural: {
			enabled: resolveBool(
				proceduralRaw?.enabled, undefined, d.procedural.enabled,
			),
			decayRate: clampFraction(
				proceduralRaw?.decayRate,
				d.procedural.decayRate,
			),
			minImportance: clampFraction(
				proceduralRaw?.minImportance,
				d.procedural.minImportance,
			),
			importanceOnInstall: clampFraction(
				proceduralRaw?.importanceOnInstall,
				d.procedural.importanceOnInstall,
			),
			enrichOnInstall: resolveBool(
				proceduralRaw?.enrichOnInstall, undefined, d.procedural.enrichOnInstall,
			),
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
			enabled: resolveBool(
				structuralRaw?.enabled, undefined, d.structural.enabled,
			),
			classifyBatchSize: clampPositive(
				structuralRaw?.classifyBatchSize,
				1,
				20,
				d.structural.classifyBatchSize,
			),
			dependencyBatchSize: clampPositive(
				structuralRaw?.dependencyBatchSize,
				1,
				10,
				d.structural.dependencyBatchSize,
			),
			pollIntervalMs: clampPositive(
				structuralRaw?.pollIntervalMs,
				2000,
				120000,
				d.structural.pollIntervalMs,
			),
		},

		feedback: {
			enabled: resolveBool(
				feedbackRaw?.enabled, undefined, d.feedback.enabled,
			),
			ftsWeightDelta: clampFraction(
				feedbackRaw?.ftsWeightDelta,
				d.feedback.ftsWeightDelta,
			),
			maxAspectWeight: clampFraction(
				feedbackRaw?.maxAspectWeight,
				d.feedback.maxAspectWeight,
			),
			minAspectWeight: clampFraction(
				feedbackRaw?.minAspectWeight,
				d.feedback.minAspectWeight,
			),
			decayEnabled: resolveBool(
				feedbackRaw?.decayEnabled, undefined, d.feedback.decayEnabled,
			),
			decayRate: clampFraction(
				feedbackRaw?.decayRate,
				d.feedback.decayRate,
			),
			staleDays: clampPositive(
				feedbackRaw?.staleDays,
				1,
				365,
				d.feedback.staleDays,
			),
			decayIntervalSessions: clampPositive(
				feedbackRaw?.decayIntervalSessions,
				1,
				1000,
				d.feedback.decayIntervalSessions,
			),
		},

		predictor: {
			enabled: resolveBool(
				predictorRaw?.enabled, undefined, d.predictor?.enabled ?? false,
			),
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
			scoreTimeoutMs: clampPositive(
				predictorRaw?.scoreTimeoutMs,
				10,
				10000,
				d.predictor?.scoreTimeoutMs ?? 120,
			),
			trainTimeoutMs: clampPositive(
				predictorRaw?.trainTimeoutMs,
				1000,
				120000,
				d.predictor?.trainTimeoutMs ?? 30000,
			),
			crashDisableThreshold: clampPositive(
				predictorRaw?.crashDisableThreshold,
				1,
				20,
				d.predictor?.crashDisableThreshold ?? 3,
			),
			rrfK: clampPositive(
				predictorRaw?.rrfK,
				1,
				100,
				d.predictor?.rrfK ?? 12,
			),
			explorationRate: clampFraction(
				predictorRaw?.explorationRate,
				d.predictor?.explorationRate ?? 0.05,
			),
			driftResetWindow: clampPositive(
				predictorRaw?.driftResetWindow,
				1,
				100,
				d.predictor?.driftResetWindow ?? 10,
			),
			binaryPath:
				typeof predictorRaw?.binaryPath === "string"
					? predictorRaw.binaryPath
					: d.predictor?.binaryPath,
			checkpointPath:
				typeof predictorRaw?.checkpointPath === "string"
					? predictorRaw.checkpointPath
					: d.predictor?.checkpointPath,
		},
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
		auth: parseAuthConfig(undefined, agentsDir),
	};

	const paths = [
		join(agentsDir, "agent.yaml"),
		join(agentsDir, "AGENT.yaml"),
		join(agentsDir, "config.yaml"),
	];

	for (const path of paths) {
		if (!existsSync(path)) continue;
		try {
			const yaml = parseSimpleYaml(readFileSync(path, "utf-8"));
			const emb =
				(yaml.embedding as Record<string, unknown> | undefined) ??
				((yaml.memory as Record<string, unknown> | undefined)?.embeddings as
					| Record<string, unknown>
					| undefined) ??
				(yaml.embeddings as Record<string, unknown> | undefined) ??
				{};
			const srch = (yaml.search as Record<string, unknown> | undefined) ?? {};

			if (emb.provider === "none") {
				defaults.embedding.provider = "none";
			} else if (emb.provider) {
				defaults.embedding.provider = emb.provider as "native" | "ollama" | "openai";
				defaults.embedding.model =
					(emb.model as string | undefined) ?? defaults.embedding.model;
				defaults.embedding.dimensions = Number.parseInt(
					String(emb.dimensions ?? "768"),
					10,
				);
				const explicitBaseUrl = emb.base_url as string | undefined;
				if (defaults.embedding.provider === "ollama") {
					defaults.embedding.base_url =
						typeof explicitBaseUrl === "string" && explicitBaseUrl.trim().length > 0
							? explicitBaseUrl
							: DEFAULT_OLLAMA_BASE_URL;
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
				defaults.search.min_score = Number.parseFloat(
					String(srch.min_score ?? "0.3"),
				);
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
			defaults.auth = parseAuthConfig(yaml.auth, agentsDir);

			break;
		} catch {
			// ignore parse errors, try next file
		}
	}

	return defaults;
}
