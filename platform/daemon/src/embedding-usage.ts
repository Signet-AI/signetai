import type { DbAccessor } from "./db-accessor";
import { getDbAccessor, hasDbAccessor } from "./db-accessor";
import { type EmbeddingCostRates, resolveEmbeddingAccounting } from "./embedding-cost";
import { logger } from "./logger";
import { getActiveTelemetry } from "./telemetry";
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
function todayKey(now: Date = new Date()): string {
	return now.toISOString().slice(0, 10);
}

const UPSERT_SQL = `
	INSERT INTO embedding_usage (day, agent_id, source_kind, provider, requests, tokens)
	VALUES (?, ?, ?, ?, 1, ?)
	ON CONFLICT(day, agent_id, source_kind, provider)
	DO UPDATE SET requests = requests + 1, tokens = tokens + excluded.tokens
`;
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
		void getDbAccessor()
			.withWriteTxAsync(
				(db: import("./db-accessor").WriteDb) => {
					db.prepare(UPSERT_SQL).run(
						todayKey(input.now),
						input.agentId ?? "",
						input.source,
						input.provider,
						input.tokens,
					);
				},
				{ siteToken: "embedding-usage.ts:57", operation: "embedding.usage", estimatedWorkUnits: 1 },
			)
			.catch((e) => {
				logger.warn("embedding", "Failed to record embedding usage", {
					error: e instanceof Error ? e.message : String(e),
				});
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

let cachedEmbeddingUsageSummary: EmbeddingUsageSummary | null = null;
export async function readEmbeddingUsageSummary(
	accessor: DbAccessor,
	now: Date = new Date(),
): Promise<EmbeddingUsageSummary | null> {
	try {
		const summary = await accessor.withReadDbAsync(
			(db: import("./db-accessor").ReadDb) => {
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
			},
			{ siteToken: "embedding-usage.ts:94" },
		);
		cachedEmbeddingUsageSummary = summary;
		return summary;
	} catch (e) {
		logger.warn("embedding", "Failed to read embedding usage summary", {
			error: e instanceof Error ? e.message : String(e),
		});
		return null;
	}
}
export function getCachedEmbeddingUsageSummary(): EmbeddingUsageSummary | null {
	return cachedEmbeddingUsageSummary;
}

export type { EmbeddingUsageRow };
