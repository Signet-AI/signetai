import { randomUUID } from "node:crypto";
import type { DbAccessor, ReadDb, WriteDb } from "./db-accessor";
import { vectorToBlob } from "./db-helpers";
import type { EmbeddingFetchOptions } from "./embedding-fetch";
import {
	type EmbeddingIndexState,
	type PersistedEmbeddingProfile,
	readEmbeddingIndexState,
} from "./embedding-index-state";
import { beginEmbeddingIndexBuild, failEmbeddingIndexBuild } from "./embedding-index-state";
import type { EmbeddingRole } from "./embedding-profile";
import type { EmbeddingConfig } from "./memory-config";

const STAGING_VECTOR_TABLE = "vec_embeddings_staging";

interface ActiveEmbeddingRow {
	readonly content_hash: string;
	readonly source_type: string;
	readonly source_id: string;
	readonly chunk_text: string;
	readonly agent_id: string | null;
}

export interface EmbeddingMigrationCoverage {
	readonly active: number;
	readonly staged: number;
	readonly missing: number;
	readonly wrongDimensions: number;
	readonly ready: boolean;
}

export interface EmbeddingIndexMigrationStats {
	readonly running: boolean;
	readonly staged: number;
	readonly failed: number;
	readonly coverage: EmbeddingMigrationCoverage | null;
}

export interface EmbeddingIndexMigrationHandle {
	stop(): Promise<void>;
	getStats(): EmbeddingIndexMigrationStats;
}

function assertDimensions(dimensions: number): number {
	if (!Number.isInteger(dimensions) || dimensions <= 0) throw new Error("Invalid staging embedding dimensions");
	return dimensions;
}

function configForProfile(profile: PersistedEmbeddingProfile, configured: EmbeddingConfig): EmbeddingConfig {
	return {
		...configured,
		provider: profile.provider,
		model: profile.model,
		dimensions: profile.dimensions,
		base_url: profile.baseUrl,
		// `legacy-raw` is deliberately truthy so the migration can encode an
		// unknown model without being redirected to the active generation.
		profile: profile.profile ?? "legacy-raw",
		indexGeneration: "staging",
	};
}

function tableExists(db: ReadDb, name: string): boolean {
	return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
}

function isVecVirtualTable(db: ReadDb, name: string): boolean {
	const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) as
		| { sql?: string }
		| undefined;
	return typeof row?.sql === "string" && /^CREATE\s+VIRTUAL\s+TABLE/i.test(row.sql);
}

function createVectorIndex(db: WriteDb, table: string, dimensions: number): void {
	db.exec(`
		CREATE VIRTUAL TABLE ${table} USING vec0(
			id TEXT PRIMARY KEY,
			embedding FLOAT[${assertDimensions(dimensions)}] distance_metric=cosine
		)
	`);
}

/** Creates a dimension-safe inactive vec0 table without touching active recall. */
export function resetStagingVectorIndex(db: WriteDb, dimensions: number): void {
	db.exec(`DROP TABLE IF EXISTS ${STAGING_VECTOR_TABLE}`);
	createVectorIndex(db, STAGING_VECTOR_TABLE, dimensions);
}

/** Rebuild the active sqlite-vec projection from its durable BLOB rows. */
function rebuildActiveVectorIndex(db: WriteDb, dimensions: number): void {
	db.exec("DROP TABLE IF EXISTS vec_embeddings_staging");
	db.exec("DROP TABLE vec_embeddings");
	createVectorIndex(db, "vec_embeddings", dimensions);
	const rows = db.prepare("SELECT id, vector FROM embeddings ORDER BY id").all() as Array<{
		id: string;
		vector: Buffer;
	}>;
	const insert = db.prepare("INSERT INTO vec_embeddings (id, embedding) VALUES (?, ?)");
	for (const row of rows) {
		const vector = new Float32Array(
			row.vector.buffer,
			row.vector.byteOffset,
			row.vector.byteLength / Float32Array.BYTES_PER_ELEMENT,
		);
		if (vector.length !== dimensions)
			throw new Error(`Staged embedding ${row.id} has ${vector.length} dimensions, expected ${dimensions}`);
		insert.run(row.id, vector);
	}
}

export function stagingCoverage(db: ReadDb, dimensions: number): EmbeddingMigrationCoverage {
	const active = (db.prepare("SELECT COUNT(*) AS n FROM embeddings").get() as { n: number } | undefined)?.n ?? 0;
	const staged =
		(db.prepare("SELECT COUNT(*) AS n FROM embeddings_staging").get() as { n: number } | undefined)?.n ?? 0;
	const missing =
		(
			db
				.prepare(
					`SELECT COUNT(*) AS n FROM embeddings e
				 LEFT JOIN embeddings_staging s ON s.content_hash = e.content_hash
				 WHERE s.id IS NULL`,
				)
				.get() as { n: number } | undefined
		)?.n ?? 0;
	const wrongDimensions =
		(
			db.prepare("SELECT COUNT(*) AS n FROM embeddings_staging WHERE dimensions != ?").get(dimensions) as
				| { n: number }
				| undefined
		)?.n ?? 0;
	return {
		active,
		staged,
		missing,
		wrongDimensions,
		ready: missing === 0 && wrongDimensions === 0 && active === staged,
	};
}

