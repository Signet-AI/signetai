import { createRequire } from "node:module";
import { DEFAULT_HYBRID_ALPHA } from "./constants";
import { selectShardTables, admittedVectorPartitions, VectorAdmissionLimitError } from "./compartment-shards";
import { readScopeSql, type ReadScope } from "./read-scope";
import { redactCredentials } from "./credential-detection";
import type { Memory } from "./types";
let native: typeof import("@signet/native") | null = null;
try {
	const esmRequire = createRequire(import.meta.url);
	native = esmRequire("@signet/native");
} catch {}

function safeParseTags(raw: string | null): string[] {
	if (!raw) return [];
	try {
		return JSON.parse(raw);
	} catch {
		return [];
	}
}

export interface SearchOptions {
	readScope: ReadScope;
	query: string;
	limit?: number;
	alpha?: number;
	type?: string;
	minScore?: number;
	topK?: number;
}

export interface VectorSearchOptions {
	readonly shardNames?: readonly string[];
	readScope: ReadScope;
	limit?: number;
	type?: string;
	excludeAggregateRecall?: boolean;
	currentOnly?: boolean;
	memoryScope?: string | null;
	maxScanRows?: number;
	readonly tags?: string;
	readonly who?: string;
	readonly pinned?: boolean;
	readonly importanceMin?: number;
	readonly since?: string;
	readonly until?: string;
	readonly project?: string;
}

export interface HybridSearchOptions {
	readScope: ReadScope;
	limit?: number;
	alpha?: number;
	minScore?: number;
	topK?: number;
	type?: string;
}

export interface SearchResult {
	id: string;
	content: string;
	score: number;
	type: string;
	source: "vector" | "keyword" | "hybrid";
	tags?: string[];
	confidence?: number;
}
interface SQLiteDatabase {
	exec?(sql: string): void;
	prepare(sql: string): {
		run(...args: unknown[]): void;
		get(...args: unknown[]): Record<string, unknown> | null | undefined;
		all(...args: unknown[]): Record<string, unknown>[];
	};
}
interface DatabaseWrapper {
	db: SQLiteDatabase | null;
	getMemories(type?: string): Memory[];
}

export function buildFtsMatchQuery(query: string): string | null {
	const terms = query
		.toLowerCase()
		.split(/[^\p{L}\p{N}_]+/u)
		.map((term) => term.trim())
		.filter((term) => term.length > 0);
	if (terms.length === 0) return null;
	return terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" ");
}
function blobToVector(blob: Buffer | ArrayBuffer): Float32Array {
	if (blob instanceof ArrayBuffer) {
		return new Float32Array(blob);
	}
	return new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
}
function tsCosineSimilarity(a: Float32Array, b: Float32Array): number {
	if (a.length === 0 || a.length !== b.length) return 0;
	let dot = 0;
	let normA = 0;
	let normB = 0;

	for (let i = 0; i < a.length; i++) {
		const left = a[i] ?? Number.NaN;
		const right = b[i] ?? Number.NaN;
		if (!Number.isFinite(left) || !Number.isFinite(right)) return 0;
		dot += left * right;
		normA += left * left;
		normB += right * right;
	}

	const denom = Math.sqrt(normA) * Math.sqrt(normB);
	return Number.isFinite(denom) && denom > 0 ? dot / denom : 0;
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
	if (a.length === 0 || a.length !== b.length || !a.every(Number.isFinite) || !b.every(Number.isFinite)) return 0;
	if (native !== null) {
		const score = native.cosineSimilarity(a, b);
		return Number.isFinite(score) ? Math.max(-1, Math.min(1, score)) : 0;
	}
	return tsCosineSimilarity(a, b);
}
interface VectorSearchTables {
	readonly projection: "vec_embeddings" | "vec_embeddings_staging";
	readonly embeddings: "embeddings" | "embeddings_staging";
}

export type VectorSearchCompleteness = "complete" | "recent-window" | "unavailable";

export interface VectorSearchResponse {
	readonly results: Array<{ id: string; score: number }>;
	readonly completeness: VectorSearchCompleteness;
	readonly searchedWindow?: number;
	readonly degraded?: readonly "vector_fanout_cap"[];
}

function withReadTransaction(db: SQLiteDatabase, read: () => void): void {
	if (db.exec === undefined) {
		read();
		return;
	}
	db.exec("BEGIN");
	try {
		read();
		db.exec("COMMIT");
	} catch (error) {
		db.exec("ROLLBACK");
		throw error;
	}
}

