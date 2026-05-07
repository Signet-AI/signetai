import type { SQLQueryBindings } from "bun:sqlite";
import type { DbAccessor } from "./db-accessor";
import { logger } from "./logger";
import type { RecallParams, RecallResponse, RecallResult, RecallTimings } from "./memory-search";

export interface MemorySearchTelemetryRecordInput {
	readonly route: string;
	readonly agentId: string;
	readonly sessionKey: string | null;
	readonly project: string | null;
	readonly params: RecallParams;
	readonly response: RecallResponse;
	readonly retentionDays: number;
}

export interface MemorySearchTelemetryQuery {
	readonly agentId?: string;
	readonly sessionKey?: string;
	readonly project?: string;
	readonly route?: string;
	readonly since?: string;
	readonly until?: string;
	readonly noHits?: boolean;
	readonly limit?: number;
	readonly offset?: number;
}

export interface MemorySearchTelemetryResultSnapshot {
	readonly rank: number;
	readonly id: string;
	readonly content: string;
	readonly content_length: number;
	readonly truncated: boolean;
	readonly score: number;
	readonly source: string;
	readonly source_id?: string;
	readonly session_id?: string;
	readonly source_path?: string;
	readonly type: string;
	readonly tags: string | null;
	readonly pinned: boolean;
	readonly importance: number;
	readonly who: string;
	readonly project: string | null;
	readonly created_at: string;
	readonly supplementary?: boolean;
}

export interface MemorySearchTelemetryItem {
	readonly id: string;
	readonly created_at: string;
	readonly route: string;
	readonly agent_id: string;
	readonly session_key: string | null;
	readonly project: string | null;
	readonly query: string;
	readonly keyword_query: string | null;
	readonly filters: Readonly<Record<string, unknown>>;
	readonly method: RecallResponse["method"];
	readonly result_count: number;
	readonly top_score: number | null;
	readonly no_hits: boolean;
	readonly duration_ms: number;
	readonly timings: RecallTimings;
	readonly results: readonly MemorySearchTelemetryResultSnapshot[];
	readonly sources: Readonly<Record<string, string>> | null;
}

interface MemorySearchTelemetryRow {
	readonly id: string;
	readonly created_at: string;
	readonly route: string;
	readonly agent_id: string;
	readonly session_key: string | null;
	readonly project: string | null;
	readonly query: string;
	readonly keyword_query: string | null;
	readonly filters_json: string;
	readonly method: string;
	readonly result_count: number;
	readonly top_score: number | null;
	readonly no_hits: number;
	readonly duration_ms: number;
	readonly timings_json: string;
	readonly results_json: string;
	readonly sources_json: string | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function stringifyJson(value: unknown, fallback: string): string {
	try {
		return JSON.stringify(value);
	} catch {
		return fallback;
	}
}

function parseJsonRecord(raw: string, fallback: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
	try {
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
			return parsed as Readonly<Record<string, unknown>>;
		}
		return fallback;
	} catch {
		return fallback;
	}
}

function parseStringRecord(raw: string | null): Readonly<Record<string, string>> | null {
	if (raw === null) return null;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
		const entries = Object.entries(parsed as Record<string, unknown>).filter(
			(entry): entry is [string, string] => typeof entry[1] === "string",
		);
		return Object.fromEntries(entries);
	} catch {
		return null;
	}
}

function isTelemetryResultSnapshot(value: unknown): value is MemorySearchTelemetryResultSnapshot {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const row = value as Record<string, unknown>;
	return typeof row.rank === "number" && typeof row.id === "string" && typeof row.content === "string";
}

function parseResults(raw: string): readonly MemorySearchTelemetryResultSnapshot[] {
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter(isTelemetryResultSnapshot);
	} catch {
		return [];
	}
}

function parseTimings(raw: string): RecallTimings {
	try {
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			return { totalMs: 0, stages: [] };
		}
		const row = parsed as Record<string, unknown>;
		const stages = Array.isArray(row.stages)
			? row.stages
					.filter((stage): stage is { name: string; durationMs: number } => {
						if (typeof stage !== "object" || stage === null || Array.isArray(stage)) return false;
						const candidate = stage as Record<string, unknown>;
						return typeof candidate.name === "string" && typeof candidate.durationMs === "number";
					})
					.map((stage) => ({ name: stage.name, durationMs: stage.durationMs }))
			: [];
		return {
			totalMs: typeof row.totalMs === "number" ? row.totalMs : 0,
			stages,
		};
	} catch {
		return { totalMs: 0, stages: [] };
	}
}

function buildFilters(params: RecallParams): Readonly<Record<string, unknown>> {
	return {
		limit: params.limit ?? null,
		type: params.type ?? null,
		tags: params.tags ?? null,
		who: params.who ?? null,
		pinned: params.pinned ?? null,
		importance_min: params.importance_min ?? null,
		since: params.since ?? null,
		until: params.until ?? null,
		scope: params.scope ?? null,
		expand: params.expand ?? null,
		readPolicy: params.readPolicy ?? null,
		policyGroup: params.policyGroup ?? null,
		project: params.project ?? null,
	};
}

