export interface RecallScoreFilterRow {
	readonly score?: number;
	readonly supplementary?: boolean;
}

export interface RecallPartitionableRow {
	readonly supplementary?: boolean;
}

export interface RecallRow extends RecallPartitionableRow {
	readonly id?: string;
	readonly content?: string;
	readonly created_at?: string;
	readonly score?: number;
	readonly source?: string;
	readonly source_id?: string;
	readonly source_path?: string;
	readonly who?: string;
	readonly type?: string;
	readonly tags?: string | null;
	readonly pinned?: boolean | number;
	readonly project?: string | null;
	readonly importance?: number;
	readonly already_recalled?: boolean;
	readonly temporal_facet?: TemporalFacet;
	readonly temporal_start_at?: string;
	readonly temporal_end_at?: string | null;
	readonly subject_type?: string;
	readonly subject_id?: string;
}

export interface RecallMeta {
	readonly totalReturned: number;
	readonly hasSupplementary: boolean;
	readonly noHits: boolean;
	readonly temporal?: RecallTemporalMeta;
	readonly dedupe?: {
		readonly enabled: boolean;
		readonly contextEpoch?: number;
		readonly suppressed: number;
		readonly repeatedReturned: number;
	};
}

export type AggregateRecallBudget = "small" | "medium" | "large";

export type TemporalFacet = "captured" | "session" | "source" | "observed" | "occurred" | "valid";

export interface RecallTimeOptions {
	readonly start?: string;
	readonly end?: string;
	readonly facets?: readonly TemporalFacet[];
	readonly mode?: "auto" | "timeline" | "filter";
}

export interface RecallTemporalMeta {
	readonly mode: "timeline" | "filter";
	readonly source: "query" | "request";
	readonly originalQuery: string;
	readonly contentQuery: string;
	readonly start: string;
	readonly end: string;
	readonly facets: readonly TemporalFacet[];
}

export interface AggregateRecallMeta {
	readonly savedMemoryId: string | null;
	readonly saved: boolean;
	readonly deduped: boolean;
	readonly budget: AggregateRecallBudget;
	readonly queries: readonly string[];
	readonly sourceMemoryIds: readonly string[];
	readonly stoppedReason: "complete" | "no_evidence" | "router_unavailable" | "synthesis_failed";
	readonly usage?: AggregateRecallUsage;
}

export interface AggregateRecallUsage {
	readonly inputTokens: number | null;
	readonly outputTokens: number | null;
	readonly cacheReadTokens: number | null;
	readonly cacheCreationTokens: number | null;
	readonly totalCost: number | null;
	readonly totalDurationMs: number | null;
	readonly stages: readonly AggregateRecallUsageStage[];
}

export interface AggregateRecallUsageStage {
	readonly name: "planning" | "synthesis";
	readonly targetRef: string | null;
	readonly attemptCount: number;
	readonly fallbackCount: number;
	readonly inputTokens: number | null;
	readonly outputTokens: number | null;
	readonly cacheReadTokens: number | null;
	readonly cacheCreationTokens: number | null;
	readonly totalCost: number | null;
	readonly totalDurationMs: number | null;
}

export interface RecallPayload {
	readonly query?: string;
	readonly method?: string;
	readonly results?: ReadonlyArray<RecallRow>;
	readonly meta?: Partial<RecallMeta>;
	readonly aggregate?: AggregateRecallMeta;
	readonly memories?: ReadonlyArray<RecallRow>;
	readonly count?: number;
	readonly message?: string;
}

interface RecallScoreFilterPayload {
	readonly results?: ReadonlyArray<RecallScoreFilterRow>;
	readonly meta?: unknown;
}

export interface RecallRequestOptions {
	readonly keywordQuery?: string;
	readonly keyword_query?: string;
	readonly limit?: number;
	readonly project?: string;
	readonly type?: string;
	readonly tags?: string;
	readonly who?: string;
	readonly pinned?: boolean;
	readonly importance_min?: number;
	readonly since?: string;
	readonly until?: string;
	readonly time?: RecallTimeOptions;
	readonly expand?: boolean;
	readonly agentId?: string;
	readonly sessionKey?: string;
	readonly includeRecalled?: boolean;
	readonly scope?: "global" | "agent" | "session";
	readonly sourceOnly?: boolean;
	readonly aggregate?: boolean;
	readonly aggregateBudget?: AggregateRecallBudget;
	readonly aggregate_budget?: AggregateRecallBudget;
	readonly saveAggregate?: boolean;
	readonly save_aggregate?: boolean;
}