/** Remove rows whose active source was deleted or changed while staging ran. */
function pruneStagingRows(accessor: DbAccessor): void {
	accessor.withWriteTx((db) => {
		const stale = db
			.prepare(
				`SELECT s.id FROM embeddings_staging s
				 LEFT JOIN embeddings e ON e.content_hash = s.content_hash
				 WHERE e.id IS NULL`,
			)
			.all() as Array<{ id: string }>;
		if (stale.length === 0) return;
		const deleteVector = db.prepare(`DELETE FROM ${STAGING_VECTOR_TABLE} WHERE id = ?`);
		const deleteEmbedding = db.prepare("DELETE FROM embeddings_staging WHERE id = ?");
		for (const { id } of stale) {
			deleteVector.run(id);
			deleteEmbedding.run(id);
		}
	});
}

export async function stageEmbeddingBatch(input: {
	readonly accessor: DbAccessor;
	readonly configured: EmbeddingConfig;
	readonly fetchEmbedding: (
		text: string,
		cfg: EmbeddingConfig,
		role?: EmbeddingRole,
		opts?: EmbeddingFetchOptions,
	) => Promise<number[] | null>;
	readonly batchSize: number;
}): Promise<{ staged: number; coverage: EmbeddingMigrationCoverage | null }> {
	const state = input.accessor.withReadDb((db) => readEmbeddingIndexState(db));
	if (state?.state !== "building" || !state.staging) return { staged: 0, coverage: null };
	const profile = state.staging;
	// Writes and source purges continue against the active slot during a build.
	// Without this cleanup, an obsolete staging row would keep the count-based
	// readiness gate false forever after its active counterpart disappears.
	pruneStagingRows(input.accessor);
	const rows = input.accessor.withReadDb((db) => {
		if (!tableExists(db, STAGING_VECTOR_TABLE)) throw new Error("Staging vector index is unavailable");
		return db
			.prepare(
				`SELECT e.content_hash, e.source_type, e.source_id, e.chunk_text, e.agent_id
				 FROM embeddings e
				 LEFT JOIN embeddings_staging s ON s.content_hash = e.content_hash
				 WHERE s.id IS NULL OR s.dimensions != ?
				 ORDER BY e.created_at ASC
				 LIMIT ?`,
			)
			.all(profile.dimensions, input.batchSize) as ActiveEmbeddingRow[];
	});

	let staged = 0;
	for (const row of rows) {
		const vector = await input.fetchEmbedding(row.chunk_text, configForProfile(profile, input.configured), "document", {
			usage: { source: "artifact-index", agentId: row.agent_id ?? undefined },
		});
		if (!vector) continue;
		if (vector.length !== profile.dimensions) {
			throw new Error(
				`Staging provider returned ${vector.length} dimensions for ${profile.model}; expected ${profile.dimensions}`,
			);
		}
		input.accessor.withWriteTx((db) => {
			const id = randomUUID();
			db.prepare(
				`INSERT INTO embeddings_staging
				 (id, content_hash, vector, dimensions, source_type, source_id, chunk_text, created_at, agent_id)
				 VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)
				 ON CONFLICT(content_hash) DO UPDATE SET
				   vector = excluded.vector, dimensions = excluded.dimensions, source_type = excluded.source_type,
				   source_id = excluded.source_id, chunk_text = excluded.chunk_text, created_at = excluded.created_at,
				   agent_id = excluded.agent_id`,
			).run(
				id,
				row.content_hash,
				vectorToBlob(vector),
				vector.length,
				row.source_type,
				row.source_id,
				row.chunk_text,
				row.agent_id,
			);
			const stored = db.prepare("SELECT id FROM embeddings_staging WHERE content_hash = ?").get(row.content_hash) as
				| { id: string }
				| undefined;
			if (stored)
				db.prepare(`INSERT OR REPLACE INTO ${STAGING_VECTOR_TABLE} (id, embedding) VALUES (?, ?)`).run(
					stored.id,
					new Float32Array(vector),
				);
		});
		staged++;
	}

	const coverage = input.accessor.withReadDb((db) => stagingCoverage(db, profile.dimensions));
	return { staged, coverage };
}

/**
 * Promotion runs in one IMMEDIATE transaction. The coverage recheck closes the
 * gap between an asynchronous batch and a concurrent memory/source write.
 */