function snapshotResult(row: RecallResult, index: number): MemorySearchTelemetryResultSnapshot {
	return {
		rank: index + 1,
		id: row.id,
		content: row.content,
		content_length: row.content_length,
		truncated: row.truncated,
		score: row.score,
		source: row.source,
		...(row.source_id ? { source_id: row.source_id } : {}),
		...(row.session_id ? { session_id: row.session_id } : {}),
		...(row.source_path ? { source_path: row.source_path } : {}),
		type: row.type,
		tags: row.tags,
		pinned: row.pinned,
		importance: row.importance,
		who: row.who,
		project: row.project,
		created_at: row.created_at,
		...(row.supplementary === true ? { supplementary: true } : {}),
	};
}

function rowToItem(row: MemorySearchTelemetryRow): MemorySearchTelemetryItem {
	return {
		id: row.id,
		created_at: row.created_at,
		route: row.route,
		agent_id: row.agent_id,
		session_key: row.session_key,
		project: row.project,
		query: row.query,
		keyword_query: row.keyword_query,
		filters: parseJsonRecord(row.filters_json, {}),
		method: row.method === "keyword" ? "keyword" : "hybrid",
		result_count: row.result_count,
		top_score: row.top_score,
		no_hits: row.no_hits === 1,
		duration_ms: row.duration_ms,
		timings: parseTimings(row.timings_json),
		results: parseResults(row.results_json),
		sources: parseStringRecord(row.sources_json),
	};
}

export function recordMemorySearchTelemetry(db: DbAccessor, input: MemorySearchTelemetryRecordInput): void {
	try {
		const createdAt = new Date().toISOString();
		const cutoff = new Date(Date.now() - input.retentionDays * DAY_MS).toISOString();
		const results = input.response.results.map(snapshotResult);
		const filters = buildFilters(input.params);
		const top = input.response.results[0]?.score ?? null;

		db.withWriteTx((w) => {
			w.prepare(
				`INSERT INTO memory_search_telemetry
				 (id, created_at, route, agent_id, session_key, project, query,
				  keyword_query, filters_json, method, result_count, top_score,
				  no_hits, duration_ms, timings_json, results_json, sources_json)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			).run(
				crypto.randomUUID(),
				createdAt,
				input.route,
				input.agentId,
				input.sessionKey,
				input.project,
				input.params.query,
				input.params.keywordQuery ?? null,
				stringifyJson(filters, "{}"),
				input.response.method,
				input.response.results.length,
				top,
				input.response.meta.noHits ? 1 : 0,
				input.response.meta.timings.totalMs,
				stringifyJson(input.response.meta.timings, '{"totalMs":0,"stages":[]}'),
				stringifyJson(results, "[]"),
				input.response.sources ? stringifyJson(input.response.sources, "{}") : null,
			);
			w.prepare("DELETE FROM memory_search_telemetry WHERE created_at < ?").run(cutoff);
		});
	} catch (err) {
		logger.warn("memory", "Failed to record memory search telemetry", {
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

export function listMemorySearchTelemetry(
	db: DbAccessor,
	query: MemorySearchTelemetryQuery = {},
): readonly MemorySearchTelemetryItem[] {
	const conditions: string[] = [];
	const args: SQLQueryBindings[] = [];

	if (query.agentId) {
		conditions.push("agent_id = ?");
		args.push(query.agentId);
	}
	if (query.sessionKey) {
		conditions.push("session_key = ?");
		args.push(query.sessionKey);
	}
	if (query.project) {
		conditions.push("project = ?");
		args.push(query.project);
	}
	if (query.route) {
		conditions.push("route = ?");
		args.push(query.route);
	}
	if (query.since) {
		conditions.push("created_at >= ?");
		args.push(query.since);
	}
	if (query.until) {
		conditions.push("created_at <= ?");
		args.push(query.until);
	}
	if (typeof query.noHits === "boolean") {
		conditions.push("no_hits = ?");
		args.push(query.noHits ? 1 : 0);
	}

	const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
	const limit = query.limit ?? 100;
	const offset = query.offset ?? 0;

	return db.withReadDb((r) => {
		const rows = r
			.prepare(
				`SELECT id, created_at, route, agent_id, session_key, project, query,
				        keyword_query, filters_json, method, result_count, top_score,
				        no_hits, duration_ms, timings_json, results_json, sources_json
				 FROM memory_search_telemetry
				 ${where}
				 ORDER BY created_at DESC
				 LIMIT ? OFFSET ?`,
			)
			.all(...args, limit, offset) as readonly MemorySearchTelemetryRow[];
		return rows.map(rowToItem);
	});
}
