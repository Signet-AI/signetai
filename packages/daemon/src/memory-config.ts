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
	provider: "ollama" | "openai" | "none";
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
		timeout: 45000,
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
};

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
	const rerankerRaw = raw.reranker as Record<string, unknown> | undefined;
	const autonomousRaw = raw.autonomous as Record<string, unknown> | undefined;
	const repairRaw = raw.repair as Record<string, unknown> | undefined;
	const documentsRaw = raw.documents as Record<string, unknown> | undefined;
	const guardrailsRaw = raw.guardrails as Record<string, unknown> | undefined;
	const telemetryRaw = raw.telemetry as Record<string, unknown> | undefined;
	const continuityRaw = raw.continuity as Record<string, unknown> | undefined;

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
	const resolvedProvider: "ollama" | "claude-code" | "opencode" =
		nestedProvider === "opencode" || flatProvider === "opencode"
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
	};
}

export function loadMemoryConfig(agentsDir: string): ResolvedMemoryConfig {
	const defaults: ResolvedMemoryConfig = {
		embedding: {
			provider: "ollama",
			model: "nomic-embed-text",
			dimensions: 768,
			base_url: "http://localhost:11434",
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
				defaults.embedding.provider = emb.provider as "ollama" | "openai";
				defaults.embedding.model =
					(emb.model as string | undefined) ?? defaults.embedding.model;
				defaults.embedding.dimensions = Number.parseInt(
					String(emb.dimensions ?? "768"),
					10,
				);
				defaults.embedding.base_url =
					(emb.base_url as string | undefined) ?? defaults.embedding.base_url;
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
