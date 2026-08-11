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

export interface MigrationEmbeddingRow extends UnembeddedRow {
	readonly currentModel: string | null;
	readonly currentDimensions: number | null;
}

export interface MigrationEmbeddingSource {
	readonly model: string | null;
	readonly dimensions: number | null;
	readonly count: number;
}

const migrationWhere = `m.agent_id = ? AND m.is_deleted = 0 AND m.content_hash IS NOT NULL AND trim(m.content_hash) <> ''
			 AND (? = 1 OR m.embedding_model IS NULL OR m.embedding_model <> ? OR NOT EXISTS (
			 SELECT 1 FROM embeddings e WHERE e.source_type = 'memory' AND e.source_id = m.id AND e.dimensions = ?))`;

export function listEmbeddingMigrationRows(
	db: ReadDb,
	model: string,
	dimensions: number,
	all: boolean,
	limit: number,
	agentId: string,
): ReadonlyArray<MigrationEmbeddingRow> {
	return db
		.prepare(
			`SELECT m.id, m.content, m.content_hash AS contentHash, m.embedding_model AS currentModel,
				(SELECT e.dimensions FROM embeddings e WHERE e.source_type = 'memory' AND e.source_id = m.id LIMIT 1) AS currentDimensions
			 FROM memories m WHERE ${migrationWhere}
			 ORDER BY m.updated_at ASC LIMIT ?`,
		)
		.all(agentId, all ? 1 : 0, model, dimensions, limit) as MigrationEmbeddingRow[];
}

export function countEmbeddingMigrationRows(
	db: ReadDb,
	model: string,
	dimensions: number,
	all: boolean,
	agentId: string,
): number {
	return count(
		db,
		`SELECT COUNT(*) AS n FROM memories m WHERE ${migrationWhere}`,
		agentId,
		all ? 1 : 0,
		model,
		dimensions,
	);
}

export function listEmbeddingMigrationSources(
	db: ReadDb,
	model: string,
	dimensions: number,
	all: boolean,
	agentId: string,
): ReadonlyArray<MigrationEmbeddingSource> {
	return db
		.prepare(
			`SELECT m.embedding_model AS model,
				(SELECT e.dimensions FROM embeddings e WHERE e.source_type = 'memory' AND e.source_id = m.id LIMIT 1) AS dimensions,
				COUNT(*) AS count
			 FROM memories m WHERE ${migrationWhere}
			 GROUP BY m.embedding_model, dimensions
			 ORDER BY count DESC, model ASC`,
		)
		.all(agentId, all ? 1 : 0, model, dimensions) as MigrationEmbeddingSource[];
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

export function listStaleEmbeddingRows(
	db: ReadDb,
	model: string,
	limit: number,
	now = new Date().toISOString(),
): ReadonlyArray<StaleEmbeddingRow> {
	return db
		.prepare(
			`SELECT m.id, m.content, m.content_hash AS contentHash,
			        m.embedding_model AS currentModel
			 FROM memories m
			 LEFT JOIN embedding_repair_backoff b
			   ON b.memory_id = m.id AND b.content_hash = m.content_hash AND b.model = ?
			 WHERE m.is_deleted = 0
			   AND m.content_hash IS NOT NULL
			   AND trim(m.content_hash) <> ''
			   AND (b.retry_at IS NULL OR b.retry_at <= ?)
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
		.all(model, now, model, limit) as StaleEmbeddingRow[];
}