export function activeVectorProjectionTable(db: {
	prepare(sql: string): { get(...args: unknown[]): unknown };
}): "vec_embeddings" | "vec_embeddings_staging" {
	return activeVectorSearchTables(db).projection;
}
export function activeVectorSearchTables(db: {
	prepare(sql: string): { get(...args: unknown[]): unknown };
}): VectorSearchTables {
	if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='embedding_index_state'").get())
		return { projection: "vec_embeddings", embeddings: "embeddings" };
	const row = db
		.prepare("SELECT active_profile_json,state,staging_profile_json FROM embedding_index_state WHERE id=1")
		.get();
	if (row == null) return { projection: "vec_embeddings", embeddings: "embeddings" };
	if (typeof row !== "object") throw new Error("invalid_embedding_index_state");
	const encoded: unknown = Reflect.get(row, "active_profile_json");
	if (typeof encoded !== "string") throw new Error("invalid_embedding_index_profile");
	const active: unknown = JSON.parse(encoded);
	if (typeof active !== "object" || active === null || Array.isArray(active))
		throw new Error("invalid_embedding_index_profile");
	const slot: unknown = Reflect.get(active, "projectionSlot");
	if (slot !== undefined && slot !== "active" && slot !== "staging") throw new Error("invalid_vector_projection_slot");
	const projection = slot === "staging" ? "vec_embeddings_staging" : "vec_embeddings";
	if (Reflect.get(row, "state") !== "building") return { projection, embeddings: "embeddings" };
	const building: unknown = Reflect.get(row, "staging_profile_json");
	if (typeof building !== "string") throw new Error("invalid_embedding_index_profile");
	const staged: unknown = JSON.parse(building);
	if (typeof staged !== "object" || staged === null || Array.isArray(staged))
		throw new Error("invalid_embedding_index_profile");
	const rebuild: unknown = Reflect.get(staged, "projectionRebuild");
	if (rebuild !== undefined && typeof rebuild !== "boolean") throw new Error("invalid_embedding_index_profile");
	return { projection, embeddings: rebuild === true ? "embeddings_staging" : "embeddings" };
}

function embeddingReadPredicate(scope: ReadScope): { sql: string; args: unknown[] } {
	return readScopeSql(
		"e",
		{ ...scope, reach: scope.reach.kind === "own" ? scope.reach : { kind: "all" }, projects: null },
		{ visibility: null, memory: "source_id", source: "source_id", session: null },
	);
}

function boundedCosineFallback(
	db: SQLiteDatabase,
	queryVector: Float32Array,
	searchTables: VectorSearchTables,
	options: VectorSearchOptions,
): VectorSearchResponse {
	const limit = options.limit ?? 20;
	const maxScanRows = Math.max(1, Math.min(options.maxScanRows ?? 10_000, 10_000));
	const params: unknown[] = [queryVector.length];
	const predicates = ["e.vector IS NOT NULL", "e.dimensions = ?"];
	if (options.type) {
		predicates.push("m.type = ?");
		params.push(options.type);
	}
	if (options.excludeAggregateRecall) {
		predicates.push("COALESCE(m.source_type, '') != 'aggregate-recall'");
	}
	const scope = vectorMemoryPredicate(options);
	const embeddingScope = embeddingReadPredicate(options.readScope);
	params.push(...scope.args, ...embeddingScope.args);
	params.push(maxScanRows + 1);

	const rows = db
		.prepare(
			`SELECT e.source_id, e.vector
			 FROM ${searchTables.embeddings} e
			 JOIN memories m ON e.source_id = m.id
			 WHERE ${predicates.join(" AND ")}${scope.sql}${embeddingScope.sql}
			 ORDER BY e.rowid DESC
			 LIMIT ?`,
		)
		.all(...params) as Array<{ source_id: string; vector: Buffer | null }>;
	const truncated = rows.length > maxScanRows;
	const scannedRows = truncated ? rows.slice(0, maxScanRows) : rows;
	const results = scannedRows
		.flatMap((row) => {
			if (!row.vector || row.vector.byteLength !== queryVector.length * 4) return [];
			const memory = blobToVector(row.vector);
			const score = Math.max(0, Math.min(1, cosineSimilarity(queryVector, memory)));
			return score > 0 ? [{ id: row.source_id, score }] : [];
		})
		.sort((a, b) => b.score - a.score)
		.slice(0, limit);

	return {
		results,
		completeness: truncated ? "recent-window" : "complete",
		...(truncated ? { searchedWindow: maxScanRows } : {}),
	};
}

function vectorMemoryPredicate(options: VectorSearchOptions): { sql: string; args: unknown[] } {
	const scope = readScopeSql("m", options.readScope);
	let sql = scope.sql;
	const args: unknown[] = [...scope.args];
	if (options.currentOnly) sql += " AND m.is_deleted=0 AND m.superseded_by IS NULL AND m.stale_at IS NULL";
	if (options.memoryScope === null) sql += " AND m.scope IS NULL";
	else if (options.memoryScope !== undefined) {
		sql += " AND m.scope=?";
		args.push(options.memoryScope);
	}
	return { sql, args };
}

function searchShardNames(db: SQLiteDatabase, scope: ReadScope): string[] {
	if (scope.compartments !== "all" && scope.compartments.length === 0) return [];
	return db
		.prepare("SELECT name FROM sqlite_master WHERE type='table'")
		.all()
		.flatMap((row) => (typeof row.name === "string" ? [row.name] : []));
}

