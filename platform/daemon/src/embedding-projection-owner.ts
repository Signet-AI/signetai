import { z } from "zod";
import type { ReadDb } from "./db-accessor";
import { citedEvidenceReadScopeSql } from "./diagnostics";
import { DB_OWNER_READ_DEADLINE_MS } from "./db-owner-runtime";
import type { DbOwnerClient } from "./db-owner-client";
import { cancellableOwner } from "./db-owner-sql";
import { readScopeSql, type ReadScope } from "./read-scope";
import { escapeLike } from "./sql-utils";
import { toEmbeddingRow, type EmbeddingRow, type ProjectionFilters, type ProjectionQuery } from "./umap-projection";
import { syncEmbeddingCompartment, resetCompartmentVectorShards, type MigrationDb } from "@signet/core";
import type { EmbeddingProjectionRequest } from "./embedding-projection";

export function executeEmbeddingProjection(db: MigrationDb, request: EmbeddingProjectionRequest): { updated: number } {
	if (request.ids.length + (request.contentHashes?.length ?? 0) > 100) throw new Error("projection_admission_limit");
	const dims = request.resetDimensions;
	if (dims !== undefined && (!Number.isSafeInteger(dims) || dims < 1 || dims > 65536))
		throw new Error("invalid_dimensions");
	db.exec("BEGIN IMMEDIATE");
	try {
		const result = executeEmbeddingProjectionInTx(db, request);
		db.exec("COMMIT");
		return result;
	} catch (error) {
		db.exec("ROLLBACK");
		throw error;
	}
}
export function executeEmbeddingProjectionInTx(
	db: MigrationDb,
	request: EmbeddingProjectionRequest,
): { updated: number } {
	const dims = request.resetDimensions;
	if (request.ids.length + (request.contentHashes?.length ?? 0) > 100) throw new Error("projection_admission_limit");
	if (dims !== undefined && (!Number.isSafeInteger(dims) || dims < 1 || dims > 65536))
		throw new Error("invalid_dimensions");
	if (dims !== undefined) {
		resetCompartmentVectorShards(db, request.projection);
		db.exec(
			`DROP TABLE IF EXISTS ${request.projection};CREATE VIRTUAL TABLE ${request.projection} USING vec0(id TEXT PRIMARY KEY,embedding FLOAT[${dims}] distance_metric=cosine)`,
		);
	}
	const ids = new Set(request.ids);
	for (const hash of request.contentHashes ?? []) {
		for (const row of db.prepare(`SELECT id FROM ${request.store} WHERE content_hash=?`).all(hash))
			if (typeof row.id === "string") ids.add(row.id);
	}
	for (const id of ids) syncEmbeddingCompartment(db, request.store, id, request.projection);
	return { updated: ids.size };
}

const EMBEDDINGS_SELECT_SQL = `
	SELECT m.id, m.content, m.who, m.importance, m.type, m.tags, m.pinned,
	       m.source_type, m.source_id, m.created_at,
	       CASE WHEN typeof(e.vector)='blob' THEN hex(substr(e.vector,1,256)) END AS vector_hex, e.dimensions
`;

const EMBEDDINGS_FROM_SQL = `
	FROM embeddings e
	INNER JOIN memories m ON m.id = e.source_id
	WHERE e.source_type = 'memory'
	  AND e.vector IS NOT NULL AND length(e.vector) > 0
`;

function normalizeFilterValues(values: readonly string[] | undefined): string[] {
	if (!values) return [];
	const normalized = values.map((value) => value.trim()).filter((value) => value.length > 0);
	return [...new Set(normalized)];
}

