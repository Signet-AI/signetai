/**
 * Cost attribution for embedding telemetry.
 *
 * Rates are USD per million input tokens. Local providers are free by
 * default. Remote rates are intentionally configurable because provider and
 * model pricing changes independently of the daemon release.
 */

import type { AccountingProvenance } from "@signet/core";

export type EmbeddingCostProvider = "native" | "llama-cpp" | "ollama" | "openai" | "openrouter";

export type EmbeddingCostRates = Readonly<Partial<Record<EmbeddingCostProvider, number>>>;

export const DEFAULT_EMBEDDING_COST_RATES: Readonly<Record<EmbeddingCostProvider, number>> = {
	native: 0,
	"llama-cpp": 0,
	ollama: 0,
	openai: 0.02,
	openrouter: 0.004,
};

export function resolveEmbeddingCostProvider(provider: string, baseUrl?: string): EmbeddingCostProvider | null {
	if (provider === "native" || provider === "llama-cpp" || provider === "ollama") return provider;
	if (provider === "openai") {
		if (baseUrl?.toLowerCase().includes("openrouter.ai")) return "openrouter";
		return "openai";
	}
	if (provider === "openrouter") return "openrouter";
	return null;
}

export function calculateEmbeddingCost(
	provider: string,
	tokens: number,
	opts: { readonly baseUrl?: string; readonly rates?: EmbeddingCostRates } = {},
): number | null {
	return resolveEmbeddingAccounting(provider, tokens, opts).cost;
}

export function resolveEmbeddingAccounting(
	provider: string,
	tokens: number,
	opts: { readonly baseUrl?: string; readonly rates?: EmbeddingCostRates } = {},
): { readonly cost: number | null; readonly accountingProvenance: AccountingProvenance } {
	if (!Number.isFinite(tokens) || tokens < 0) return { cost: null, accountingProvenance: "unavailable" };
	const rateProvider = resolveEmbeddingCostProvider(provider, opts.baseUrl);
	if (!rateProvider) return { cost: null, accountingProvenance: "unavailable" };
	if (rateProvider === "native" || rateProvider === "llama-cpp" || rateProvider === "ollama") {
		return { cost: 0, accountingProvenance: "local_zero_cost" };
	}
	const configuredRate = opts.rates?.[rateProvider];
	const rate = configuredRate ?? DEFAULT_EMBEDDING_COST_RATES[rateProvider];
	if (!Number.isFinite(rate) || rate < 0) return { cost: null, accountingProvenance: "unavailable" };
	return { cost: (tokens * rate) / 1_000_000, accountingProvenance: "configured_rate" };
}