function selectedSearchTables(base: string, scope: ReadScope, names: readonly string[]): string[] {
	if (scope.compartments !== "all" && scope.compartments.length === 0) return [base];
	return selectShardTables(names, scope.compartments).filter((name) => name === base || name.startsWith(`${base}__c`));
}

function admittedVectorSearch(
	db: SQLiteDatabase,
	query: Float32Array,
	options: VectorSearchOptions,
	partitioned: NonNullable<ReturnType<typeof admittedVectorPartitions>>,
	store: string,
	projection: string,
	limit: number,
	scan: typeof import("@signet/native").scanAdmittedVectors | undefined,
): Array<{ id: string; score: number }> {
	let rowCount = 0;
	for (const ids of partitioned.groups) {
		let candidates = 0;
		for (const id of ids) {
			const size = partitioned.sizes.get(id);
			if (size === undefined) throw new VectorAdmissionLimitError("vector_shard_invalid_metadata");
			rowCount += size;
			candidates += Math.min(size, limit);
		}
		if (candidates > 4096) throw new VectorAdmissionLimitError("vector_shard_candidate_limit");
	}
	if (rowCount > 1048576 || limit > 4096) throw new VectorAdmissionLimitError("vector_shard_scan_limit");
	const clauses: string[] = [];
	const args: unknown[] = [];
	if (options.type) {
		clauses.push("m.type=?");
		args.push(options.type);
	}
	if (options.excludeAggregateRecall) clauses.push("COALESCE(m.source_type,'')!='aggregate-recall'");
	if (options.currentOnly) clauses.push("m.is_deleted=0 AND m.superseded_by IS NULL AND m.stale_at IS NULL");
	if (options.memoryScope === null) clauses.push("m.scope IS NULL");
	else if (options.memoryScope !== undefined) {
		clauses.push("m.scope=?");
		args.push(options.memoryScope);
	}
	if (options.tags) {
		const tags = options.tags
			.split(",")
			.map((tag) => tag.trim())
			.filter(Boolean);
		if (options.tags.length > 4096 || tags.length > 64)
			throw new VectorAdmissionLimitError("vector_shard_filter_limit");
		for (const tag of tags) {
			clauses.push("m.tags LIKE ? ESCAPE '\\'");
			args.push(`%${tag.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`);
		}
	}
	if (options.who !== undefined) {
		clauses.push("m.who=?");
		args.push(options.who);
	}
	if (options.pinned) clauses.push("m.pinned=1");
	if (options.importanceMin !== undefined) {
		if (!Number.isFinite(options.importanceMin)) throw new VectorAdmissionLimitError("vector_shard_invalid_filter");
		clauses.push("m.importance>=?");
		args.push(options.importanceMin);
	}
	if (options.since !== undefined) {
		clauses.push("m.created_at>=?");
		args.push(options.since);
	}
	if (options.until !== undefined) {
		clauses.push("m.created_at<=?");
		args.push(options.until);
	}
	if (options.project !== undefined) {
		clauses.push("m.project=?");
		args.push(options.project);
	}
	const predicate = clauses.length ? clauses.join(" AND ") : "1";
	if (partitioned.ids.some((id) => (partitioned.sizes.get(id) ?? 0) > 64)) {
		const results = new Map<string, number>();
		for (const partition of partitioned.ids) {
			const standard =
				options.currentOnly === true &&
				options.memoryScope === null &&
				!options.type &&
				!options.tags &&
				options.who === undefined &&
				!options.pinned &&
				options.importanceMin === undefined &&
				options.since === undefined &&
				options.until === undefined &&
				options.project === undefined;
			const statistics = db
				.prepare(
					"SELECT row_count,recall_indexed_count,recall_eligible_count,recall_kind FROM vector_shard_keys WHERE id=?",
				)
				.get(partition);
			if (statistics?.recall_indexed_count !== partitioned.sizes.get(partition))
				throw new VectorAdmissionLimitError("vector_shard_repair_pending");
			if (statistics.recall_kind === 0) continue;
			const eligible = standard
				? `SELECT json_array(f.embedding_id,s.generation) native_id,f.memory_id source_id FROM vector_shard_recall_rows f CROSS JOIN vector_shard_members s ON s.partition_id=f.partition_id AND s.embedding_id=f.embedding_id WHERE f.partition_id=? AND s.projection=? AND f.is_current=1 AND f.memory_scope IS NULL${options.excludeAggregateRecall ? " AND f.is_aggregate=0" : ""}`
				: `SELECT r.id native_id,e.source_id FROM vector_shard_members s CROSS JOIN ${store} e ON e.id=s.embedding_id CROSS JOIN memories m ON m.id=e.source_id AND m.agent_id=e.agent_id CROSS JOIN ${partitioned.table}_rowids r ON r.id=json_array(s.embedding_id,s.generation) WHERE s.partition_id=? AND s.projection=? AND e.source_type='memory' AND ${predicate}`;
			const eligibleArgs = standard ? [] : args;
			const headroom = db
				.prepare(`SELECT COUNT(*)-COUNT(DISTINCT source_id) n FROM (${eligible})`)
				.get(partition, projection, ...eligibleArgs)?.n;
			if (typeof headroom !== "number" || headroom + limit > 4096)
				throw new VectorAdmissionLimitError("vector_shard_candidate_limit");
			const padded =
				standard && typeof statistics.row_count === "number" && typeof statistics.recall_eligible_count === "number"
					? Math.min(statistics.row_count, limit + headroom + statistics.row_count - statistics.recall_eligible_count)
					: 4097;
			const hits =
				padded <= 4096
					? db
							.prepare(
								`WITH hits AS MATERIALIZED(SELECT id,distance FROM ${partitioned.table} WHERE embedding MATCH ? AND k=? AND admission=?) SELECT e.source_id,MIN(h.distance) distance FROM hits h CROSS JOIN ${store} e ON e.id=json_extract(h.id,'$[0]') CROSS JOIN memories m ON m.id=e.source_id AND m.agent_id=e.agent_id WHERE e.source_type='memory' AND ${predicate} GROUP BY e.source_id ORDER BY distance,e.source_id LIMIT ?`,
							)
							.all(new Float32Array(query), padded, partition, ...args, limit)
					: db
							.prepare(
								`WITH eligible AS MATERIALIZED(${eligible}),hits AS MATERIALIZED(SELECT id,distance FROM ${partitioned.table} WHERE embedding MATCH ? AND k=? AND admission=? AND id IN(SELECT native_id FROM eligible)) SELECT e.source_id,MIN(h.distance) distance FROM hits h CROSS JOIN ${store} e ON e.id=json_extract(h.id,'$[0]') GROUP BY e.source_id ORDER BY distance,e.source_id LIMIT ?`,
							)
							.all(partition, projection, ...eligibleArgs, new Float32Array(query), limit + headroom, partition, limit);
			for (const hit of hits) {
				if (typeof hit.source_id !== "string" || typeof hit.distance !== "number")
					throw new VectorAdmissionLimitError("vector_shard_invalid_metadata");
				const score = Math.max(0, 1 - hit.distance);
				results.set(hit.source_id, Math.max(results.get(hit.source_id) ?? 0, score));
			}
		}
		return [...results]
			.map(([id, score]) => ({ id, score }))
			.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
			.slice(0, limit);
	}
	if (!scan) throw new VectorAdmissionLimitError("vector_shard_native_unavailable");
	const rows = db
		.prepare(
			`WITH admitted AS MATERIALIZED(SELECT value id FROM json_each(?)),members AS MATERIALIZED(SELECT r.rowid native_rowid,r.chunk_id,r.chunk_offset,s.partition_id,k.row_count,e.source_id,e.source_type,e.agent_id FROM admitted a CROSS JOIN vector_shard_members s ON s.partition_id=a.id AND s.projection=? CROSS JOIN ${partitioned.table}_rowids r ON r.id=json_array(s.embedding_id,s.generation) CROSS JOIN ${store} e ON e.id=s.embedding_id CROSS JOIN vector_shard_keys k ON k.id=s.partition_id),memory_rows AS MATERIALIZED(SELECT * FROM members WHERE source_type='memory'),eligible AS MATERIALIZED(SELECT p.native_rowid FROM memory_rows p CROSS JOIN memories m ON m.id=p.source_id AND m.agent_id=p.agent_id WHERE ${predicate}) SELECT CAST(p.native_rowid AS TEXT) native_rowid,p.chunk_id,p.chunk_offset,p.source_id,CASE WHEN eligible.native_rowid IS NULL THEN 0 ELSE 1 END eligible,c.vector singleton FROM members p LEFT JOIN eligible ON eligible.native_rowid=p.native_rowid LEFT JOIN vector_shard_singletons c ON p.row_count=1 AND c.partition_id=p.partition_id`,
		)
		.all(JSON.stringify(partitioned.ids), projection, ...args);
	if (rows.length !== rowCount) throw new VectorAdmissionLimitError("vector_shard_repair_pending");
	const buffer = (value: unknown): Buffer => {
		if (!(value instanceof Uint8Array)) throw new VectorAdmissionLimitError("vector_shard_invalid_payload");
		return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
	};
	const chunks: import("@signet/native").AdmittedVectorChunk[] = [];
	const bulk = new Map<number, Array<{ rowid: string; offset: number; eligible: number; identity: number }>>();
	let bytes = 0;
	const identities = new Map<string, number>();
	for (const row of rows) {
		if (
			typeof row.native_rowid !== "string" ||
			!/^[1-9][0-9]*$/.test(row.native_rowid) ||
			typeof row.chunk_id !== "number" ||
			!Number.isSafeInteger(row.chunk_id) ||
			typeof row.chunk_offset !== "number" ||
			!Number.isSafeInteger(row.chunk_offset) ||
			row.chunk_offset < 0 ||
			(row.eligible !== 0 && row.eligible !== 1)
		)
			throw new VectorAdmissionLimitError("vector_shard_invalid_metadata");
		let identity = 0;
		if (row.eligible === 1) {
			if (typeof row.source_id !== "string") throw new VectorAdmissionLimitError("vector_shard_invalid_metadata");
			identity = identities.get(row.source_id) ?? identities.size + 1;
			identities.set(row.source_id, identity);
		}
		if (row.singleton instanceof Uint8Array) {
			if (row.eligible === 0) continue;
			const vectors = buffer(row.singleton);
			const rowids = Buffer.alloc(8);
			rowids.writeBigInt64LE(BigInt(row.native_rowid));
			const identityBuffer = Buffer.alloc(4);
			identityBuffer.writeUInt32LE(identity);
			chunks.push({
				vectors,
				rowids,
				validity: Buffer.from([1]),
				eligibility: Buffer.from([1]),
				identities: identityBuffer,
			});
			bytes += vectors.length;
		} else {
			const values = bulk.get(row.chunk_id) ?? [];
			values.push({ rowid: row.native_rowid, offset: row.chunk_offset, eligible: row.eligible, identity });
			bulk.set(row.chunk_id, values);
		}
	}
	const ids = [...bulk].filter(([, members]) => members.some((row) => row.eligible === 1)).map(([id]) => id);
	const requested = JSON.stringify(ids);
	const total = db
		.prepare(
			`WITH wanted AS MATERIALIZED(SELECT value id FROM json_each(?)) SELECT COALESCE(SUM(length(v.vectors)),0) bytes FROM wanted a CROSS JOIN ${partitioned.table}_vector_chunks00 v ON v.rowid=a.id`,
		)
		.get(requested)?.bytes;
	if (typeof total !== "number" || total + bytes > 256 * 1024 * 1024)
		throw new VectorAdmissionLimitError("vector_shard_scan_limit");
	const payloads = db
		.prepare(
			`WITH wanted AS MATERIALIZED(SELECT value id FROM json_each(?)) SELECT c.chunk_id,c.validity,c.rowids,v.vectors FROM wanted a CROSS JOIN ${partitioned.table}_chunks c ON c.chunk_id=a.id CROSS JOIN ${partitioned.table}_vector_chunks00 v ON v.rowid=c.chunk_id ORDER BY c.chunk_id`,
		)
		.all(requested);
	if (payloads.length !== ids.length) throw new VectorAdmissionLimitError("vector_shard_repair_pending");
	for (const payload of payloads) {
		if (typeof payload.chunk_id !== "number") throw new VectorAdmissionLimitError("vector_shard_invalid_metadata");
		const members = bulk.get(payload.chunk_id);
		if (members === undefined) throw new VectorAdmissionLimitError("vector_shard_invalid_metadata");
		const rowids = buffer(payload.rowids),
			validity = buffer(payload.validity);
		const eligibility = Buffer.alloc(validity.length);
		const identityBuffer = Buffer.alloc(rowids.length / 2);
		for (const member of members) {
			if (
				(member.offset + 1) * 8 > rowids.length ||
				(validity[member.offset >> 3] & (1 << (member.offset & 7))) === 0 ||
				rowids.readBigInt64LE(member.offset * 8).toString() !== member.rowid
			)
				throw new VectorAdmissionLimitError("vector_shard_repair_pending");
			if (member.eligible === 1) {
				eligibility[member.offset >> 3] |= 1 << (member.offset & 7);
				identityBuffer.writeUInt32LE(member.identity, member.offset * 4);
			}
		}
		chunks.push({ rowids, validity, eligibility, vectors: buffer(payload.vectors), identities: identityBuffer });
	}
	const hits = scan(query, chunks, limit);
	return db
		.prepare(
			`SELECT e.source_id,json_extract(k.value,'$.distance') distance FROM json_each(?) k CROSS JOIN ${partitioned.table}_rowids r ON r.rowid=json_extract(k.value,'$.rowid') CROSS JOIN ${store} e ON e.id=json_extract(r.id,'$[0]') WHERE e.source_type='memory' ORDER BY k.key`,
		)
		.all(JSON.stringify(hits.rows))
		.flatMap((row) =>
			typeof row.source_id === "string" && typeof row.distance === "number"
				? [{ id: row.source_id, score: Math.max(0, 1 - row.distance) }]
				: [],
		);
}