export interface RememberRequestOptions {
	readonly type?: string;
	readonly importance?: number;
	readonly tags?: string | readonly string[];
	readonly who?: string;
	readonly pinned?: boolean;
	readonly sourceType?: string;
	readonly sourceId?: string;
	readonly sourcePath?: string;
	readonly createdAt?: string;
	readonly occurredAt?: string;
	readonly observedAt?: string;
	readonly validFrom?: string;
	readonly validUntil?: string;
	readonly sourceCreatedAt?: string;
	readonly hints?: readonly string[];
	readonly transcript?: string;
	readonly structured?: unknown;
	readonly agentId?: string;
	readonly visibility?: "global" | "private" | "archived";
	readonly mode?: "auto" | "sync" | "async";
	readonly idempotencyKey?: string;
	readonly runtimePath?: string;
	readonly harness?: string;
	readonly source?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function withDefined<T extends Record<string, unknown>>(value: T): Partial<T> {
	return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>;
}

function normalizeRememberTags(tags: string | readonly string[] | undefined): string | undefined {
	if (typeof tags === "string") {
		const value = tags
			.split(",")
			.map((tag) => tag.trim())
			.filter((tag) => tag.length > 0)
			.join(",");
		return value.length > 0 ? value : undefined;
	}

	if (Array.isArray(tags)) {
		const value = tags
			.map((tag) => tag.trim())
			.filter((tag) => tag.length > 0)
			.join(",");
		return value.length > 0 ? value : undefined;
	}

	return undefined;
}

export function partitionRecallRows<T extends RecallPartitionableRow>(
	rows: ReadonlyArray<T>,
): {
	readonly primary: T[];
	readonly supporting: T[];
} {
	return {
		primary: rows.filter((row) => row.supplementary !== true),
		supporting: rows.filter((row) => row.supplementary === true),
	};
}

export function parseRecallMeta(raw: unknown, fallbackCount: number): RecallMeta {
	if (!isRecord(raw)) {
		return {
			totalReturned: fallbackCount,
			hasSupplementary: false,
			noHits: fallbackCount === 0,
		};
	}

	const totalReturned = typeof raw.totalReturned === "number" ? raw.totalReturned : fallbackCount;
	const hasSupplementary = raw.hasSupplementary === true;
	const noHits = "noHits" in raw ? raw.noHits === true : totalReturned === 0;
	const dedupe = isRecord(raw.dedupe)
		? {
				enabled: raw.dedupe.enabled === true,
				contextEpoch: typeof raw.dedupe.contextEpoch === "number" ? raw.dedupe.contextEpoch : undefined,
				suppressed: typeof raw.dedupe.suppressed === "number" ? raw.dedupe.suppressed : 0,
				repeatedReturned: typeof raw.dedupe.repeatedReturned === "number" ? raw.dedupe.repeatedReturned : 0,
			}
		: undefined;
	const temporal = isRecord(raw.temporal) ? (raw.temporal as unknown as RecallTemporalMeta) : undefined;
	return { totalReturned, hasSupplementary, noHits, ...(dedupe ? { dedupe } : {}), ...(temporal ? { temporal } : {}) };
}

export function parseRecallPayload(raw: unknown): {
	readonly query?: string;
	readonly method?: string;
	readonly rows: RecallRow[];
	readonly meta: RecallMeta;
	readonly message?: string;
} {
	const payload = isRecord(raw) ? raw : {};
	const results = Array.isArray(payload.results)
		? payload.results
		: Array.isArray(payload.memories)
			? payload.memories
			: [];
	const rows = results.filter(isRecord) as RecallRow[];
	return {
		query: typeof payload.query === "string" ? payload.query : undefined,
		method: typeof payload.method === "string" ? payload.method : undefined,
		rows,
		meta: parseRecallMeta(payload.meta, rows.length),
		message: typeof payload.message === "string" ? payload.message : undefined,
	};
}

export function applyRecallScoreThreshold(raw: unknown, minScore?: number): unknown {
	if (
		typeof minScore !== "number" ||
		!Number.isFinite(minScore) ||
		typeof raw !== "object" ||
		raw === null ||
		Array.isArray(raw)
	) {
		return raw;
	}

	const payload = raw as RecallScoreFilterPayload;
	const rows = Array.isArray(payload.results) ? payload.results : [];
	// Keep unscored rows such as supplementary summaries in-band. Callers use
	// score thresholds to trim ranked matches, not to strip contextual cards
	// that do not participate in numeric ranking.
	const filtered = rows.filter((row) => typeof row.score !== "number" || row.score >= minScore);

	return {
		...payload,
		results: filtered,
		meta: {
			totalReturned: filtered.length,
			hasSupplementary: filtered.some((row) => row.supplementary === true),
			noHits: filtered.length === 0,
			...(isRecord(payload.meta) && isRecord(payload.meta.dedupe) ? { dedupe: payload.meta.dedupe } : {}),
			...(isRecord(payload.meta) && isRecord(payload.meta.temporal) ? { temporal: payload.meta.temporal } : {}),
		},
	};
}

function formatDate(value: unknown): string {
	return typeof value === "string" && value.length > 0 ? value.slice(0, 10) : "unknown";
}

function formatRecallRow(row: RecallRow, options?: { readonly includeIndex?: number }): string {
	const score = typeof row.score === "number" ? `[${(row.score * 100).toFixed(0)}%] ` : "";
	const source = typeof row.source === "string" ? row.source : "unknown";
	const type = typeof row.type === "string" ? row.type : "memory";
	const who = typeof row.who === "string" && row.who.length > 0 ? `, by ${row.who}` : "";
	const createdAt = formatDate(row.created_at);
	const id = typeof row.id === "string" && row.id.length > 0 ? `id: ${row.id}; ` : "";
	const prefix = options?.includeIndex ? `${options.includeIndex}. ` : "- ";
	return `${prefix}${score}${id}${row.content ?? ""} (${type}, ${source}, ${createdAt}${who})`;
}

function temporalGroupLabel(row: RecallRow): string {
	if (row.temporal_facet === "session") return "Sessions";
	if (row.temporal_facet === "source") return "Source Activity";
	if (row.temporal_facet === "occurred" || row.temporal_facet === "observed" || row.temporal_facet === "valid") {
		return "Events";
	}
	return "Memories Captured";
}

function formatTemporalDate(value: string): string {
	const parsed = new Date(value);
	if (Number.isNaN(parsed.getTime())) return value.slice(0, 10);
	return parsed.toLocaleDateString("en-US", {
		month: "long",
		day: "numeric",
		year: "numeric",
		timeZone: "UTC",
	});
}

function formatTemporalRecallText(rows: readonly RecallRow[], meta: RecallTemporalMeta): string {
	const parts = [formatTemporalDate(meta.start)];
	const groups = new Map<string, RecallRow[]>();
	for (const row of rows) {
		const label = temporalGroupLabel(row);
		groups.set(label, [...(groups.get(label) ?? []), row]);
	}
	for (const label of ["Sessions", "Source Activity", "Events", "Memories Captured"]) {
		const group = groups.get(label);
		if (!group || group.length === 0) continue;
		parts.push("", label, ...group.map((row) => formatRecallRow(row)));
	}
	return parts.join("\n");
}

export function formatRecallText(raw: unknown): string {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return typeof raw === "string" ? raw : JSON.stringify(raw, null, 2);
	}

