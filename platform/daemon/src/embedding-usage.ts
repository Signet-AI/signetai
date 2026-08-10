/**
 * Embedding token usage accounting.
 *
 * The shared embedding-fetch boundary records every successful embedding
 * fetch into the `embedding_usage` daily-aggregate table (migration 108).
 * The count comes from the real tokenizer (countTokens) applied to the text
 * actually sent to the provider — never provider-reported usage, because
 * Ollama's /api/embeddings returns none and the native ONNX path reports
 * none either.
 *
 * Rows are keyed by (day, agent_id, source_kind, provider) and accumulate
 * `requests` + `tokens`, keeping the table bounded at one row per day per
 * dimension while still answering "how much did vault ingest cost in tokens
 * vs. captures" and "what is Ollama/native throughput".
 *
 * Recording is strictly best-effort: it must never fail or slow down the
 * embedding path it observes.
 */

import type { DbAccessor } from "./db-accessor";
import { getDbAccessor, hasDbAccessor } from "./db-accessor";
import { type EmbeddingCostRates, resolveEmbeddingAccounting } from "./embedding-cost";
import { logger } from "./logger";
import { getActiveTelemetry } from "./telemetry";

/** What produced the embedding. Used for per-source cost attribution. */
export type EmbeddingUsageSource = "memory-capture" | "artifact-index" | "recall" | "dreaming" | "other";

export interface EmbeddingUsageAttribution {
	readonly source?: EmbeddingUsageSource;
	readonly agentId?: string;
	readonly sessionHash?: string;
}

interface EmbeddingUsageRow {
	readonly day: string;
	readonly agent_id: string;
	readonly source_kind: string;
	readonly provider: string;
	readonly requests: number;
	readonly tokens: number;
}

/** UTC day key, matching the ISO timestamps used across the daemon. */
function todayKey(now: Date = new Date()): string {
	return now.toISOString().slice(0, 10);
}

const UPSERT_SQL = `
	INSERT INTO embedding_usage (day, agent_id, source_kind, provider, requests, tokens)
	VALUES (?, ?, ?, ?, 1, ?)
	ON CONFLICT(day, agent_id, source_kind, provider)
	DO UPDATE SET requests = requests + 1, tokens = tokens + excluded.tokens
`;

/**
 * Record one successful embedding fetch. Best-effort: a DB failure is logged
 * and swallowed so the embedding result is never affected. Skips silently
 * when no daemon DB accessor is initialised (isolated migration worker,
 * tests).
 */
export function recordEmbeddingUsage(input: {
	readonly provider: string;
	readonly tokens: number;
	readonly source: EmbeddingUsageSource;
	readonly agentId?: string;
	readonly sessionHash?: string;
	readonly baseUrl?: string;
	readonly costRates?: EmbeddingCostRates;
	readonly now?: Date;
}): void {
	// Anonymous telemetry: emit the pipeline.embedding event at the same fetch
	// boundary so embedding token spend shows up in PostHog alongside
	// llm.generate (issue #1181). Best-effort, like the DB accounting below.
	const accounting = resolveEmbeddingAccounting(input.provider, input.tokens, {
		baseUrl: input.baseUrl,
		rates: input.costRates,
	});
	getActiveTelemetry()?.record("pipeline.embedding", {
		tokens: input.tokens,
		provider: input.provider,
		sourceKind: input.source,
		...(input.sessionHash ? { sessionHash: input.sessionHash } : {}),
		cost: accounting.cost,
		accountingProvenance: accounting.accountingProvenance,
	});
	if (!hasDbAccessor()) return;
	try {
		getDbAccessor().withWriteTx((db) => {
			db.prepare(UPSERT_SQL).run(todayKey(input.now), input.agentId ?? "", input.source, input.provider, input.tokens);
		});
	} catch (e) {
		logger.warn("embedding", "Failed to record embedding usage", {
			error: e instanceof Error ? e.message : String(e),
		});
	}
}

export interface EmbeddingUsageSummary {
	readonly total: { readonly requests: number; readonly tokens: number };
	readonly today: { readonly requests: number; readonly tokens: number };
	readonly bySource: ReadonlyArray<{ readonly source: string; readonly requests: number; readonly tokens: number }>;
	readonly byProvider: ReadonlyArray<{ readonly provider: string; readonly requests: number; readonly tokens: number }>;
}

/**
 * Aggregate the daily table into totals, today's totals, and per-source /
 * per-provider breakdowns for /api/status. Returns null when the table is
 * absent (pre-migration database) or the DB is unavailable.
 */
export function readEmbeddingUsageSummary(accessor: DbAccessor, now: Date = new Date()): EmbeddingUsageSummary | null {
	try {
		return accessor.withReadDb((db) => {
			const day = todayKey(now);
			const totals = db
				.prepare(
					"SELECT COALESCE(SUM(requests), 0) AS requests, COALESCE(SUM(tokens), 0) AS tokens FROM embedding_usage",
				)
				.get() as { requests: number; tokens: number };
			const today = db
				.prepare(
					"SELECT COALESCE(SUM(requests), 0) AS requests, COALESCE(SUM(tokens), 0) AS tokens FROM embedding_usage WHERE day = ?",
				)
				.get(day) as { requests: number; tokens: number };
			const bySource = db
				.prepare(
					`SELECT source_kind AS source, SUM(requests) AS requests, SUM(tokens) AS tokens
					 FROM embedding_usage GROUP BY source_kind ORDER BY tokens DESC`,
				)
				.all() as Array<{ source: string; requests: number; tokens: number }>;
			const byProvider = db
				.prepare(
					`SELECT provider, SUM(requests) AS requests, SUM(tokens) AS tokens
					 FROM embedding_usage GROUP BY provider ORDER BY tokens DESC`,
				)
				.all() as Array<{ provider: string; requests: number; tokens: number }>;
			return { total: totals, today, bySource, byProvider };
		});
	} catch (e) {
		logger.warn("embedding", "Failed to read embedding usage summary", {
			error: e instanceof Error ? e.message : String(e),
		});
		return null;
	}
}

export type { EmbeddingUsageRow };
