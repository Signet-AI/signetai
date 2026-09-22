import type { EmbeddingConfig } from "./memory-config";
export type EmbeddingRole = "document" | "query";

export interface EmbeddingProfile {
	readonly id: string;
	readonly dimensions: number;
	readonly format: (text: string, role: EmbeddingRole) => string;
}

const QWEN_RETRIEVAL_INSTRUCTION = "Given a web search query, retrieve relevant passages that answer the query";

const identityProfile = (cfg: EmbeddingConfig): EmbeddingProfile => ({
	id: `custom:${cfg.provider}:${cfg.model}`,
	dimensions: cfg.dimensions,
	format: (text) => text,
});

const nomicProfile = (cfg: EmbeddingConfig): EmbeddingProfile => ({
	id: "nomic-embed-text-v1.5",
	dimensions: cfg.dimensions,
	format: (text, role) => `${role === "query" ? "search_query" : "search_document"}: ${text}`,
});

const qwenProfile = (cfg: EmbeddingConfig): EmbeddingProfile => ({
	id: "qwen3-embedding",
	dimensions: cfg.dimensions,
	format: (text, role) => (role === "query" ? `Instruct: ${QWEN_RETRIEVAL_INSTRUCTION}\nQuery: ${text}` : text),
});
export function resolveEmbeddingProfile(cfg: EmbeddingConfig): EmbeddingProfile {
	if (!cfg.profile || cfg.profile === "legacy-raw") return identityProfile(cfg);
	const model = cfg.model.trim().toLowerCase();
	if (cfg.profile === "nomic-embed-text-v1.5" && model.includes("nomic-embed-text")) return nomicProfile(cfg);
	if (cfg.profile === "qwen3-embedding" && model.includes("qwen3-embedding")) return qwenProfile(cfg);
	return identityProfile(cfg);
}
export function recommendedEmbeddingProfileId(cfg: EmbeddingConfig): string | undefined {
	const model = cfg.model.trim().toLowerCase();
	if (model.includes("nomic-embed-text")) return "nomic-embed-text-v1.5";
	if (model.includes("qwen3-embedding")) return "qwen3-embedding";
	return undefined;
}

export function formatEmbeddingInput(text: string, cfg: EmbeddingConfig, role: EmbeddingRole): string {
	return resolveEmbeddingProfile(cfg).format(text, role);
}
export function embeddingProfileFingerprint(cfg: EmbeddingConfig): string {
	const profile = resolveEmbeddingProfile(cfg);
	return JSON.stringify({
		profile: profile.id,
		provider: cfg.provider,
		model: cfg.model,
		dimensions: profile.dimensions,
	});
}
export function embeddingProfileFingerprintsEqual(left: string, right: string): boolean {
	try {
		const a = JSON.parse(left) as Record<string, unknown>;
		const b = JSON.parse(right) as Record<string, unknown>;
		const normalize = (value: Record<string, unknown>): string =>
			JSON.stringify({
				profile: value.profile,
				provider: value.provider,
				model: value.model,
				dimensions: value.dimensions,
			});
		return normalize(a) === normalize(b);
	} catch {
		return left === right;
	}
}