	const payload = raw as RecallPayload;
	const parsed = parseRecallPayload(payload);
	if (parsed.message && parsed.rows.length === 0) return parsed.message;
	if (parsed.meta.noHits || parsed.rows.length === 0) return "No matching memories found.";

	const { primary, supporting } = partitionRecallRows(parsed.rows);
	if (parsed.meta.temporal?.mode === "timeline") return formatTemporalRecallText(primary, parsed.meta.temporal);
	const noun = parsed.meta.totalReturned === 1 ? "memory" : "memories";
	const parts = [`Found ${parsed.meta.totalReturned} ${noun}${parsed.method ? ` (${parsed.method})` : ""}.`];

	if (primary.length > 0) {
		parts.push("", "Primary matches:", ...primary.map((row) => formatRecallRow(row)));
	}

	if (supporting.length > 0) {
		parts.push("", "Supporting context:", ...supporting.map((row) => formatRecallRow(row)));
	}

	return parts.join("\n");
}

export function buildRecallRequestBody(query: string, options: RecallRequestOptions = {}): Record<string, unknown> {
	return withDefined({
		query,
		keywordQuery: options.keywordQuery ?? options.keyword_query,
		limit: options.limit,
		project: options.project,
		type: options.type,
		tags: options.tags,
		who: options.who,
		pinned: options.pinned === true ? true : undefined,
		importance_min: options.importance_min,
		since: options.since,
		until: options.until,
		time: options.time,
		expand: options.expand === true ? true : undefined,
		agentId: options.agentId,
		sessionKey: options.sessionKey,
		includeRecalled: options.includeRecalled === true ? true : undefined,
		scope: options.scope,
		sourceOnly: options.sourceOnly === true ? true : undefined,
		aggregate: options.aggregate === true ? true : undefined,
		aggregateBudget: options.aggregateBudget ?? options.aggregate_budget,
		saveAggregate:
			options.saveAggregate === false || options.save_aggregate === false
				? false
				: options.saveAggregate === true || options.save_aggregate === true
					? true
					: undefined,
	});
}

