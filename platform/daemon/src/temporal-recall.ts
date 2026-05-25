import type { RecallTemporalMeta, TemporalFacet } from "@signet/core";
import { getDbAccessor } from "./db-accessor";
import { buildAgentScopeClause } from "./memory-access-scope";

const DEFAULT_TEMPORAL_FACETS: readonly TemporalFacet[] = [
	"session",
	"source",
	"occurred",
	"observed",
	"valid",
	"captured",
];
const TEMPORAL_FACET_SET = new Set<string>(DEFAULT_TEMPORAL_FACETS);
const TEMPORAL_MODES = new Set(["auto", "timeline", "filter"]);
const TEMPORAL_FILTER_MIN_CANDIDATES = 100;
const TEMPORAL_FILTER_LIMIT_MULTIPLIER = 20;

const WEAK_TEMPORAL_TERMS = new Set([
	"what",
	"were",
	"was",
	"we",
	"you",
	"i",
	"doing",
	"did",
	"do",
	"on",
	"in",
	"at",
	"the",
	"that",
	"day",
	"date",
	"tell",
	"me",
	"about",
	"working",
	"worked",
]);

const MONTHS = new Map([
	["january", 1],
	["jan", 1],
	["february", 2],
	["feb", 2],
	["march", 3],
	["mar", 3],
	["april", 4],
	["apr", 4],
	["may", 5],
	["june", 6],
	["jun", 6],
	["july", 7],
	["jul", 7],
	["august", 8],
	["aug", 8],
	["september", 9],
	["sep", 9],
	["sept", 9],
	["october", 10],
	["oct", 10],
	["november", 11],
	["nov", 11],
	["december", 12],
	["dec", 12],
]);

export interface TemporalTimeOptions {
	readonly start?: string;
	readonly end?: string;
	readonly facets?: readonly TemporalFacet[];
	readonly mode?: "auto" | "timeline" | "filter";
}

export interface TemporalRecallParams {
	readonly query: string;
	readonly time?: TemporalTimeOptions;
	readonly limit: number;
	readonly agentId?: string;
	readonly readPolicy?: string;
	readonly policyGroup?: string | null;
	readonly project?: string;
	readonly sessionKey?: string;
}

export interface TemporalRecallResult {
	readonly response?: {
		readonly results: readonly TemporalRecallRow[];
		readonly query: string;
		readonly method: "keyword";
		readonly meta: {
			readonly totalReturned: number;
			readonly hasSupplementary: boolean;
			readonly noHits: boolean;
			readonly temporal: RecallTemporalMeta;
		};
	};
	readonly adjustedQuery?: string;
	readonly meta?: RecallTemporalMeta;
	readonly candidateIds?: readonly string[];
}

export interface TemporalRecallRow {
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
	readonly visibility?: string | null;
	readonly scope?: string | null;
	readonly temporal_facet: TemporalFacet;
	readonly temporal_start_at: string;
	readonly temporal_end_at?: string | null;
	readonly subject_type: string;
	readonly subject_id: string;
}

interface ParsedTemporalIntent {
	readonly start: string;
	readonly end: string;
	readonly source: "query" | "request";
	readonly contentQuery: string;
	readonly mode: "timeline" | "filter";
	readonly facets: readonly TemporalFacet[];
}

interface RawTemporalRow {
	readonly id: string;
	readonly content: string;
	readonly project: string | null;
	readonly created_at: string;
	readonly source_id?: string | null;
	readonly session_id?: string | null;
	readonly source_path?: string | null;
	readonly type: string;
	readonly who: string;
	readonly importance: number;
	readonly pinned: boolean;
	readonly tags: string | null;
	readonly visibility?: string | null;
	readonly scope?: string | null;
	readonly facet: TemporalFacet;
	readonly start_at: string;
	readonly end_at: string | null;
	readonly subject_type: string;
	readonly subject_id: string;
	readonly source_rank: number;
}