export function vectorSearchWithMetadata(
	db: SQLiteDatabase,
	queryVector: Float32Array,
	options: VectorSearchOptions,
	scan: typeof import("@signet/native").scanAdmittedVectors | undefined = native?.scanAdmittedVectors,
): VectorSearchResponse {
	if (!options?.readScope) throw new Error("readScope is required for vector search");
	const limit = options.limit ?? 20;
	if (limit <= 0) return { results: [], completeness: "complete" };
	const results: Array<{ id: string; score: number }> = [];
	const maxKnnWindow = 4096;
	try {
		withReadTransaction(db, () => {
			const searchTables = activeVectorSearchTables(db);
			const partitioned = admittedVectorPartitions(
				db,
				searchTables.projection,
				options.readScope,
				searchTables.embeddings,
			);
			if (partitioned) {
				try {
					results.push(
						...admittedVectorSearch(
							db,
							queryVector,
							options,
							partitioned,
							searchTables.embeddings,
							searchTables.projection,
							limit,
							scan,
						),
					);
				} catch (error) {
					if (error instanceof VectorAdmissionLimitError) throw error;
					throw new VectorAdmissionLimitError("vector_shard_native_failed");
				}
				return;
			}
			const scope = vectorMemoryPredicate(options);
			const embeddingScope = embeddingReadPredicate(options.readScope);
			const names = options.shardNames ?? searchShardNames(db, options.readScope);
			const shards = selectedSearchTables(searchTables.projection, options.readScope, names);
			if (shards.length === 0) throw new Error("Vector projection unavailable");
			let projectionRows = 0;
			for (const table of shards) {
				const size = db.prepare(`SELECT COUNT(*) AS count FROM ${table}_rowids`).get()?.count;
				if (typeof size !== "number") throw new Error("Vector shard size unavailable");
				projectionRows += size;
				if (limit > maxKnnWindow) throw new Error("Requested vector window exceeds KNN admission");
				let requested = Math.min(size, limit * 4, maxKnnWindow);
				while (requested > 0) {
					const params: unknown[] = [new Float32Array(queryVector), requested];
					let filter = "";
					if (options.type) {
						filter += " AND m.type = ?";
						params.push(options.type);
					}
					if (options.excludeAggregateRecall) filter += " AND COALESCE(m.source_type, '') != 'aggregate-recall'";
					params.push(...scope.args, ...embeddingScope.args, limit);
					let rows = db
						.prepare(`WITH hits AS MATERIALIZED (
						SELECT id,distance FROM ${table} WHERE embedding MATCH ? AND k=?
					) SELECT e.source_id,hits.distance FROM hits
					CROSS JOIN ${searchTables.embeddings} e ON e.id=hits.id
					CROSS JOIN memories m ON m.id=e.source_id
					WHERE 1=1${filter}${scope.sql}${embeddingScope.sql} ORDER BY hits.distance,m.id LIMIT ?`)
						.all(...params);
					const selectiveAdmission =
						rows.length < limit && requested < size && requested >= Math.min(maxKnnWindow, limit * 8);
					if (selectiveAdmission) {
						params[1] = limit;
						rows = db
							.prepare(`SELECT e.source_id,v.distance FROM ${table} v
							JOIN ${searchTables.embeddings} e ON e.id=v.id
							WHERE v.embedding MATCH ? AND k=? AND v.id IN (
								SELECT eligible.id FROM ${table}_rowids eligible
								JOIN ${searchTables.embeddings} e ON e.id=eligible.id JOIN memories m ON m.id=e.source_id
								WHERE 1=1${filter}${scope.sql}${embeddingScope.sql}
							) ORDER BY v.distance,e.source_id LIMIT ?`)
							.all(...params);
					}
					if (selectiveAdmission || rows.length >= limit || requested >= size) {
						for (const row of rows)
							if (typeof row.source_id === "string" && typeof row.distance === "number")
								results.push({ id: row.source_id, score: Math.max(0, 1 - row.distance) });
						break;
					}
					requested = Math.min(size, requested * 2, maxKnnWindow);
				}
			}
			if (projectionRows === 0) throw new Error("Vector projection is empty");
			results.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
			results.splice(limit);
		});
	} catch (error) {
		if (error instanceof VectorAdmissionLimitError)
			return {
				results: [],
				completeness: "unavailable",
				...(error.message === "vector_shard_fanout_limit" ? { degraded: ["vector_fanout_cap"] as const } : {}),
			};
		try {
			let fallback: VectorSearchResponse | undefined;
			withReadTransaction(db, () => {
				fallback = boundedCosineFallback(db, queryVector, activeVectorSearchTables(db), options);
			});
			return fallback ?? { results: [], completeness: "unavailable" };
		} catch (fallbackError) {
			console.warn("Vector search failed, including bounded cosine fallback:", fallbackError, error);
			return { results: [], completeness: "unavailable" };
		}
	}
	return { results, completeness: "complete" };
}