export function normalizeStructuredMemoryPayload(value: unknown): unknown {
	if (!isRecord(value)) return value;
	const aspects = value.aspects;
	if (!Array.isArray(aspects)) return value;

	return {
		...value,
		aspects: aspects.map((aspect) => {
			if (!isRecord(aspect)) return aspect;
			if (typeof aspect.entityName === "string" && Array.isArray(aspect.attributes)) return aspect;
			if (typeof aspect.entity === "string" && typeof aspect.aspect === "string" && typeof aspect.value === "string") {
				return {
					entityName: aspect.entity,
					aspect: aspect.aspect,
					attributes: [
						withDefined({
							content: aspect.value,
							groupKey: typeof aspect.groupKey === "string" ? aspect.groupKey : undefined,
							claimKey: typeof aspect.claimKey === "string" ? aspect.claimKey : undefined,
							confidence: typeof aspect.confidence === "number" ? aspect.confidence : undefined,
							importance: typeof aspect.importance === "number" ? aspect.importance : undefined,
						}),
					],
				};
			}
			return aspect;
		}),
	};
}

export function buildRememberRequestBody(
	content: string,
	options: RememberRequestOptions = {},
): Record<string, unknown> {
	return withDefined({
		content,
		type: options.type,
		importance: options.importance,
		tags: normalizeRememberTags(options.tags),
		who: options.who,
		pinned: options.pinned === true ? true : undefined,
		sourceType: options.sourceType,
		sourceId: options.sourceId,
		sourcePath: options.sourcePath,
		createdAt: options.createdAt,
		occurredAt: options.occurredAt,
		observedAt: options.observedAt,
		validFrom: options.validFrom,
		validUntil: options.validUntil,
		sourceCreatedAt: options.sourceCreatedAt,
		hints: options.hints,
		transcript: options.transcript,
		structured: normalizeStructuredMemoryPayload(options.structured),
		agentId: options.agentId,
		visibility: options.visibility,
		mode: options.mode,
		idempotencyKey: options.idempotencyKey,
		runtimePath: options.runtimePath,
		harness: options.harness,
		source: options.source,
	});
}

export function withHookRecallCompat<T extends { readonly results: ReadonlyArray<unknown> }>(
	result: T,
): T & { readonly memories: T["results"]; readonly count: number; readonly message: string } {
	return {
		...result,
		memories: result.results,
		count: result.results.length,
		message: formatRecallText(result),
	};
}

export function emptyHookRecallResponse(
	query: string,
	extras?: { readonly bypassed?: boolean; readonly internal?: boolean },
): {
	readonly results: [];
	readonly memories: [];
	readonly count: 0;
	readonly query: string;
	readonly method: "hybrid";
	readonly meta: RecallMeta;
	readonly message: string;
	readonly bypassed?: boolean;
	readonly internal?: boolean;
} {
	const response = {
		results: [] as [],
		memories: [] as [],
		count: 0 as const,
		query,
		method: "hybrid" as const,
		meta: {
			totalReturned: 0,
			hasSupplementary: false,
			noHits: true,
		},
		message: "No matching memories found.",
	};
	return {
		...response,
		...(extras?.bypassed ? { bypassed: true } : {}),
		...(extras?.internal ? { internal: true } : {}),
	};
}