function localDayRange(year: number, month: number, day: number): { start: string; end: string } | null {
	const start = new Date(year, month - 1, day);
	if (start.getFullYear() !== year || start.getMonth() !== month - 1 || start.getDate() !== day) return null;
	const end = new Date(year, month - 1, day + 1);
	return { start: start.toISOString(), end: end.toISOString() };
}

function parseExplicitDay(raw: string): { range: { start: string; end: string }; matched: string } | null {
	const numeric = raw.match(/\b(\d{4})[/-](\d{1,2})[/-](\d{1,2})\b/);
	if (numeric) {
		const year = Number.parseInt(numeric[1] ?? "", 10);
		const month = Number.parseInt(numeric[2] ?? "", 10);
		const day = Number.parseInt(numeric[3] ?? "", 10);
		const range = localDayRange(year, month, day);
		return range ? { range, matched: numeric[0] } : null;
	}

	const named = raw.match(
		/\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})(?:st|nd|rd|th)?[,]?\s+(\d{4})\b/i,
	);
	if (!named) return null;
	const month = MONTHS.get((named[1] ?? "").toLowerCase());
	if (!month) return null;
	const day = Number.parseInt(named[2] ?? "", 10);
	const year = Number.parseInt(named[3] ?? "", 10);
	const range = localDayRange(year, month, day);
	return range ? { range, matched: named[0] } : null;
}

function normalizeContentQuery(query: string, matched: string): string {
	const withoutDate = query.replace(matched, " ");
	const words = withoutDate
		.toLowerCase()
		.split(/\W+/)
		.map((word) => word.trim())
		.filter((word) => word.length > 0 && !WEAK_TEMPORAL_TERMS.has(word));
	return words.join(" ");
}

function normalizeFacets(input: readonly TemporalFacet[] | undefined): readonly TemporalFacet[] {
	if (!input || input.length === 0) return DEFAULT_TEMPORAL_FACETS;
	const allowed = new Set(DEFAULT_TEMPORAL_FACETS);
	const facets = [...new Set(input.filter((facet) => allowed.has(facet)))];
	return facets.length > 0 ? facets : DEFAULT_TEMPORAL_FACETS;
}

function parseTimeRange(time: TemporalTimeOptions | undefined): { start: string; end: string } | null {
	if (!time?.start) return null;
	const startDate = new Date(time.start);
	if (Number.isNaN(startDate.getTime())) return null;
	if (time.end) {
		const endDate = new Date(time.end);
		if (Number.isNaN(endDate.getTime())) return null;
		return { start: startDate.toISOString(), end: endDate.toISOString() };
	}
	const endDate = new Date(startDate.getTime() + 86_400_000);
	return { start: startDate.toISOString(), end: endDate.toISOString() };
}

function resolveTemporalMode(
	mode: TemporalTimeOptions["mode"] | undefined,
	contentQuery: string,
): ParsedTemporalIntent["mode"] {
	if (mode === "timeline" || mode === "filter") return mode;
	return contentQuery.length > 0 ? "filter" : "timeline";
}

export function validateTemporalTimeOptions(time: unknown): string | null {
	if (time === undefined) return null;
	if (typeof time !== "object" || time === null || Array.isArray(time)) return "time must be an object";
	const options = time as Record<string, unknown>;
	if (typeof options.start !== "string" || options.start.trim().length === 0) {
		return "time.start is required when time is provided";
	}
	const startDate = new Date(options.start);
	if (Number.isNaN(startDate.getTime())) return "time.start must be a valid ISO timestamp";
	if (options.end !== undefined) {
		if (typeof options.end !== "string" || options.end.trim().length === 0) {
			return "time.end must be a valid ISO timestamp";
		}
		const endDate = new Date(options.end);
		if (Number.isNaN(endDate.getTime())) return "time.end must be a valid ISO timestamp";
		if (endDate.getTime() <= startDate.getTime()) return "time.end must be after time.start";
	}
	if (options.facets !== undefined) {
		if (!Array.isArray(options.facets)) return "time.facets must be an array";
		for (const facet of options.facets) {
			if (typeof facet !== "string" || !TEMPORAL_FACET_SET.has(facet)) {
				return "time.facets entries must be one of: session, source, captured, observed, occurred, valid";
			}
		}
	}
	if (options.mode !== undefined && (typeof options.mode !== "string" || !TEMPORAL_MODES.has(options.mode))) {
		return "time.mode must be one of: auto, timeline, filter";
	}
	return null;
}

