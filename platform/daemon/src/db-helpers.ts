/**
 * Shared low-level DB helpers used across transaction and pipeline code.
 */

import { createRequire } from "node:module";
import { type ReadDb, type WriteDb, readVecEmbeddingDimensions } from "./db-accessor";

// Try to load native Rust implementation, fall back to pure TS
let native: typeof import("@signet/native") | null = null;
try {
	const esmRequire = createRequire(import.meta.url);
	native = esmRequire("@signet/native");
} catch {
	// Native addon not available — using TypeScript fallback
}

/** Serialize a numeric vector to a SQLite BLOB via Float32Array. */
export function vectorToBlob(vec: readonly number[]): Buffer {
	if (native !== null) {
		return native.vectorToBlob(vec as number[]);
	}
	const f32 = new Float32Array(vec);
	return Buffer.from(f32.buffer.slice(0));
}

/**
 * Extract the `changes` count from a bun:sqlite run result.
 *
 * Note: bun:sqlite's `.changes` includes rows modified by triggers,
 * so for tables with FTS sync triggers the count may be inflated.
 * Use the SELECT-count pattern when an exact row count matters.
 */
export function countChanges(result: unknown): number {
	if (typeof result !== "object" || result === null) return 0;
	const row = result as { changes?: number };
	return typeof row.changes === "number" ? row.changes : 0;
}

// ---------------------------------------------------------------------------
// umap_cache invalidation — clear cached projections on any embedding change.
// Recomputation is lazy (on next dashboard request). Graceful: non-fatal if
// the umap_cache table doesn't exist yet (e.g. migration hasn't run).
// ---------------------------------------------------------------------------

function invalidateUmapCache(db: WriteDb): void {
	try {
		db.prepare("DELETE FROM umap_cache").run();
	} catch {
		// Table may not exist yet — non-fatal
	}
}

// ---------------------------------------------------------------------------
// vec_embeddings sync — keep the sqlite-vec virtual table in lockstep
// with the regular embeddings table so vector search sees new rows.
// Graceful: silently skips if vec_embeddings doesn't exist (no sqlite-vec).
// ---------------------------------------------------------------------------

const VEC_DELETE_BATCH_SIZE = 500;

function vecTableExists(db: WriteDb): boolean {
	try {
		const row = db.prepare("SELECT name FROM sqlite_master WHERE name = 'vec_embeddings' AND type = 'table'").get();
		return row != null;
	} catch {
		return false;
	}
}

/**
 * Read the dimension the live vec_embeddings virtual table is pinned to, parsed
 * from its CREATE schema. Returns null when the table is missing or its schema
 * does not declare a FLOAT[N] embedding column (e.g. the test double, or a
 * non-sqlite-vec fallback). Callers use this to detect a dimension mismatch
 * BEFORE writing: syncVecInsert silently swallows the vec0 dimension error,
 * which would otherwise leave vec_embeddings serving stale vectors.
 */
export function readLiveVecDimensions(db: ReadDb): number | null {
	let row: { sql: string } | undefined;
	try {
		row = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'vec_embeddings' AND type = 'table'").get() as
			| { sql: string }
			| undefined;
	} catch {
		return null;
	}
	return readVecEmbeddingDimensions(row?.sql);
}

export interface VecMutationBatch {
	insert(embeddingId: string, vector: readonly number[]): void;
	deleteByEmbeddingIds(embeddingIds: readonly string[]): boolean;
	deleteBySourceId(sourceType: string, sourceId: string): void;
	deleteBySourceExceptHash(sourceType: string, sourceId: string, keepContentHash: string): void;
	deleteBySourceIdRange(sourceType: string, sourceIdStart: string, sourceIdEnd: string, agentId?: string): boolean;
}

/**
 * Create vector mutation helpers that share one cache invalidation and schema
 * probe across a synchronous write transaction.
 */
