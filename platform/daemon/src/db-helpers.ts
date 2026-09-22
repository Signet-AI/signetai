import { createRequire } from "node:module";
import { type ReadDb, type WriteDb, readVecEmbeddingDimensions } from "./db-accessor";
let native: typeof import("@signet/native") | null = null;
try {
	const esmRequire = createRequire(import.meta.url);
	native = esmRequire("@signet/native");
} catch {}
export function vectorToBlob(vec: readonly number[]): Buffer {
	if (native !== null) {
		return native.vectorToBlob(vec as number[]);
	}
	const f32 = new Float32Array(vec);
	return Buffer.from(f32.buffer.slice(0));
}
export function countChanges(result: unknown): number {
	if (typeof result !== "object" || result === null) return 0;
	const row = result as { changes?: number };
	return typeof row.changes === "number" ? row.changes : 0;
}

function invalidateUmapCache(db: WriteDb): void {
	try {
		db.prepare("DELETE FROM umap_cache").run();
	} catch {}
}

function vecTableExists(db: WriteDb): boolean {
	try {
		const row = db.prepare("SELECT name FROM sqlite_master WHERE name = 'vec_embeddings' AND type = 'table'").get();
		return row != null;
	} catch {
		return false;
	}
}
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
export function syncVecInsert(db: WriteDb, embeddingId: string, vector: readonly number[]): void {
	invalidateUmapCache(db);
	if (!vecTableExists(db)) return;
	try {
		const f32 = new Float32Array(vector);
		db.prepare("INSERT OR REPLACE INTO vec_embeddings (id, embedding) VALUES (?, ?)").run(embeddingId, f32);
	} catch {}
}
export function syncVecDeleteByEmbeddingIds(db: WriteDb, embeddingIds: readonly string[]): boolean {
	if (embeddingIds.length === 0) return true;
	invalidateUmapCache(db);
	if (!vecTableExists(db)) return true;
	try {
		const stmt = db.prepare("DELETE FROM vec_embeddings WHERE id = ?");
		for (const id of embeddingIds) {
			stmt.run(id);
		}
		return true;
	} catch {
		return false;
	}
}
export function syncVecDeleteBySourceId(db: WriteDb, sourceType: string, sourceId: string): void {
	invalidateUmapCache(db);
	if (!vecTableExists(db)) return;
	try {
		const rows = db
			.prepare("SELECT id FROM embeddings WHERE source_type = ? AND source_id = ?")
			.all(sourceType, sourceId) as Array<{ id: string }>;
		if (rows.length === 0) return;
		const stmt = db.prepare("DELETE FROM vec_embeddings WHERE id = ?");
		for (const row of rows) {
			stmt.run(row.id);
		}
	} catch {}
}
export function syncVecDeleteBySourceExceptHash(
	db: WriteDb,
	sourceType: string,
	sourceId: string,
	keepContentHash: string,
): void {
	invalidateUmapCache(db);
	if (!vecTableExists(db)) return;
	try {
		const rows = db
			.prepare("SELECT id FROM embeddings WHERE source_type = ? AND source_id = ? AND content_hash <> ?")
			.all(sourceType, sourceId, keepContentHash) as Array<{ id: string }>;
		if (rows.length === 0) return;
		const stmt = db.prepare("DELETE FROM vec_embeddings WHERE id = ?");
		for (const row of rows) {
			stmt.run(row.id);
		}
	} catch {}
}
export function tableExists(db: { prepare(sql: string): { get(...args: unknown[]): unknown } }, name: string): boolean {
	return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) != null;
}
