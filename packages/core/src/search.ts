import {
	DEFAULT_EMBEDDING_DIMENSIONS,
	DEFAULT_HYBRID_ALPHA,
} from "./constants";
import type { Memory } from "./types";

export interface SearchOptions {
	query: string;
	limit?: number;
	alpha?: number; // Vector weight (1-alpha = BM25 weight)
	type?: "fact" | "preference" | "decision";
	minScore?: number;
	topK?: number; // Candidates per source before blending
}

export interface VectorSearchOptions {
	limit?: number;
	type?: "fact" | "preference" | "decision";
}

export interface HybridSearchOptions {
	limit?: number;
	alpha?: number;
	minScore?: number;
	topK?: number;
	type?: "fact" | "preference" | "decision";
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

/**
 * SQLite database interface for raw queries
 */
interface SQLiteDatabase {
	prepare(sql: string): {
		run(...args: unknown[]): void;
		get(...args: unknown[]): Record<string, unknown> | undefined;
		all(...args: unknown[]): Record<string, unknown>[];
	};
}

/**
 * Database wrapper interface (like our Database class)
 */
interface DatabaseWrapper {
	db: SQLiteDatabase | null;
	getMemories(type?: string): Memory[];
}

/**
 * Convert a Blob/Buffer to Float32Array for vector operations
 */
function blobToVector(blob: Buffer | ArrayBuffer): Float32Array {
	if (blob instanceof ArrayBuffer) {
		return new Float32Array(blob);
	}
	return new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
}

/**
 * Compute cosine similarity between two vectors
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
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

/**
 * Pure vector search using sqlite-vec
 * Uses the vec_embeddings virtual table for efficient similarity search
 */
export function vectorSearch(
	db: SQLiteDatabase,
	queryVector: Float32Array,
	options?: VectorSearchOptions,
): Array<{ id: string; score: number }> {
	const limit = options?.limit ?? 20;
	const results: Array<{ id: string; score: number }> = [];

	try {
		// sqlite-vec uses MATCH syntax for vector search
		// The query vector must be serialized as a blob
		const queryBlob = new Float32Array(queryVector);

		// vec0 KNN queries require `k = ?` in the WHERE clause
		const params: unknown[] = [queryBlob, limit];

		// Build type filter if specified
		let typeFilter = "";
		if (options?.type) {
			typeFilter = " AND m.type = ?";
			params.push(options.type);
		}

		// Query vec_embeddings virtual table, join with embeddings to get source_id
		const rows = db
			.prepare(`
      SELECT
        e.source_id,
        v.distance
      FROM vec_embeddings v
      JOIN embeddings e ON v.id = e.id
      JOIN memories m ON e.source_id = m.id
      WHERE v.embedding MATCH ? AND k = ?${typeFilter}
      ORDER BY v.distance
    `)
			.all(...params) as Array<{ source_id: string; distance: number }>;

		// Convert cosine distance to similarity score
		// sqlite-vec with distance_metric=cosine returns (1 - similarity)
		// So similarity = 1 - distance
		for (const row of rows) {
			const similarity = 1 - row.distance;
			results.push({ id: row.source_id, score: Math.max(0, similarity) });
		}
	} catch (e) {
		// Vector search may fail if no embeddings exist or vec table unavailable
		console.warn("Vector search failed:", e);
	}

	return results;
}

/**
 * Pure BM25 keyword search using FTS5
 */
export function keywordSearch(
	db: SQLiteDatabase,
	query: string,
	limit?: number,
): Array<{ id: string; score: number }> {
	const effectiveLimit = limit ?? 20;
	const results: Array<{ id: string; score: number }> = [];

	try {
		// FTS5 bm25() returns negative values (lower = better match)
		// Normalize to 0-1 using 1 / (1 + |score|)
		const rows = db
			.prepare(`
      SELECT m.id, bm25(memories_fts) AS raw_score
      FROM memories_fts
      JOIN memories m ON memories_fts.rowid = m.rowid
      WHERE memories_fts MATCH ?
      ORDER BY raw_score
      LIMIT ?
    `)
			.all(query, effectiveLimit) as Array<{ id: string; raw_score: number }>;

		for (const row of rows) {
			// Normalize BM25 score: convert negative to 0-1
			const normalized = 1 / (1 + Math.abs(row.raw_score));
			results.push({ id: row.id, score: normalized });
		}
	} catch {
		// FTS may be unavailable or no matches
	}

	return results;
}

/**
 * Hybrid search combining vector similarity and BM25 keyword search
 * Scores are blended using alpha parameter
 */
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