export function vectorSearch(
	db: SQLiteDatabase,
	queryVector: Float32Array,
	options: VectorSearchOptions,
): Array<{ id: string; score: number }> {
	return vectorSearchWithMetadata(db, queryVector, options).results;
}
export function keywordSearch(
	db: SQLiteDatabase,
	query: string,
	limit = 20,
	readScope: ReadScope,
	shardNames?: readonly string[],
): Array<{ id: string; score: number }> {
	const match = buildFtsMatchQuery(query);
	if (match === null) return [];
	if (!readScope) throw new Error("readScope is required for keyword search");
	const scope = readScopeSql("m", readScope);
	const names = shardNames ?? searchShardNames(db, readScope);
	const candidates: Array<{ id: string; raw: number }> = [];
	for (const table of selectedSearchTables("memories_fts", readScope, names)) {
		const rows = db
			.prepare(`SELECT m.id,bm25(${table}) AS raw_score FROM ${table}
			JOIN memories m ON ${table}.rowid=m.rowid WHERE ${table} MATCH ?${scope.sql}
			ORDER BY raw_score,m.id LIMIT ?`)
			.all(match, ...scope.args, limit);
		for (const row of rows)
			if (typeof row.id === "string" && typeof row.raw_score === "number")
				candidates.push({ id: row.id, raw: row.raw_score });
	}
	return candidates
		.sort((a, b) => a.raw - b.raw || a.id.localeCompare(b.id))
		.slice(0, limit)
		.map((row) => ({ id: row.id, score: 1 / (1 + Math.abs(row.raw)) }));
}
export function hybridSearch(
	db: SQLiteDatabase,
	queryVector: Float32Array | null,
	queryText: string,
	options: HybridSearchOptions,
): SearchResult[] {
	if (!options?.readScope) throw new Error("readScope is required for hybrid search");
	const shardNames = searchShardNames(db, options.readScope);
	const alpha = options.alpha ?? DEFAULT_HYBRID_ALPHA;
	const limit = options?.limit ?? 10;
	const topK = options?.topK ?? 50;
	const minScore = options?.minScore ?? 0.1;
	const vectorResults = queryVector
		? vectorSearch(db, queryVector, { limit: topK, type: options?.type, readScope: options.readScope, shardNames })
		: [];
	const keywordResults = keywordSearch(db, queryText, topK, options.readScope, shardNames);
	let scored: Array<{
		id: string;
		score: number;
		source: "vector" | "keyword" | "hybrid";
	}>;

	if (native !== null) {
		const narrowSource = (s: string): "vector" | "keyword" | "hybrid" => {
			if (s === "vector" || s === "keyword" || s === "hybrid") return s;
			return "keyword";
		};
		scored = native
			.mergeHybridScores(
				vectorResults.map((r) => r.id),
				vectorResults.map((r) => r.score),
				keywordResults.map((r) => r.id),
				keywordResults.map((r) => r.score),
				alpha,
				minScore,
			)
			.map((r) => ({
				id: r.id,
				score: r.score,
				source: narrowSource(r.source),
			}));
	} else {
		const vectorMap = new Map(vectorResults.map((r) => [r.id, r.score]));
		const keywordMap = new Map(keywordResults.map((r) => [r.id, r.score]));
		const allIds = new Set([...vectorMap.keys(), ...keywordMap.keys()]);
		scored = [];

		for (const id of allIds) {
			const vectorScore = vectorMap.get(id) ?? 0;
			const keywordScore = keywordMap.get(id) ?? 0;

			let score: number;
			let source: "vector" | "keyword" | "hybrid";

			if (vectorScore > 0 && keywordScore > 0) {
				score = alpha * vectorScore + (1 - alpha) * keywordScore;
				source = "hybrid";
			} else if (vectorScore > 0) {
				score = vectorScore;
				source = "vector";
			} else {
				score = keywordScore;
				source = "keyword";
			}

			if (score >= minScore) {
				scored.push({ id, score, source });
			}
		}

		scored.sort((a, b) => b.score - a.score);
	}
	const candidateIds = scored.map((s) => s.id);

	if (candidateIds.length === 0) {
		return [];
	}
	const rowMap = new Map<
		string,
		{
			id: string;
			content: string;
			type: string;
			tags: string | null;
			confidence: number;
		}
	>();
	for (let offset = 0; offset < candidateIds.length; offset += 400) {
		const batch = candidateIds.slice(offset, offset + 400);
		const placeholders = batch.map(() => "?").join(", ");
		const scope = readScopeSql("", options.readScope);
		const params: unknown[] = [...batch];
		const typeFilter = options?.type ? " AND type = ?" : "";
		if (options?.type) params.push(options.type);
		params.push(...scope.args);
		const rows = db
			.prepare(`
    SELECT id, content, type, tags, confidence
    FROM memories
    WHERE id IN (${placeholders})${typeFilter}${scope.sql}
  `)
			.all(...params) as Array<{
			id: string;
			content: string;
			type: string;
			tags: string | null;
			confidence: number;
		}>;
		for (const row of rows) rowMap.set(row.id, row);
	}
	return scored
		.filter((s) => {
			const row = rowMap.get(s.id);
			return row !== undefined;
		})
		.slice(0, limit)
		.map((s) => {
			const r = rowMap.get(s.id);
			if (!r) return null;
			return {
				id: s.id,
				content: redactCredentials(r.content),
				score: Math.round(s.score * 100) / 100,
				type: r.type,
				source: s.source,
				tags: safeParseTags(r.tags),
				confidence: r.confidence,
			};
		})
		.filter((r): r is NonNullable<typeof r> => r !== null);
}
const PROMPT_ENTITY_MAX_TEXT_BYTES = 256;