export function promoteStagingIndex(accessor: DbAccessor): boolean {
	return accessor.withWriteTx((db) => {
		const state = readEmbeddingIndexState(db);
		if (state?.state !== "building" || !state.staging) return false;
		if (!stagingCoverage(db, state.staging.dimensions).ready) return false;
		if (!tableExists(db, STAGING_VECTOR_TABLE)) return false;
		db.prepare(
			`UPDATE memories SET embedding_model = ?
			 WHERE id IN (SELECT source_id FROM embeddings_staging WHERE source_type = 'memory')`,
		).run(state.staging.model);

		// Keep exactly two slots: after the swap the former active index becomes
		// the inactive/rollback slot, ready to be cleared only for the next build.
		db.exec("ALTER TABLE embeddings_staging RENAME TO embeddings_next");
		db.exec("ALTER TABLE embeddings RENAME TO embeddings_staging");
		db.exec("ALTER TABLE embeddings_next RENAME TO embeddings");
		// sqlite-vec virtual-table renames leave its backing tables associated
		// with the old table name. Rebuild the projection after swapping the
		// durable slots instead; the transaction keeps old recall visible until
		// the complete new vec0 index is committed. Plain tables remain useful
		// test doubles and retain the inexpensive rename path.
		if (isVecVirtualTable(db, "vec_embeddings") && isVecVirtualTable(db, STAGING_VECTOR_TABLE)) {
			rebuildActiveVectorIndex(db, state.staging.dimensions);
		} else {
			db.exec(`ALTER TABLE ${STAGING_VECTOR_TABLE} RENAME TO vec_embeddings_next`);
			db.exec("ALTER TABLE vec_embeddings RENAME TO vec_embeddings_staging");
			db.exec("ALTER TABLE vec_embeddings_next RENAME TO vec_embeddings");
		}
		db.prepare(
			`UPDATE embedding_index_state
			 SET active_profile_json = staging_profile_json, staging_profile_json = NULL,
			     state = 'ready', last_error = NULL, updated_at = ?
			 WHERE id = 1`,
		).run(new Date().toISOString());
		// Reclaim pages freed by the vec0 shadow table rebuild (#1139).
		// incremental_vacuum is transactional and safe inside BEGIN IMMEDIATE.
		db.exec("PRAGMA incremental_vacuum");
		return true;
	});
}

/**
 * Rebuild the inactive slot without ever querying it. Active/staging coverage
 * is rechecked in the promotion transaction, so a write arriving during the
 * final batch simply postpones promotion until the next pass.
 */
export function startEmbeddingIndexMigration(input: {
	readonly accessor: DbAccessor;
	readonly configured: EmbeddingConfig;
	readonly fetchEmbedding: (
		text: string,
		cfg: EmbeddingConfig,
		role?: EmbeddingRole,
		opts?: EmbeddingFetchOptions,
	) => Promise<number[] | null>;
	readonly checkProvider: (cfg: EmbeddingConfig) => Promise<{ available: boolean }>;
	readonly pollMs: number;
	readonly batchSize: number;
	/** Recreate active-model workers after an atomic promotion. */
	readonly onPromoted?: () => void;
}): EmbeddingIndexMigrationHandle | null {
	// Unknown models still need an isolated rebuild. They use the identity
	// formatter rather than being rejected solely because Signet does not know
	// a model-specific retrieval prefix.
	if (input.configured.provider === "none") return null;

	let running = true;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let staged = 0;
	let failed = 0;
	let coverage: EmbeddingMigrationCoverage | null = null;

	const before = input.accessor.withReadDb((db) => readEmbeddingIndexState(db));
	const initial = input.accessor.withWriteTx((db) => beginEmbeddingIndexBuild(db, input.configured));
	const staging = initial.staging;
	if (initial.state !== "building" || !staging) return null;
	const resumeExistingBuild = before?.state === "building" && before.staging?.fingerprint === staging.fingerprint;
	try {
		if (resumeExistingBuild) {
			const hasStagingVectorIndex = input.accessor.withReadDb((db) => tableExists(db, STAGING_VECTOR_TABLE));
			if (!hasStagingVectorIndex) throw new Error("Staging vector index is unavailable while resuming a build");
		} else {
			input.accessor.withWriteTx((db) => resetStagingVectorIndex(db, staging.dimensions));
		}
	} catch (error) {
		input.accessor.withWriteTx((db) =>
			failEmbeddingIndexBuild(db, error instanceof Error ? error.message : String(error)),
		);
		return null;
	}

	const tick = async (): Promise<void> => {
		if (!running) return;
		try {
			const state = input.accessor.withReadDb((db) => readEmbeddingIndexState(db));
			if (state?.state !== "building" || !state.staging) return;
			const providerCfg = configForProfile(state.staging, input.configured);
			if (!(await input.checkProvider(providerCfg)).available) {
				failed++;
				return;
			}
			const result = await stageEmbeddingBatch(input);
			staged += result.staged;
			coverage = result.coverage;
			if (coverage?.ready && promoteStagingIndex(input.accessor)) {
				running = false;
				input.onPromoted?.();
			}
		} catch (error) {
			failed++;
			input.accessor.withWriteTx((db) =>
				failEmbeddingIndexBuild(db, error instanceof Error ? error.message : String(error)),
			);
		} finally {
			if (running) timer = setTimeout(() => void tick(), input.pollMs);
		}
	};
	void tick();

	return {
		async stop(): Promise<void> {
			running = false;
			if (timer) clearTimeout(timer);
		},
		getStats: () => ({ running, staged, failed, coverage }),
	};
}
