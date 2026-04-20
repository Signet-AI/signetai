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
	readonly who?: string;
	readonly type?: string;
	readonly tags?: string | null;
	readonly pinned?: boolean | number;
	readonly project?: string | null;
	readonly importance?: number;
}

export interface RecallMeta {
	readonly totalReturned: number;
	readonly hasSupplementary: boolean;
	readonly noHits: boolean;
}

export interface RecallPayload {
	readonly query?: string;
	readonly method?: string;
	readonly results?: ReadonlyArray<RecallRow>;
	readonly meta?: Partial<RecallMeta>;
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
	readonly expand?: boolean;
	readonly agentId?: string;
	readonly scope?: "global" | "agent" | "session";
}

export interface RememberRequestOptions {
	readonly type?: string;
	readonly importance?: number;
	readonly tags?: string | readonly string[];
	readonly who?: string;
	readonly pinned?: boolean;
	readonly sourceType?: string;
	readonly sourceId?: string;
	readonly createdAt?: string;
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
	return { totalReturned, hasSupplementary, noHits };
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

export function formatRecallText(raw: unknown): string {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return typeof raw === "string" ? raw : JSON.stringify(raw, null, 2);
	}

	const payload = raw as RecallPayload;
	const parsed = parseRecallPayload(payload);
	if (parsed.message && parsed.rows.length === 0) return parsed.message;
	if (parsed.meta.noHits || parsed.rows.length === 0) return "No matching memories found.";

	const { primary, supporting } = partitionRecallRows(parsed.rows);
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
		expand: options.expand === true ? true : undefined,
		agentId: options.agentId,
		scope: options.scope,
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
		createdAt: options.createdAt,
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