function buildProjectionWhere(filters: ProjectionFilters | undefined): {
	clause: string;
	params: unknown[];
} {
	if (!filters) return { clause: "", params: [] };

	const parts: string[] = [];
	const params: unknown[] = [];

	const query = filters.query?.trim();
	if (query && query.length > 0) {
		const pattern = `%${escapeLike(query)}%`;
		parts.push(
			"(m.content LIKE ? ESCAPE '\\' OR m.tags LIKE ? ESCAPE '\\' OR m.who LIKE ? ESCAPE '\\' OR m.type LIKE ? ESCAPE '\\' OR m.source_type LIKE ? ESCAPE '\\' OR m.source_id LIKE ? ESCAPE '\\')",
		);
		params.push(pattern, pattern, pattern, pattern, pattern, pattern);
	}

	const whoValues = normalizeFilterValues(filters.who);
	if (whoValues.length > 0) {
		parts.push(`m.who IN (${whoValues.map(() => "?").join(", ")})`);
		params.push(...whoValues);
	}

	const typeValues = normalizeFilterValues(filters.types);
	if (typeValues.length > 0) {
		parts.push(`m.type IN (${typeValues.map(() => "?").join(", ")})`);
		params.push(...typeValues);
	}

	const sourceTypeValues = normalizeFilterValues(filters.sourceTypes);
	if (sourceTypeValues.length > 0) {
		parts.push(`m.source_type IN (${sourceTypeValues.map(() => "?").join(", ")})`);
		params.push(...sourceTypeValues);
	}

	const tagValues = normalizeFilterValues(filters.tags);
	for (const tag of tagValues) {
		parts.push("m.tags LIKE ? ESCAPE '\\'");
		params.push(`%${escapeLike(tag)}%`);
	}

	if (typeof filters.pinned === "boolean") {
		parts.push("m.pinned = ?");
		params.push(filters.pinned ? 1 : 0);
	}

	if (typeof filters.since === "string" && filters.since.length > 0) {
		parts.push("m.created_at >= ?");
		params.push(filters.since);
	}

	if (typeof filters.until === "string" && filters.until.length > 0) {
		parts.push("m.created_at <= ?");
		params.push(filters.until);
	}

	if (typeof filters.importanceMin === "number" && Number.isFinite(filters.importanceMin)) {
		parts.push("m.importance >= ?");
		params.push(filters.importanceMin);
	}

	if (typeof filters.importanceMax === "number" && Number.isFinite(filters.importanceMax)) {
		parts.push("m.importance <= ?");
		params.push(filters.importanceMax);
	}

	return {
		clause: parts.length > 0 ? ` AND ${parts.join(" AND ")}` : "",
		params,
	};
}

export interface ProjectionRowsResult {
	readonly rows: EmbeddingRow[];
	readonly total: number;
	readonly offset: number;
	readonly limit: number;
	readonly hasMore: boolean;
}

function projectionStatements(query: ProjectionQuery & { readonly scope: ReadScope }) {
	const offset =
		typeof query.offset === "number" && Number.isFinite(query.offset) ? Math.max(0, Math.trunc(query.offset)) : 0;
	const requestedLimit =
		typeof query.limit === "number" && Number.isFinite(query.limit) ? Math.max(1, Math.trunc(query.limit)) : null;

	const filtered = buildProjectionWhere(query.filters);
	const scoped = readScopeSql("m", query.scope);
	const embeddingScope = readScopeSql(
		"e",
		{ ...query.scope, reach: { kind: "all" }, projects: null },
		{ visibility: null, memory: "source_id", session: null, source: null },
	);
	const copied = citedEvidenceReadScopeSql("m", query.scope, "memory");
	const clause =
		filtered.clause + scoped.sql + embeddingScope.sql + copied.sql + " AND m.is_deleted = 0 AND e.agent_id=m.agent_id";
	const params = [...filtered.params, ...scoped.args, ...embeddingScope.args, ...copied.args];

	let sql = `${EMBEDDINGS_SELECT_SQL} ${EMBEDDINGS_FROM_SQL}${clause} ORDER BY m.created_at DESC, m.id ASC, e.id ASC`;
	const rowParams: unknown[] = [...params];
	if (requestedLimit !== null) {
		sql += " LIMIT ? OFFSET ?";
		rowParams.push(requestedLimit + 1, offset);
	} else if (offset > 0) {
		sql += " LIMIT -1 OFFSET ?";
		rowParams.push(offset);
	}

	return { sql, rowParams, params, clause, requestedLimit, offset };
}

