import { createRequire } from "node:module";
import { DEFAULT_HYBRID_ALPHA } from "./constants";
import { scanMemoryContent } from "./memory-content-safety";
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
	query: string;
	limit?: number;
	alpha?: number;
	type?: string;
	minScore?: number;
	topK?: number;
}

export interface VectorSearchOptions {
	limit?: number;
	type?: string;
	excludeAggregateRecall?: boolean;
	maxScanRows?: number;
}

export interface HybridSearchOptions {
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
		get(...args: unknown[]): Record<string, unknown> | undefined;
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
	let dot = 0;
	let normA = 0;
	let normB = 0;
	const len = Math.min(a.length, b.length);

	for (let i = 0; i < len; i++) {
		dot += a[i] * b[i];
		normA += a[i] * a[i];
		normB += b[i] * b[i];
	}

	const denom = Math.sqrt(normA) * Math.sqrt(normB);
	return denom > 0 ? dot / denom : 0;
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
	if (native !== null) {
		return native.cosineSimilarity(a, b);
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

function activeVectorSearchTables(db: SQLiteDatabase): VectorSearchTables {
	try {
		const row = db
			.prepare("SELECT active_profile_json, state, staging_profile_json FROM embedding_index_state WHERE id = 1")
			.get() as { active_profile_json?: unknown; state?: unknown; staging_profile_json?: unknown } | undefined;
		if (!row) return { projection: "vec_embeddings", embeddings: "embeddings" };
		const active =
			typeof row.active_profile_json === "string"
				? (JSON.parse(row.active_profile_json) as { projectionSlot?: unknown })
				: {};
		const activeProjection = active.projectionSlot === "staging" ? "vec_embeddings_staging" : "vec_embeddings";
		if (row.state !== "building" || typeof row.staging_profile_json !== "string") {
			return { projection: activeProjection, embeddings: "embeddings" };
		}
		const staging = JSON.parse(row.staging_profile_json) as { projectionRebuild?: unknown };
		if (staging.projectionRebuild === true) return { projection: activeProjection, embeddings: "embeddings_staging" };
		return { projection: activeProjection, embeddings: "embeddings" };
	} catch {
		return { projection: "vec_embeddings", embeddings: "embeddings" };
	}
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
	params.push(maxScanRows + 1);

	const rows = db
		.prepare(
			`SELECT e.source_id, e.vector
			 FROM ${searchTables.embeddings} e
			 JOIN memories m ON e.source_id = m.id
			 WHERE ${predicates.join(" AND ")}
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

export function vectorSearchWithMetadata(
	db: SQLiteDatabase,
	queryVector: Float32Array,
	options?: VectorSearchOptions,
): VectorSearchResponse {
	const effectiveOptions = options ?? {};
	const limit = effectiveOptions.limit ?? 20;
	const results: Array<{ id: string; score: number }> = [];

	try {
		withReadTransaction(db, () => {
			const searchTables = activeVectorSearchTables(db);
			const queryBlob = new Float32Array(queryVector);
			const maxK = effectiveOptions.excludeAggregateRecall ? Math.max(limit, Math.min(limit * 8, 1000)) : limit;
			let k = limit;

			while (true) {
				const params: unknown[] = [queryBlob, k];
				let typeFilter = "";
				if (effectiveOptions.type) {
					typeFilter = " AND m.type = ?";
					params.push(effectiveOptions.type);
				}
				if (effectiveOptions.excludeAggregateRecall) {
					typeFilter += " AND COALESCE(m.source_type, '') != 'aggregate-recall'";
				}
				const rows = db
					.prepare(`
      SELECT
        e.source_id,
        v.distance
      FROM ${searchTables.projection} v
						JOIN ${searchTables.embeddings} e ON v.id = e.id
      JOIN memories m ON e.source_id = m.id
      WHERE v.embedding MATCH ? AND k = ?${typeFilter}
      ORDER BY v.distance
    `)
					.all(...params) as Array<{ source_id: string; distance: number }>;

				results.length = 0;
				for (const row of rows.slice(0, limit)) {
					const similarity = 1 - row.distance;
					results.push({ id: row.source_id, score: Math.max(0, similarity) });
				}
				if (results.length >= limit || k >= maxK || (!effectiveOptions.excludeAggregateRecall && rows.length < k))
					break;
				k = Math.min(k * 2, maxK);
			}
		});
	} catch (e) {
		try {
			let fallbackResponse: VectorSearchResponse | undefined;
			withReadTransaction(db, () => {
				const searchTables = activeVectorSearchTables(db);
				fallbackResponse = boundedCosineFallback(db, queryVector, searchTables, effectiveOptions);
			});
			return fallbackResponse ?? { results: [], completeness: "unavailable" };
		} catch (fallbackError) {
			console.warn("Vector search failed, including bounded cosine fallback:", fallbackError, e);
			return { results: [], completeness: "unavailable" };
		}
	}

	return { results, completeness: "complete" };
}

export function vectorSearch(
	db: SQLiteDatabase,
	queryVector: Float32Array,
	options?: VectorSearchOptions,
): Array<{ id: string; score: number }> {
	return vectorSearchWithMetadata(db, queryVector, options).results;
}
export function keywordSearch(db: SQLiteDatabase, query: string, limit?: number): Array<{ id: string; score: number }> {
	const effectiveLimit = limit ?? 20;
	const results: Array<{ id: string; score: number }> = [];
	const matchQuery = buildFtsMatchQuery(query);
	if (matchQuery === null) return results;

	try {
		const rows = db
			.prepare(`
      SELECT m.id, bm25(memories_fts) AS raw_score
      FROM memories_fts
      JOIN memories m ON memories_fts.rowid = m.rowid
      WHERE memories_fts MATCH ?
      ORDER BY raw_score
      LIMIT ?
    `)
			.all(matchQuery, effectiveLimit) as Array<{ id: string; raw_score: number }>;

		for (const row of rows) {
			const normalized = 1 / (1 + Math.abs(row.raw_score));
			results.push({ id: row.id, score: normalized });
		}
	} catch {}

	return results;
}
export function hybridSearch(
	db: SQLiteDatabase,
	queryVector: Float32Array | null,
	queryText: string,
	options?: HybridSearchOptions,
): SearchResult[] {
	const alpha = options?.alpha ?? DEFAULT_HYBRID_ALPHA;
	const limit = options?.limit ?? 10;
	const topK = options?.topK ?? 50;
	const minScore = options?.minScore ?? 0.1;
	const vectorResults = queryVector ? vectorSearch(db, queryVector, { limit: topK, type: options?.type }) : [];
	const keywordResults = keywordSearch(db, queryText, topK);
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
		const params: unknown[] = [...batch];
		const typeFilter = options?.type ? " AND type = ?" : "";
		if (options?.type) params.push(options.type);
		const rows = db
			.prepare(`
    SELECT id, content, type, tags, confidence
    FROM memories
    WHERE id IN (${placeholders})${typeFilter}
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
			return row !== undefined && scanMemoryContent(row.content).contextEligible;
		})
		.slice(0, limit)
		.map((s) => {
			const r = rowMap.get(s.id);
			if (!r) return null;
			return {
				id: s.id,
				content: r.content,
				score: Math.round(s.score * 100) / 100,
				type: r.type,
				source: s.source,
				tags: safeParseTags(r.tags),
				confidence: r.confidence,
			};
		})
		.filter((r): r is NonNullable<typeof r> => r !== null);
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
		});
		if (results.length > 0) {
			return results;
		}
	}
	try {
		const wrapper = db as DatabaseWrapper;
		const memories = typeof wrapper.getMemories === "function" ? wrapper.getMemories(options.type) : [];

		return memories
			.filter(
				(m: Memory) =>
					scanMemoryContent(m.content).contextEligible && m.content.toLowerCase().includes(query.toLowerCase()),
			)
			.slice(0, limit)
			.map((m: Memory) => ({
				id: m.id,
				content: m.content,
				score: 1.0,
				type: m.type,
				source: "keyword" as const,
				tags: m.tags,
				confidence: m.confidence,
			}));
	} catch {
		return [];
	}
}
