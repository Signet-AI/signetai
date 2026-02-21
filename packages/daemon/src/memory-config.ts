import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	parseSimpleYaml,
	PIPELINE_FLAGS,
	type PipelineFlag,
	type PipelineV2Config,
} from "@signet/core";

export interface EmbeddingConfig {
	provider: "ollama" | "openai";
	model: string;
	dimensions: number;
	base_url: string;
	api_key?: string;
}

export interface MemorySearchConfig {
	alpha: number;
	top_k: number;
	min_score: number;
}

export { PIPELINE_FLAGS };
export type { PipelineFlag, PipelineV2Config };

export const DEFAULT_PIPELINE_V2: PipelineV2Config = {
	enabled: false,
	shadowMode: false,
	allowUpdateDelete: false,
	graphEnabled: false,
	autonomousEnabled: false,
	mutationsFrozen: false,
	autonomousFrozen: false,
	extractionModel: "qwen3:4b",
	extractionTimeout: 45000,
	workerPollMs: 2000,
	workerMaxRetries: 3,
	leaseTimeoutMs: 300000,
	minFactConfidenceForWrite: 0.7,
	graphBoostWeight: 0.15,
	graphBoostTimeoutMs: 500,
	rerankerEnabled: false,
	rerankerModel: "",
	rerankerTopN: 20,
	rerankerTimeoutMs: 2000,
	maintenanceIntervalMs: 30 * 60 * 1000, // 30 min
	maintenanceMode: "observe",
	repairReembedCooldownMs: 300000, // 5 min
	repairReembedHourlyBudget: 10,
	repairRequeueCooldownMs: 60000, // 1 min
	repairRequeueHourlyBudget: 50,
	documentWorkerIntervalMs: 10000,
	documentChunkSize: 2000,
	documentChunkOverlap: 200,
	documentMaxContentBytes: 10 * 1024 * 1024, // 10 MB
};

export interface ResolvedMemoryConfig {
	embedding: EmbeddingConfig;
	search: MemorySearchConfig;
	pipelineV2: PipelineV2Config;
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

export function loadPipelineConfig(
	yaml: Record<string, unknown>,
): PipelineV2Config {
	const mem = yaml.memory as Record<string, unknown> | undefined;
	const raw = mem?.pipelineV2 as Record<string, unknown> | undefined;
	if (!raw) return { ...DEFAULT_PIPELINE_V2 };

	return {
		enabled: raw.enabled === true,
		shadowMode: raw.shadowMode === true,
		allowUpdateDelete: raw.allowUpdateDelete === true,
		graphEnabled: raw.graphEnabled === true,
		autonomousEnabled: raw.autonomousEnabled === true,
		mutationsFrozen: raw.mutationsFrozen === true,
		autonomousFrozen: raw.autonomousFrozen === true,
		extractionModel:
			typeof raw.extractionModel === "string"
				? raw.extractionModel
				: DEFAULT_PIPELINE_V2.extractionModel,
		extractionTimeout: clampPositive(
			raw.extractionTimeout,
			5000,
			300000,
			DEFAULT_PIPELINE_V2.extractionTimeout,
		),
		workerPollMs: clampPositive(
			raw.workerPollMs,
			100,
			60000,
			DEFAULT_PIPELINE_V2.workerPollMs,
		),
		workerMaxRetries: clampPositive(
			raw.workerMaxRetries,
			1,
			10,
			DEFAULT_PIPELINE_V2.workerMaxRetries,
		),
		leaseTimeoutMs: clampPositive(
			raw.leaseTimeoutMs,
			10000,
			600000,
			DEFAULT_PIPELINE_V2.leaseTimeoutMs,
		),
		minFactConfidenceForWrite: clampFraction(
			raw.minFactConfidenceForWrite,
			DEFAULT_PIPELINE_V2.minFactConfidenceForWrite,
		),
		graphBoostWeight: clampFraction(
			raw.graphBoostWeight,
			DEFAULT_PIPELINE_V2.graphBoostWeight,
		),
		graphBoostTimeoutMs: clampPositive(
			raw.graphBoostTimeoutMs,
			50,
			5000,
			DEFAULT_PIPELINE_V2.graphBoostTimeoutMs,
		),
		rerankerEnabled: raw.rerankerEnabled === true,
		rerankerModel:
			typeof raw.rerankerModel === "string"
				? raw.rerankerModel
				: DEFAULT_PIPELINE_V2.rerankerModel,
		rerankerTopN: clampPositive(
			raw.rerankerTopN,
			1,
			100,
			DEFAULT_PIPELINE_V2.rerankerTopN,
		),
		rerankerTimeoutMs: clampPositive(
			raw.rerankerTimeoutMs,
			100,
			30000,
			DEFAULT_PIPELINE_V2.rerankerTimeoutMs,
		),
		maintenanceIntervalMs: clampPositive(
			raw.maintenanceIntervalMs,
			60000,
			86400000,
			DEFAULT_PIPELINE_V2.maintenanceIntervalMs,
		),
		maintenanceMode:
			raw.maintenanceMode === "execute"
				? "execute"
				: DEFAULT_PIPELINE_V2.maintenanceMode,
		repairReembedCooldownMs: clampPositive(
			raw.repairReembedCooldownMs,
			10000,
			3600000,
			DEFAULT_PIPELINE_V2.repairReembedCooldownMs,
		),
		repairReembedHourlyBudget: clampPositive(
			raw.repairReembedHourlyBudget,
			1,
			1000,
			DEFAULT_PIPELINE_V2.repairReembedHourlyBudget,
		),
		repairRequeueCooldownMs: clampPositive(
			raw.repairRequeueCooldownMs,
			5000,
			3600000,
			DEFAULT_PIPELINE_V2.repairRequeueCooldownMs,
		),
		repairRequeueHourlyBudget: clampPositive(
			raw.repairRequeueHourlyBudget,
			1,
			1000,
			DEFAULT_PIPELINE_V2.repairRequeueHourlyBudget,
		),
		documentWorkerIntervalMs: clampPositive(
			raw.documentWorkerIntervalMs,
			1000,
			300000,
			DEFAULT_PIPELINE_V2.documentWorkerIntervalMs,
		),
		documentChunkSize: clampPositive(
			raw.documentChunkSize,
			200,
			50000,
			DEFAULT_PIPELINE_V2.documentChunkSize,
		),
		documentChunkOverlap: clampPositive(
			raw.documentChunkOverlap,
			0,
			10000,
			DEFAULT_PIPELINE_V2.documentChunkOverlap,
		),
		documentMaxContentBytes: clampPositive(
			raw.documentMaxContentBytes,
			1024,
			100 * 1024 * 1024,
			DEFAULT_PIPELINE_V2.documentMaxContentBytes,
		),
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
		search: { alpha: 0.7, top_k: 20, min_score: 0.3 },
		pipelineV2: { ...DEFAULT_PIPELINE_V2 },
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

			if (emb.provider) {
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

			defaults.pipelineV2 = loadPipelineConfig(yaml);

			break;
		} catch {
			// ignore parse errors, try next file
		}
	}

	return defaults;
}