function projectionRowsResult(
	rawRows: Record<string, unknown>[],
	requestedLimit: number | null,
	offset: number,
	total?: { count?: number },
): ProjectionRowsResult {
	const rows = rawRows
		.map((row) =>
			toEmbeddingRow({
				...row,
				vector: typeof row.vector_hex === "string" ? Buffer.from(row.vector_hex, "hex") : row.vector,
			}),
		)
		.filter((row): row is EmbeddingRow => row !== null);
	const trimmedRows = requestedLimit !== null ? rows.slice(0, requestedLimit) : rows;

	let effectiveTotal: number;
	let hasMore: boolean;

	if (requestedLimit !== null) {
		hasMore = rows.length > requestedLimit;

		const totalRow = total;
		effectiveTotal = totalRow != null && typeof totalRow.count === "number" ? totalRow.count : 0;

		if (rawRows.length !== rows.length && !hasMore) {
			hasMore = offset + trimmedRows.length < effectiveTotal;
		}
	} else {
		effectiveTotal = rows.length + offset;
		hasMore = false;
	}

	const limit = requestedLimit ?? Math.max(0, effectiveTotal - offset);

	return { rows: trimmedRows, total: effectiveTotal, offset, limit, hasMore };
}

export async function loadProjectionRowsAsync(
	owner: DbOwnerClient,
	query: ProjectionQuery & { readonly scope: ReadScope },
	signal?: AbortSignal,
): Promise<ProjectionRowsResult> {
	if (!query.scope) throw new Error("projection_read_scope_required");
	const plan = projectionStatements({ ...query, limit: Math.min(query.limit ?? 5000, 5000) });
	const client = cancellableOwner(owner, signal);
	const deadlineAt = Date.now() + DB_OWNER_READ_DEADLINE_MS;
	const options = () =>
		({
			operation: "embeddings.projection.read",
			lane: "read",
			deadlineMs: Math.max(1, deadlineAt - Date.now()),
			signal,
		}) as const;
	const total = z
		.object({ count: z.number() })
		.parse(await client.submit({ kind: "projection_read", op: "count", query }, options()).result);
	if (!total) throw new Error("projection_count_unavailable");
	const rawRows: Record<string, unknown>[] = [];
	const target = (plan.requestedLimit ?? 5000) + 1;
	while (rawRows.length < target) {
		signal?.throwIfAborted();
		if (Date.now() >= deadlineAt) throw new Error("projection_read_deadline");
		const take = Math.min(100, target - rawRows.length);
		const batch = z
			.array(z.record(z.string(), z.unknown()))
			.parse(
				await client.submit(
					{ kind: "projection_read", op: "rows", query, offset: plan.offset + rawRows.length, limit: take },
					options(),
				).result,
			);
		rawRows.push(...batch);
		if (batch.length < take) break;
	}
	return projectionRowsResult(rawRows, plan.requestedLimit, plan.offset, total);
}

export function executeProjectionReadInOwner(
	db: ReadDb,
	request: Extract<import("./db-owner-protocol").DbOwnerRequest, { kind: "projection_read" }>,
): unknown {
	const plan = projectionStatements({ ...request.query, limit: Math.min(request.query.limit ?? 5000, 5000) });
	if (request.op === "count")
		return db
			.prepare(`SELECT COUNT(*) AS count ${EMBEDDINGS_FROM_SQL}${plan.clause} AND typeof(e.vector)='blob'`)
			.get(...plan.params);
	if (
		!Number.isSafeInteger(request.limit) ||
		request.limit < 1 ||
		request.limit > 100 ||
		!Number.isSafeInteger(request.offset) ||
		request.offset < 0
	)
		throw new Error("projection_batch_limit");
	return db.prepare(plan.sql).all(...plan.rowParams.slice(0, -2), request.limit, request.offset);
}