export function createVecMutationBatch(db: WriteDb): VecMutationBatch {
	let cacheInvalidated = false;
	let vecAvailable: boolean | undefined;

	const invalidate = (): void => {
		if (cacheInvalidated) return;
		cacheInvalidated = true;
		invalidateUmapCache(db);
	};

	const hasVecTable = (): boolean => {
		if (vecAvailable === undefined) vecAvailable = vecTableExists(db);
		return vecAvailable;
	};

	const insert = (embeddingId: string, vector: readonly number[]): void => {
		invalidate();
		if (!hasVecTable()) return;
		try {
			const f32 = new Float32Array(vector);
			db.prepare("INSERT OR REPLACE INTO vec_embeddings (id, embedding) VALUES (?, ?)").run(embeddingId, f32);
		} catch {
			// sqlite-vec not loaded or schema mismatch — non-fatal
		}
	};

	const deleteByEmbeddingIds = (embeddingIds: readonly string[]): boolean => {
		if (embeddingIds.length === 0) return true;
		invalidate();
		if (!hasVecTable()) return true;
		try {
			for (let start = 0; start < embeddingIds.length; start += VEC_DELETE_BATCH_SIZE) {
				const ids = embeddingIds.slice(start, start + VEC_DELETE_BATCH_SIZE);
				const placeholders = ids.map(() => "?").join(", ");
				db.prepare(`DELETE FROM vec_embeddings WHERE id IN (${placeholders})`).run(...ids);
			}
			return true;
		} catch {
			return false;
		}
	};

	const deleteByEmbeddingSubquery = (whereClause: string, params: readonly string[]): boolean => {
		invalidate();
		if (!hasVecTable()) return true;
		try {
			const select = db.prepare(
				`SELECT e.id FROM embeddings AS e
				 WHERE ${whereClause}
				   AND EXISTS (SELECT 1 FROM vec_embeddings AS v WHERE v.id = e.id)
				 LIMIT ?`,
			);
			for (;;) {
				const rows = select.all(...params, VEC_DELETE_BATCH_SIZE) as Array<{ id: string }>;
				if (rows.length === 0) return true;
				if (!deleteByEmbeddingIds(rows.map((row) => row.id))) return false;
			}
		} catch {
			return false;
		}
	};

	const deleteBySource = (sourceType: string, sourceId: string, keepContentHash?: string): void => {
		const hashClause = keepContentHash === undefined ? "" : " AND content_hash <> ?";
		const params = keepContentHash === undefined ? [sourceType, sourceId] : [sourceType, sourceId, keepContentHash];
		deleteByEmbeddingSubquery(`source_type = ? AND source_id = ?${hashClause}`, params);
	};

	const deleteBySourceIdRange = (
		sourceType: string,
		sourceIdStart: string,
		sourceIdEnd: string,
		agentId?: string,
	): boolean => {
		const agentClause = agentId === undefined ? "" : "agent_id = ? AND ";
		const params =
			agentId === undefined
				? [sourceType, sourceIdStart, sourceIdEnd]
				: [agentId, sourceType, sourceIdStart, sourceIdEnd];
		return deleteByEmbeddingSubquery(`${agentClause}source_type = ? AND source_id >= ? AND source_id < ?`, params);
	};

	return {
		insert,
		deleteByEmbeddingIds,
		deleteBySourceId: (sourceType, sourceId) => deleteBySource(sourceType, sourceId),
		deleteBySourceExceptHash: (sourceType, sourceId, keepContentHash) =>
			deleteBySource(sourceType, sourceId, keepContentHash),
		deleteBySourceIdRange,
	};
}

/**
 * Insert or replace a vector in vec_embeddings after writing to embeddings.
 * `embeddingId` must match the embeddings.id value.
 */
export function syncVecInsert(db: WriteDb, embeddingId: string, vector: readonly number[]): void {
	createVecMutationBatch(db).insert(embeddingId, vector);
}

/**
 * Remove rows from vec_embeddings that match embedding ids.
 * Call before deleting from the embeddings table so a failed derived-index
 * write leaves the canonical row available for retry.
 */
export function syncVecDeleteByEmbeddingIds(db: WriteDb, embeddingIds: readonly string[]): boolean {
	return createVecMutationBatch(db).deleteByEmbeddingIds(embeddingIds);
}

/**
 * Remove all vec_embeddings rows for a given memory (via embeddings join).
 * Use before deleting from embeddings by source_id.
 */
export function syncVecDeleteBySourceId(db: WriteDb, sourceType: string, sourceId: string): void {
	createVecMutationBatch(db).deleteBySourceId(sourceType, sourceId);
}

/**
 * Remove vec_embeddings rows for a source except those matching a given hash.
 * Mirrors the "delete stale, keep current hash" pattern in embedding upserts.
 */
export function syncVecDeleteBySourceExceptHash(
	db: WriteDb,
	sourceType: string,
	sourceId: string,
	keepContentHash: string,
): void {
	createVecMutationBatch(db).deleteBySourceExceptHash(sourceType, sourceId, keepContentHash);
}

/**
 * Check whether a table exists in the SQLite database.
 * Replaces 8+ local copies across the daemon codebase.
 */
export function tableExists(db: { prepare(sql: string): { get(...args: unknown[]): unknown } }, name: string): boolean {
	return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) != null;
}
