import type { ReadDb } from "./db-accessor";

export interface UnembeddedRow {
	readonly id: string;
	readonly content: string;
	readonly contentHash: string | null;
}

export interface StaleEmbeddingRow {
	readonly id: string;
	readonly content: string;
	readonly contentHash: string;
	readonly currentModel: string | null;
}

function count(db: ReadDb, sql: string, ...args: readonly unknown[]): number {
	const row = db.prepare(sql).get(...args) as { n: number } | undefined;
	return row?.n ?? 0;
}

export function countUnembeddedMemories(db: ReadDb): number {
	return count(
		db,
		`SELECT COUNT(*) AS n FROM memories m
		 WHERE m.is_deleted = 0
		   AND NOT EXISTS (
		     SELECT 1 FROM embeddings e
		     WHERE e.source_type = 'memory' AND e.source_id = m.id
		   )
		   AND NOT EXISTS (
		     SELECT 1 FROM embeddings e
		     WHERE e.source_type = 'memory'
		       AND m.content_hash IS NOT NULL
		       AND e.content_hash = m.content_hash
		   )`,
	);
}

export function listUnembeddedMemories(db: ReadDb, limit: number): ReadonlyArray<UnembeddedRow> {
	return db
		.prepare(
			`SELECT m.id, m.content, m.content_hash AS contentHash
			 FROM memories m
			 WHERE m.is_deleted = 0
			   AND NOT EXISTS (
			     SELECT 1 FROM embeddings e
			     WHERE e.source_type = 'memory' AND e.source_id = m.id
			   )
			   AND NOT EXISTS (
			     SELECT 1 FROM embeddings e
			     WHERE e.source_type = 'memory'
			       AND m.content_hash IS NOT NULL
			       AND e.content_hash = m.content_hash
			   )
			 ORDER BY m.created_at ASC
			 LIMIT ?`,
		)
		.all(limit) as UnembeddedRow[];
}

export function listStaleEmbeddingRows(db: ReadDb, model: string, limit: number): ReadonlyArray<StaleEmbeddingRow> {
	return db
		.prepare(
			`SELECT m.id, m.content, m.content_hash AS contentHash,
			        m.embedding_model AS currentModel
			 FROM memories m
			 WHERE m.is_deleted = 0
			   AND m.content_hash IS NOT NULL
			   AND trim(m.content_hash) <> ''
			   AND (
			     (
			       NOT EXISTS (
			         SELECT 1 FROM embeddings e
			         WHERE e.source_type = 'memory' AND e.source_id = m.id
			       )
			       AND NOT EXISTS (
			         SELECT 1 FROM embeddings e
			         WHERE e.source_type = 'memory' AND e.content_hash = m.content_hash
			       )
			     )
			     OR EXISTS (
			       SELECT 1 FROM embeddings e
			       WHERE e.source_type = 'memory'
			         AND e.source_id = m.id
			         AND e.content_hash <> m.content_hash
			     )
			     OR (m.embedding_model IS NOT NULL AND m.embedding_model <> ?)
			   )
			 ORDER BY m.updated_at DESC
			 LIMIT ?`,
		)
		.all(model, limit) as StaleEmbeddingRow[];
}