const PROMPT_ENTITY_ELIGIBLE = `COALESCE(e.status, 'active') = 'active'
		   AND LOWER(e.entity_type) IN ('person', 'project')
		   AND TYPEOF(e.id) = 'text'
		   AND TYPEOF(e.name) = 'text'
		   AND LENGTH(CAST(e.id AS BLOB)) <= ${PROMPT_ENTITY_MAX_TEXT_BYTES}
		   AND LENGTH(CAST(e.name AS BLOB)) <= ${PROMPT_ENTITY_MAX_TEXT_BYTES}`;

const promptEntityCounts = (
	global: boolean,
) => `${global ? "CAST(COALESCE(e.mentions, 0) AS INTEGER)" : "0"} AS mentions,
		   CAST(COALESCE(e.pinned, 0) AS INTEGER) AS pinned`;

const promptEntityNames = (scope: string, global: boolean) => `SELECT
		   e.rowid AS cursor,
		   e.id AS entity_id,
		   e.name AS entity_name,
		   COALESCE(e.entity_type, 'unknown') AS entity_type,
		   COALESCE(e.canonical_name, LOWER(e.name)) AS matched_text,
		   'name' AS match_source,
		   ${promptEntityCounts(global)}
		 FROM entities e
		 WHERE e.rowid > ?${scope}
		   AND ${PROMPT_ENTITY_ELIGIBLE}
		   AND TYPEOF(COALESCE(e.canonical_name, LOWER(e.name))) = 'text'
		   AND LENGTH(CAST(COALESCE(e.canonical_name, LOWER(e.name)) AS BLOB)) <= ${PROMPT_ENTITY_MAX_TEXT_BYTES}
		 ORDER BY e.rowid
		 LIMIT ?`;