	// Run both searches in parallel (conceptually)
	const vectorResults = queryVector
		? vectorSearch(db, queryVector, { limit: topK, type: options?.type })
		: [];
	const keywordResults = keywordSearch(db, queryText, topK);

	// Build score maps for efficient lookup
	const vectorMap = new Map(vectorResults.map((r) => [r.id, r.score]));
	const keywordMap = new Map(keywordResults.map((r) => [r.id, r.score]));

	// Merge scores from both sources
	const allIds = new Set([...vectorMap.keys(), ...keywordMap.keys()]);
	const scored: Array<{
		id: string;
		score: number;
		source: "vector" | "keyword" | "hybrid";
	}> = [];

	for (const id of allIds) {
		const vectorScore = vectorMap.get(id) ?? 0;
		const keywordScore = keywordMap.get(id) ?? 0;

		let score: number;
		let source: "vector" | "keyword" | "hybrid";

		if (vectorScore > 0 && keywordScore > 0) {
			// Blend scores using alpha weight
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

	// Sort by score descending
	scored.sort((a, b) => b.score - a.score);

	// Fetch full memory rows for top results
	const topIds = scored.slice(0, limit).map((s) => s.id);

	if (topIds.length === 0) {
		return [];
	}

	// Build query with placeholders
	const placeholders = topIds.map(() => "?").join(", ");
	let typeFilter = "";
	const params: unknown[] = [...topIds];

	if (options?.type) {
		typeFilter = " AND type = ?";
		params.push(options.type);
	}

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

	// Map rows by ID for quick lookup
	const rowMap = new Map(rows.map((r) => [r.id, r]));

	// Build final results preserving score order
	return scored
		.slice(0, limit)
		.filter((s) => rowMap.has(s.id))
		.map((s) => {
			const r = rowMap.get(s.id);
			if (!r) return null;
			return {
				id: s.id,
				content: r.content,
				score: Math.round(s.score * 100) / 100,
				type: r.type,
				source: s.source,
				tags: r.tags ? JSON.parse(r.tags) : [],
				confidence: r.confidence,
			};
		})
		.filter((r): r is NonNullable<typeof r> => r !== null);
}

/**
 * Type guard to check if db has a prepare method (is a raw SQLiteDatabase)
 */
function hasPrepareMethod(db: unknown): db is SQLiteDatabase {
	return (
		typeof db === "object" &&
		db !== null &&
		"prepare" in db &&
		typeof (db as SQLiteDatabase).prepare === "function"
	);
}

/**
 * Extract raw SQLiteDatabase from either a wrapper or raw db
 */
function getRawDb(db: SQLiteDatabase | DatabaseWrapper): SQLiteDatabase | null {
	// Check if it's a DatabaseWrapper with a db property
	if (
		typeof db === "object" &&
		db !== null &&
		"db" in db &&
		db.db !== null &&
		hasPrepareMethod(db.db)
	) {
		return db.db;
	}
	// Check if it's already a raw SQLiteDatabase
	if (hasPrepareMethod(db)) {
		return db;
	}
	return null;
}

/**
 * Main search entry point
 * Falls back to simple text matching if hybrid search components unavailable
 */
export async function search(
	db: SQLiteDatabase | DatabaseWrapper,
	options: SearchOptions,
): Promise<SearchResult[]> {
	const {
		query,
		limit = 10,
		alpha = DEFAULT_HYBRID_ALPHA,
		minScore = 0.1,
		topK = 50,
	} = options;

	// Get raw SQLite db from Database wrapper if available
	const rawDb = getRawDb(db);

	// Try hybrid search first (requires FTS5 table)
	// Note: For full hybrid search, caller should provide queryVector
	// This falls back to keyword-only if no vector is available
	if (rawDb) {
		const results = hybridSearch(rawDb, null, query, {
			limit,
			alpha,
			minScore,
			topK,
			type: options.type,
		});

		// If hybrid search found results, return them
		if (results.length > 0) {
			return results;
		}
	}

	// Fallback: simple substring matching (original behavior)
	// This handles cases where FTS5 table doesn't exist yet
	try {
		const wrapper = db as DatabaseWrapper;
		const memories =
			typeof wrapper.getMemories === "function"
				? wrapper.getMemories(options.type)
				: [];

		return memories
			.filter((m: Memory) =>
				m.content.toLowerCase().includes(query.toLowerCase()),
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
