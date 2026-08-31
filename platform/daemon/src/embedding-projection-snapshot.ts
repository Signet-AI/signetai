import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { escapeLike } from "./sql-utils";
import {
	PROJECTION_CONTENT_MAX_CHARS,
	PROJECTION_MAX_ROWS,
	PROJECTION_SNAPSHOT_MAX_BYTES,
	PROJECTION_VECTOR_DIMENSIONS,
	type ProjectionPrincipal,
	type ProjectionRequest,
	type ProjectionSnapshotDescriptor,
	type ProjectionSnapshotWire,
} from "./embedding-projection-contract";

interface SqliteStatement {
	all(...params: readonly unknown[]): unknown[];
	get(...params: readonly unknown[]): unknown;
}
interface SnapshotDb {
	prepare(sql: string): SqliteStatement;
	exec(sql: string): void;
}

function values(input: readonly string[] | undefined): string[] {
	return [...new Set((input ?? []).map((item) => item.trim()).filter(Boolean))];
}

function whereFilters(filters: ProjectionRequest["filters"]): { clause: string; params: unknown[] } {
	const parts: string[] = [];
	const params: unknown[] = [];
	const query = filters.query?.trim();
	if (query) {
		const pattern = `%${escapeLike(query)}%`;
		parts.push(
			"(m.content LIKE ? ESCAPE '\\' OR m.tags LIKE ? ESCAPE '\\' OR m.who LIKE ? ESCAPE '\\' OR m.type LIKE ? ESCAPE '\\' OR m.source_type LIKE ? ESCAPE '\\' OR m.source_id LIKE ? ESCAPE '\\')",
		);
		params.push(pattern, pattern, pattern, pattern, pattern, pattern);
	}
	const addIn = (column: string, items: readonly string[] | undefined): void => {
		const normalized = values(items);
		if (normalized.length === 0) return;
		parts.push(`${column} IN (${normalized.map(() => "?").join(",")})`);
		params.push(...normalized);
	};
	addIn("m.who", filters.who);
	addIn("m.type", filters.types);
	addIn("m.source_type", filters.sourceTypes);
	for (const tag of values(filters.tags)) {
		parts.push("m.tags LIKE ? ESCAPE '\\'");
		params.push(`%${escapeLike(tag)}%`);
	}
	if (typeof filters.pinned === "boolean") {
		parts.push("m.pinned = ?");
		params.push(filters.pinned ? 1 : 0);
	}
	if (filters.since) {
		parts.push("m.created_at >= ?");
		params.push(filters.since);
	}
	if (filters.until) {
		parts.push("m.created_at <= ?");
		params.push(filters.until);
	}
	if (typeof filters.importanceMin === "number") {
		parts.push("m.importance >= ?");
		params.push(filters.importanceMin);
	}
	if (typeof filters.importanceMax === "number") {
		parts.push("m.importance <= ?");
		params.push(filters.importanceMax);
	}
	return { clause: parts.length === 0 ? "" : ` AND ${parts.join(" AND ")}`, params };
}

export function createProjectionSnapshotArtifact(
	db: SnapshotDb,
	principal: ProjectionPrincipal,
	request: ProjectionRequest,
	outputDirectory: string,
): ProjectionSnapshotDescriptor {
	const limit = Math.min(PROJECTION_MAX_ROWS, request.limit);
	const { clause, params } = whereFilters(request.filters);
	const scope =
		" AND COALESCE(NULLIF(m.agent_id, ''), 'default') = ? AND (? IS NULL OR m.project = ?) AND COALESCE(m.is_deleted, 0) = 0 AND (m.superseded_by IS NULL OR m.superseded_by = '')";
	const scopedParams = [principal.agentId, principal.project, principal.project, ...params];
	const from = `FROM embeddings e INNER JOIN memories m ON m.id = e.source_id WHERE e.source_type = 'memory' AND e.vector IS NOT NULL AND typeof(e.vector) = 'blob' AND length(e.vector) >= 4${scope}${clause}`;
	const countRow = db.prepare(`SELECT COUNT(*) AS count ${from}`).get(...scopedParams) as
		| { count?: number }
		| undefined;
	const total = typeof countRow?.count === "number" ? countRow.count : 0;
	const rows = db
		.prepare(
			`SELECT m.id, substr(m.content, 1, ${PROJECTION_CONTENT_MAX_CHARS}) AS content, m.who, m.importance, m.type, m.tags, m.pinned, m.source_type, m.source_id, m.created_at, hex(substr(e.vector, 1, ${PROJECTION_VECTOR_DIMENSIONS * 4})) AS vectorHex, e.dimensions ${from} ORDER BY m.created_at DESC, m.id DESC LIMIT ? OFFSET ?`,
		)
		.all(...scopedParams, limit, request.offset) as Record<string, unknown>[];
	const wire: ProjectionSnapshotWire = {
		version: 1,
		principal,
		request,
		rows,
	};
	const payload = Buffer.from(JSON.stringify(wire), "utf8");
	if (payload.byteLength > PROJECTION_SNAPSHOT_MAX_BYTES)
		throw new Error(`Embedding projection snapshot exceeds ${PROJECTION_SNAPSHOT_MAX_BYTES} bytes`);
	mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
	const snapshotId = randomUUID();
	const path = join(outputDirectory, `projection-${snapshotId}.json`);
	const temporary = `${path}.tmp`;
	writeFileSync(temporary, payload, { mode: 0o600 });
	chmodSync(temporary, 0o600);
	renameSync(temporary, path);
	return {
		version: 1,
		snapshotId,
		path,
		outputDirectory,
		sizeBytes: payload.byteLength,
		total,
		count: rows.length,
		limit,
		offset: request.offset,
		hasMore: request.offset + rows.length < total,
		sampled: request.offset > 0 ? request.offset + rows.length !== total : total > rows.length,
		selection: "recency-v1",
	};
}
