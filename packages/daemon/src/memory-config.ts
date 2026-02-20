import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseSimpleYaml } from "@signet/core";

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

export const PIPELINE_FLAGS = [
	"enabled",
	"shadowMode",
	"allowUpdateDelete",
	"graphEnabled",
	"autonomousEnabled",
	"mutationsFrozen",
	"autonomousFrozen",
] as const;

export type PipelineFlag = (typeof PIPELINE_FLAGS)[number];

export interface PipelineV2Config {
	readonly enabled: boolean;
	readonly shadowMode: boolean;
	readonly allowUpdateDelete: boolean;
	readonly graphEnabled: boolean;
	readonly autonomousEnabled: boolean;
	readonly mutationsFrozen: boolean;
	readonly autonomousFrozen: boolean;
}

export const DEFAULT_PIPELINE_V2: PipelineV2Config = {
	enabled: false,
	shadowMode: false,
	allowUpdateDelete: false,
	graphEnabled: false,
	autonomousEnabled: false,
	mutationsFrozen: false,
	autonomousFrozen: false,
};

export interface ResolvedMemoryConfig {
	embedding: EmbeddingConfig;
	search: MemorySearchConfig;
	pipelineV2: PipelineV2Config;
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
				((yaml.memory as Record<string, unknown> | undefined)
					?.embeddings as Record<string, unknown> | undefined) ??
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
				defaults.search.top_k = Number.parseInt(
					String(srch.top_k ?? "20"),
					10,
				);
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