export function parseTemporalRecallIntent(params: {
	readonly query: string;
	readonly time?: TemporalTimeOptions;
}): ParsedTemporalIntent | null {
	const requestRange = parseTimeRange(params.time);
	if (requestRange) {
		const contentQuery = params.query.trim();
		return {
			...requestRange,
			source: "request",
			contentQuery,
			mode: resolveTemporalMode(params.time?.mode, contentQuery),
			facets: normalizeFacets(params.time?.facets),
		};
	}

	const parsed = parseExplicitDay(params.query);
	if (!parsed) return null;
	const contentQuery = normalizeContentQuery(params.query, parsed.matched);
	return {
		...parsed.range,
		source: "query",
		contentQuery,
		mode: resolveTemporalMode(params.time?.mode, contentQuery),
		facets: normalizeFacets(params.time?.facets),
	};
}

function tableExists(db: { prepare(sql: string): { get(...args: unknown[]): unknown } }, name: string): boolean {
	return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name) !== undefined;
}

function columnExists(
	db: { prepare(sql: string): { all(...args: unknown[]): Record<string, unknown>[] } },
	table: string,
	column: string,
): boolean {
	return db
		.prepare(`PRAGMA table_info(${table})`)
		.all()
		.some((row) => row.name === column);
}

function overlapClause(startExpr: string, endExpr: string): string {
	return `${startExpr} < ? AND COALESCE(${endExpr}, ${startExpr}) >= ?`;
}

function textMatches(content: string, query: string): boolean {
	if (!query) return true;
	const lower = content.toLowerCase();
	return query
		.split(/\s+/)
		.filter((term) => term.length > 0)
		.every((term) => lower.includes(term));
}

function projectSql(project: string | undefined, column = "project"): { sql: string; args: unknown[] } {
	if (!project) return { sql: "", args: [] };
	return { sql: ` AND ${column} = ?`, args: [project] };
}

function temporalFacetAllowed(facets: readonly TemporalFacet[], facet: TemporalFacet): boolean {
	return facets.includes(facet);
}

function temporalRowLimit(intent: ParsedTemporalIntent, resultLimit: number): number {
	if (intent.mode === "filter" && intent.contentQuery.length > 0) {
		return Math.max(resultLimit * TEMPORAL_FILTER_LIMIT_MULTIPLIER, TEMPORAL_FILTER_MIN_CANDIDATES);
	}
	return resultLimit;
}

function memoryVisibilitySql(params: TemporalRecallParams): { sql: string; args: unknown[] } {
	return buildAgentScopeClause(
		params.agentId ?? "default",
		params.readPolicy ?? "isolated",
		params.policyGroup ?? null,
	);
}

function temporalOwnerSql(column: string, params: TemporalRecallParams): { sql: string; args: unknown[] } {
	const agentId = params.agentId ?? "default";
	if (params.readPolicy === "group" && params.policyGroup) {
		return {
			sql: ` AND (${column} = ? OR ${column} IN (SELECT id FROM agents WHERE policy_group = ?))`,
			args: [agentId, params.policyGroup],
		};
	}
	return { sql: ` AND ${column} = ?`, args: [agentId] };
}

function shorten(content: string, maxChars: number): { content: string; truncated: boolean; length: number } {
	const oneLine = content.replace(/\s+/g, " ").trim();
	return {
		content: oneLine.length > maxChars ? `${oneLine.slice(0, maxChars - 12).trim()} [truncated]` : oneLine,
		truncated: oneLine.length > maxChars,
		length: oneLine.length,
	};
}

