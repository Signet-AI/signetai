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

export function vectorSearchWithMetadata(
	db: SQLiteDatabase,
	queryVector: Float32Array,
	options: VectorSearchOptions,
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
				const eligible = clauses.length ? clauses.join(" AND ") : "1";
				const maximum = Math.min(4096, Math.max(limit, Math.min(limit * 8, 1000)));
				let pending = partitioned.groups.map((_, group) => group);
				let window = limit;
				while (pending.length) {
					const next: number[] = [];
					for (let offset = 0; offset < pending.length; ) {
						const batch: number[] = [];
						const admissions: Array<readonly [number, number]> = [];
						let budget = 0;
						while (offset < pending.length && batch.length < 128) {
							const group = pending[offset];
							if (group === undefined) throw new Error("invalid_vector_admission_group");
							const ids = partitioned.groups[group];
							if (ids === undefined) throw new Error("invalid_vector_admission_group");
							let work = 0;
							for (const id of ids) {
								const size = partitioned.sizes.get(id);
								if (size === undefined) throw new Error("invalid_vector_admission_key");
								work += Math.min(size, window);
							}
							if (work > 4096) throw new VectorAdmissionLimitError("vector_shard_candidate_limit");
							if (batch.length && budget + work > 4096) break;
							budget += work;
							batch.push(group);
							for (const id of ids) admissions.push([id, group]);
							offset++;
						}
						const rows = db
							.prepare(
								`WITH neighbors AS MATERIALIZED(SELECT id,admission,distance FROM ${partitioned.table} WHERE embedding MATCH ? AND k=? AND admission IN(SELECT partition_id FROM admitted)),admitted AS MATERIALIZED(SELECT json_extract(value,'$[0]') partition_id,json_extract(value,'$[1]') shard_group FROM json_each(?)),ranked AS MATERIALIZED(SELECT json_extract(n.id,'$[0]') id,n.distance,a.shard_group,row_number() OVER(PARTITION BY a.shard_group ORDER BY n.distance) position FROM neighbors n CROSS JOIN admitted a ON a.partition_id=n.admission),hits AS MATERIALIZED(SELECT id,distance,shard_group FROM ranked WHERE position<=?) SELECT e.source_id,hits.distance,hits.shard_group,CASE WHEN ${eligible} THEN 1 ELSE 0 END eligible FROM hits CROSS JOIN ${searchTables.embeddings} e ON e.id=hits.id CROSS JOIN memories m ON e.source_type='memory' AND m.id=e.source_id AND m.agent_id=e.agent_id ORDER BY hits.shard_group,hits.distance`,
							)
							.all(queryVector, window, JSON.stringify(admissions), window, ...args);
						const grouped = new Map<number, Record<string, unknown>[]>();
						for (const row of rows) {
							if (typeof row.shard_group !== "number" || !batch.includes(row.shard_group))
								throw new Error("invalid_vector_admission_group");
							const values = grouped.get(row.shard_group) ?? [];
							values.push(row);
							grouped.set(row.shard_group, values);
						}
						for (const group of batch) {
							const candidates = grouped.get(group) ?? [];
							const kept = candidates.filter((row) => row.eligible === 1);
							if (kept.length >= limit || kept.length === candidates.length || window >= maximum) {
								for (const row of kept)
									if (typeof row.source_id === "string" && typeof row.distance === "number")
										results.push({ id: row.source_id, score: Math.max(0, 1 - row.distance) });
							} else next.push(group);
						}
					}
					pending = next;
					window = Math.min(maximum, window * 2);
				}
				results.sort((a, b) => b.score - a.score);
				results.splice(limit);
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
		if (error instanceof VectorAdmissionLimitError) return { results: [], completeness: "unavailable" };
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