const promptEntityAliases = (scope: string, global: boolean) => `SELECT
		   a.canonical_alias AS cursor,
		   e.id AS entity_id,
		   e.name AS entity_name,
		   COALESCE(e.entity_type, 'unknown') AS entity_type,
		   a.alias AS matched_text,
		   'alias' AS match_source,
		   ${promptEntityCounts(global)}
		 FROM entity_aliases a
		 JOIN entities e ON e.id = a.entity_id AND e.agent_id = a.agent_id
		 WHERE a.status = 'active'
		   AND a.canonical_alias > ?${scope}
		   AND TYPEOF(a.canonical_alias) = 'text'
		   AND TYPEOF(a.alias) = 'text'
		   AND LENGTH(CAST(a.canonical_alias AS BLOB)) <= ${PROMPT_ENTITY_MAX_TEXT_BYTES}
		   AND LENGTH(CAST(a.alias AS BLOB)) <= ${PROMPT_ENTITY_MAX_TEXT_BYTES}
		   AND ${PROMPT_ENTITY_ELIGIBLE}
		 ORDER BY a.canonical_alias
		 LIMIT ?`;

export function promptEntityPageSql(kind: "names" | "aliases", readScope: ReadScope, predicate: string): string {
	if (!readScope) throw new Error("readScope is required for entity search");
	const global =
		readScope.reach.kind === "all" &&
		readScope.compartments === "all" &&
		readScope.projects === null &&
		readScope.inFlightUserId === undefined;
	return kind === "names" ? promptEntityNames(predicate, global) : promptEntityAliases(predicate, global);
}

function hasPrepareMethod(db: unknown): db is SQLiteDatabase {
	return (
		typeof db === "object" && db !== null && "prepare" in db && typeof (db as SQLiteDatabase).prepare === "function"
	);
}
function getRawDb(db: SQLiteDatabase | DatabaseWrapper): SQLiteDatabase | null {
	if (typeof db === "object" && db !== null && "db" in db && db.db !== null && hasPrepareMethod(db.db)) {
		return db.db;
	}
	if (hasPrepareMethod(db)) {
		return db;
	}
	return null;
}
export async function search(db: SQLiteDatabase | DatabaseWrapper, options: SearchOptions): Promise<SearchResult[]> {
	const { query, limit = 10, alpha = DEFAULT_HYBRID_ALPHA, minScore = 0.1, topK = 50 } = options;
	const rawDb = getRawDb(db);
	if (rawDb) {
		const results = hybridSearch(rawDb, null, query, {
			limit,
			alpha,
			minScore,
			topK,
			type: options.type,
			readScope: options.readScope,
		});
		if (results.length > 0) {
			return results;
		}
	}
	return [];
}
