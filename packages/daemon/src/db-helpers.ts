/**
 * Shared low-level DB helpers used across transaction and pipeline code.
 */

import type { WriteDb } from "./db-accessor";

/** Serialize a numeric vector to a SQLite BLOB via Float32Array. */
export function vectorToBlob(vec: readonly number[]): Buffer {
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
// vec_embeddings sync — keep the sqlite-vec virtual table in lockstep
// with the regular embeddings table so vector search sees new rows.
// Graceful: silently skips if vec_embeddings doesn't exist (no sqlite-vec).
// ---------------------------------------------------------------------------

function vecTableExists(db: WriteDb): boolean {
	try {
		const row = db
			.prepare(
				"SELECT name FROM sqlite_master WHERE name = 'vec_embeddings' AND type = 'table'",
			)
			.get();
		return row !== undefined;
	} catch {
		return false;
	}
}

/**
 * Insert or replace a vector in vec_embeddings after writing to embeddings.
 * `embeddingId` must match the embeddings.id value.
 */
export function syncVecInsert(
	db: WriteDb,
	embeddingId: string,
	vector: readonly number[],
): void {
	if (!vecTableExists(db)) return;
	try {
		const f32 = new Float32Array(vector);
		db.prepare(
			"INSERT OR REPLACE INTO vec_embeddings (id, embedding) VALUES (?, ?)",
		).run(embeddingId, f32);
	} catch {
		// sqlite-vec not loaded or schema mismatch — non-fatal
	}
}

/**
 * Remove rows from vec_embeddings that match embedding ids.
 * Call after deleting from the embeddings table.
 */
export function syncVecDeleteByEmbeddingIds(
	db: WriteDb,
	embeddingIds: readonly string[],
): void {
	if (embeddingIds.length === 0 || !vecTableExists(db)) return;
	try {
		const stmt = db.prepare("DELETE FROM vec_embeddings WHERE id = ?");
		for (const id of embeddingIds) {
			stmt.run(id);
		}
	} catch {
		// non-fatal
	}
}

/**
 * Remove all vec_embeddings rows for a given memory (via embeddings join).
 * Use before deleting from embeddings by source_id.
 */
export function syncVecDeleteBySourceId(
	db: WriteDb,
	sourceType: string,
	sourceId: string,
): void {
	if (!vecTableExists(db)) return;
	try {
		const rows = db
			.prepare(
				"SELECT id FROM embeddings WHERE source_type = ? AND source_id = ?",
			)
			.all(sourceType, sourceId) as Array<{ id: string }>;
		if (rows.length === 0) return;
		const stmt = db.prepare("DELETE FROM vec_embeddings WHERE id = ?");
		for (const row of rows) {
			stmt.run(row.id);
		}
	} catch {
		// non-fatal
	}
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
	if (!vecTableExists(db)) return;
	try {
		const rows = db
			.prepare(
				"SELECT id FROM embeddings WHERE source_type = ? AND source_id = ? AND content_hash <> ?",
			)
			.all(sourceType, sourceId, keepContentHash) as Array<{ id: string }>;
		if (rows.length === 0) return;
		const stmt = db.prepare("DELETE FROM vec_embeddings WHERE id = ?");
		for (const row of rows) {
			stmt.run(row.id);
		}
	} catch {
		// non-fatal
	}
}