function toRecallRow(row: RawTemporalRow): TemporalRecallRow {
	const shortened = shorten(row.content, 900);
	return {
		id: `temporal:${row.subject_type}:${row.subject_id}:${row.facet}`,
		content: shortened.content,
		content_length: shortened.length,
		truncated: shortened.truncated,
		score: row.source_rank,
		source: `temporal_${row.facet}`,
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
		visibility: row.visibility,
		scope: row.scope,
		temporal_facet: row.facet,
		temporal_start_at: row.start_at,
		temporal_end_at: row.end_at,
		subject_type: row.subject_type,
		subject_id: row.subject_id,
	};
}

function collectTemporalRows(intent: ParsedTemporalIntent, params: TemporalRecallParams): RawTemporalRow[] {
	const rows: RawTemporalRow[] = [];

	return getDbAccessor().withReadDb((db) => {
		if (temporalFacetAllowed(intent.facets, "session") && tableExists(db, "session_summaries")) {
			const owner = temporalOwnerSql("agent_id", params);
			const project = projectSql(params.project, "project");
			const sessionRows = db
				.prepare(
					`SELECT id, content, project, session_key, harness, earliest_at, latest_at, created_at
					 FROM session_summaries
					 WHERE 1 = 1${owner.sql}
					   AND COALESCE(source_type, kind) != 'chunk'
					   AND ${overlapClause("earliest_at", "latest_at")}${project.sql}
					 ORDER BY latest_at DESC
					 LIMIT ?`,
				)
				.all(...owner.args, intent.end, intent.start, ...project.args, params.limit * 6) as Array<{
				id: string;
				content: string;
				project: string | null;
				session_key: string | null;
				harness: string | null;
				earliest_at: string;
				latest_at: string;
				created_at: string;
			}>;
			for (const row of sessionRows) {
				rows.push({
					id: row.id,
					content: row.content,
					project: row.project,
					created_at: row.created_at,
					session_id: row.session_key,
					type: "session",
					who: row.harness ?? "session",
					importance: 0.8,
					pinned: false,
					tags: "temporal,session",
					facet: "session",
					start_at: row.earliest_at,
					end_at: row.latest_at,
					subject_type: "session_summary",
					subject_id: row.id,
					source_rank: 1,
				});
			}
		}

		if (temporalFacetAllowed(intent.facets, "captured") && tableExists(db, "memories")) {
			const visibility = memoryVisibilitySql(params);
			const project = projectSql(params.project, "m.project");
			const memoryRows = db
				.prepare(
					`SELECT m.id, m.content, m.source_id, m.type, m.tags, m.pinned, m.importance, m.who, m.project,
					        m.created_at, m.visibility, m.scope
					 FROM memories m
					 WHERE m.is_deleted = 0
					   AND m.scope IS NULL
					   AND m.created_at >= ?
					   AND m.created_at < ?${visibility.sql}${project.sql}
					 ORDER BY m.created_at DESC
					 LIMIT ?`,
				)
				.all(intent.start, intent.end, ...visibility.args, ...project.args, params.limit * 4) as Array<{
				id: string;
				content: string;
				source_id: string | null;
				type: string;
				tags: string | null;
				pinned: number;
				importance: number;
				who: string;
				project: string | null;
				created_at: string;
				visibility: string | null;
				scope: string | null;
			}>;
			for (const row of memoryRows) {
				rows.push({
					id: row.id,
					content: row.content,
					project: row.project,
					created_at: row.created_at,
					source_id: row.source_id,
					type: row.type,
					who: row.who,
					importance: row.importance,
					pinned: row.pinned === 1,
					tags: row.tags,
					visibility: row.visibility,
					scope: row.scope,
					facet: "captured",
					start_at: row.created_at,
					end_at: row.created_at,
					subject_type: "memory",
					subject_id: row.id,
					source_rank: 0.7,
				});
			}
		}

		if (tableExists(db, "memory_artifacts")) {
			const owner = temporalOwnerSql("agent_id", params);
			const project = projectSql(params.project, "project");
			if (temporalFacetAllowed(intent.facets, "captured")) {
				const artifactRows = db
					.prepare(
						`SELECT rowid, source_path, source_kind, source_id, harness, project, content, captured_at, updated_at
						 FROM memory_artifacts
						 WHERE 1 = 1${owner.sql}
						   AND COALESCE(is_deleted, 0) = 0
						   AND captured_at >= ?
						   AND captured_at < ?${project.sql}
						 ORDER BY captured_at DESC
						 LIMIT ?`,
					)
					.all(...owner.args, intent.start, intent.end, ...project.args, params.limit * 4) as Array<{
					rowid: number;
					source_path: string;
					source_kind: string;
					source_id: string | null;
					harness: string | null;
					project: string | null;
					content: string;
					captured_at: string;
					updated_at: string;
				}>;
				for (const row of artifactRows) {
					rows.push({
						id: String(row.rowid),
						content: `[Source artifact: ${row.source_path}]\n${row.content}`,
						project: row.project,
						created_at: row.captured_at,
						source_id: row.source_id,
						source_path: row.source_path,
						type: row.source_kind,
						who: row.harness ?? "source",
						importance: 0.55,
						pinned: false,
						tags: "temporal,source",
						facet: "captured",
						start_at: row.captured_at,
						end_at: row.updated_at,
						subject_type: "memory_artifact",
						subject_id: String(row.rowid),
						source_rank: 0.6,
					});
				}
			}

			if (temporalFacetAllowed(intent.facets, "source") && columnExists(db, "memory_artifacts", "source_mtime_ms")) {
				const sourceAtExpr = "strftime('%Y-%m-%dT%H:%M:%fZ', source_mtime_ms / 1000, 'unixepoch')";
				const sourceRows = db
					.prepare(
						`SELECT rowid, source_path, source_kind, source_id, harness, project, content,
						        ${sourceAtExpr} AS source_at
						 FROM memory_artifacts
						 WHERE 1 = 1${owner.sql}
						   AND COALESCE(is_deleted, 0) = 0
						   AND source_mtime_ms IS NOT NULL
						   AND ${sourceAtExpr} >= ?
						   AND ${sourceAtExpr} < ?${project.sql}
						 ORDER BY source_at DESC
						 LIMIT ?`,
					)
					.all(...owner.args, intent.start, intent.end, ...project.args, params.limit * 4) as Array<{
					rowid: number;
					source_path: string;
					source_kind: string;
					source_id: string | null;
					harness: string | null;
					project: string | null;
					content: string;
					source_at: string;
				}>;
				for (const row of sourceRows) {
					rows.push({
						id: String(row.rowid),
						content: `[Source artifact: ${row.source_path}]\n${row.content}`,
						project: row.project,
						created_at: row.source_at,
						source_id: row.source_id,
						source_path: row.source_path,
						type: row.source_kind,
						who: row.harness ?? "source",
						importance: 0.6,
						pinned: false,
						tags: "temporal,source",
						facet: "source",
						start_at: row.source_at,
						end_at: row.source_at,
						subject_type: "memory_artifact",
						subject_id: String(row.rowid),
						source_rank: 0.8,
					});
				}
			}
		}

		if (tableExists(db, "temporal_edges")) {
			const visibility = memoryVisibilitySql(params);
			const nonMemoryOwner = temporalOwnerSql("te.agent_id", params);
			const edgeRows = db
				.prepare(
					`SELECT te.id, te.subject_type, te.subject_id, te.facet, te.start_at, te.end_at, te.confidence,
					        m.content AS memory_content, m.source_id, m.type AS memory_type, m.tags, m.pinned,
					        m.importance, m.who, m.project, m.created_at, m.visibility, m.scope
					 FROM temporal_edges te
					 LEFT JOIN memories m
					   ON te.subject_type = 'memory'
					  AND m.id = te.subject_id
					  AND m.is_deleted = 0
					 WHERE te.facet IN (${intent.facets.map(() => "?").join(", ")})
					   AND ${overlapClause("te.start_at", "te.end_at")}
					   AND (
					     (te.subject_type = 'memory' AND m.id IS NOT NULL AND m.scope IS NULL${visibility.sql})
					     OR (te.subject_type != 'memory'${nonMemoryOwner.sql})
					   )
					 ORDER BY te.start_at DESC
					 LIMIT ?`,
				)
				.all(
					...intent.facets,
					intent.end,
					intent.start,
					...visibility.args,
					...nonMemoryOwner.args,
					params.limit * 4,
				) as Array<{
				id: string;
				subject_type: string;
				subject_id: string;
				facet: TemporalFacet;
				start_at: string;
				end_at: string | null;
				confidence: number;
				memory_content: string | null;
				source_id: string | null;
				memory_type: string | null;
				tags: string | null;
				pinned: number | null;
				importance: number | null;
				who: string | null;
				project: string | null;
				created_at: string | null;
				visibility: string | null;
				scope: string | null;
			}>;
			for (const row of edgeRows) {
				if (params.project && row.project !== params.project) continue;
				rows.push({
					id: row.id,
					content: row.memory_content ?? `[Temporal ${row.facet}: ${row.subject_type} ${row.subject_id}]`,
					project: row.project,
					created_at: row.created_at ?? row.start_at,
					source_id: row.source_id,
					type: row.memory_type ?? row.subject_type,
					who: row.who ?? "temporal",
					importance: row.importance ?? 0.65,
					pinned: row.pinned === 1,
					tags: row.tags,
					visibility: row.visibility,
					scope: row.scope,
					facet: row.facet,
					start_at: row.start_at,
					end_at: row.end_at,
					subject_type: row.subject_type,
					subject_id: row.subject_id,
					source_rank: Math.max(0.1, Math.min(1, row.confidence)),
				});
			}
		}

		return rows;
	});
}

export function resolveTemporalRecall(params: TemporalRecallParams): TemporalRecallResult {
	const intent = parseTemporalRecallIntent({ query: params.query, time: params.time });
	if (!intent) return {};
	const rowLimit = temporalRowLimit(intent, params.limit);
	const meta: RecallTemporalMeta = {
		mode: intent.mode,
		source: intent.source,
		originalQuery: params.query,
		contentQuery: intent.contentQuery,
		start: intent.start,
		end: intent.end,
		facets: intent.facets,
	};

	const rows = collectTemporalRows(intent, { ...params, limit: rowLimit })
		.filter(
			(row) =>
				intent.mode !== "filter" || row.subject_type === "memory" || textMatches(row.content, intent.contentQuery),
		)
		.sort(
			(a, b) =>
				b.source_rank - a.source_rank ||
				b.start_at.localeCompare(a.start_at) ||
				a.subject_type.localeCompare(b.subject_type),
		);

	const deduped: RawTemporalRow[] = [];
	const seen = new Set<string>();
	for (const row of rows) {
		const key = `${row.subject_type}:${row.subject_id}:${row.facet}`;
		if (seen.has(key)) continue;
		seen.add(key);
		deduped.push(row);
		if (deduped.length >= rowLimit) break;
	}

	if (intent.mode === "filter" && intent.contentQuery.length > 0) {
		const memoryIds = deduped.filter((row) => row.subject_type === "memory").map((row) => row.subject_id);
		if (memoryIds.length > 0) {
			return { adjustedQuery: intent.contentQuery, meta, candidateIds: memoryIds };
		}
	}

	const results = deduped.slice(0, params.limit).map(toRecallRow);
	return {
		response: {
			results,
			query: params.query,
			method: "keyword",
			meta: {
				totalReturned: results.length,
				hasSupplementary: false,
				noHits: results.length === 0,
				temporal: meta,
			},
		},
	};
}

export function createTemporalEdgeId(input: {
	readonly agentId: string;
	readonly subjectType: string;
	readonly subjectId: string;
	readonly facet: TemporalFacet;
	readonly startAt: string;
}): string {
	return ["temporal", input.agentId, input.subjectType, input.subjectId, input.facet, input.startAt]
		.join(":")
		.replace(/[^a-zA-Z0-9:._-]+/g, "-");
}

export function normalizeTemporalTimestamp(value: unknown): string | null {
	if (typeof value !== "string" || value.trim().length === 0) return null;
	const parsed = new Date(value);
	if (Number.isNaN(parsed.getTime())) return null;
	return parsed.toISOString();
}
