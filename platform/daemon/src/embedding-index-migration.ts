import { randomUUID } from "node:crypto";
import { type DbAccessor, DbWriteQueueFullError, type ReadDb, type WriteDb } from "./db-accessor";
import { yieldEvery } from "./async-yield";
import { vectorToBlob } from "./db-helpers";
import type { EmbeddingFetchOptions } from "./embedding-fetch";
import { type PersistedEmbeddingProfile, readEmbeddingIndexState } from "./embedding-index-state";
import { beginEmbeddingIndexBuild, failEmbeddingIndexBuild } from "./embedding-index-state";
import type { EmbeddingRole } from "./embedding-profile";
import { logger } from "./logger";
import type { EmbeddingConfig } from "./memory-config";
import type { PipelineCauseFamily } from "./pipeline-operation";

const STAGING_VECTOR_TABLE = "vec_embeddings_staging";
const VECTOR_REBUILD_BATCH_SIZE = 50;
const VECTOR_REBUILD_RETRY_DELAY_MS = 100;
const MAX_VECTOR_REBUILD_RETRIES_WITHOUT_CANCELLATION = 3;

// #1160: after this many consecutive provider-unavailable checks the build is
// aborted (state='failed') instead of retrying forever; the daemon restarts
// the build on the next config change / daemon restart.
const MAX_CONSECUTIVE_PROVIDER_FAILURES = 6;
// Backoff grows pollMs * 2^n between failed checks, capped at this delay.
const MAX_PROVIDER_BACKOFF_MS = 60_000;

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
	readonly quarantined: number;
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
	return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) != null;
}

async function withQueuedWrite<T>(accessor: DbAccessor, fn: (db: WriteDb) => T): Promise<T> {
	const enqueue = accessor.withWriteTxAsync;
	if (!enqueue) throw new Error("Async database writes are unavailable for embedding migration");
	return enqueue(fn);
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

function isTerminalMigrationFailure(
	cause: PipelineCauseFamily | undefined,
): cause is "context_limit" | "invalid_input" {
	return cause === "context_limit" || cause === "invalid_input";
}

function migrationFailureCount(db: ReadDb, targetFingerprint: string | undefined): number {
	if (!targetFingerprint || !tableExists(db, "embedding_index_failures")) return 0;
	return (
		(
			db
				.prepare(
					"SELECT COUNT(*) AS n FROM embedding_index_failures f INNER JOIN embeddings e ON e.content_hash = f.content_hash WHERE f.target_fingerprint = ? AND f.retry_policy = 'quarantined'",
				)
				.get(targetFingerprint) as { n: number } | undefined
		)?.n ?? 0
	);
}

/** Creates a dimension-safe inactive vec0 table without touching active recall. */
export function resetStagingVectorIndex(db: WriteDb, dimensions: number): void {
	db.exec(`DROP TABLE IF EXISTS ${STAGING_VECTOR_TABLE}`);
	createVectorIndex(db, STAGING_VECTOR_TABLE, dimensions);
}

function isDuplicateVectorProjectionRow(error: unknown): boolean {
	return error instanceof Error && /vec_embeddings.*primary key/i.test(error.message);
}

/**
 * Rebuild the active sqlite-vec projection from durable BLOB rows in bounded
 * transactions. The projection is allowed to lag while active writers run, so
 * duplicate ids are intentionally ignored. A failed chunk keeps its keyset
 * cursor and retries until the caller stops the migration.
 */
async function rebuildActiveVectorIndex(
	accessor: DbAccessor,
	dimensions: number,
	batchSize = VECTOR_REBUILD_BATCH_SIZE,
	shouldContinue?: () => boolean,
): Promise<void> {
	const canCancel = shouldContinue !== undefined;
	const isRunning = shouldContinue ?? (() => true);
	const limit = Math.max(1, Math.floor(batchSize));
	let lastId: string | null = null;
	let initialized = false;
	let retries = 0;
	const yieldAfterChunk = yieldEvery(1);

	while (true) {
		if (!isRunning()) throw new Error("Embedding vector rebuild stopped");
		try {
			if (!initialized) {
				await withQueuedWrite(accessor, (db) => {
					db.exec("DROP TABLE IF EXISTS vec_embeddings_staging");
					db.exec("DROP TABLE vec_embeddings");
					createVectorIndex(db, "vec_embeddings", dimensions);
				});
				initialized = true;
			}

			const rows = await accessor.withReadDbAsync(async (db) => {
				const query =
					lastId === null
						? "SELECT id, vector FROM embeddings ORDER BY id LIMIT ?"
						: "SELECT id, vector FROM embeddings WHERE id > ? ORDER BY id LIMIT ?";
				return (lastId === null ? db.prepare(query).all(limit) : db.prepare(query).all(lastId, limit)) as Array<{
					readonly id: string;
					readonly vector: Uint8Array;
				}>;
			});
			if (rows.length === 0) return;

			await withQueuedWrite(accessor, (db) => {
				// sqlite-vec does not implement SQLite's conflict algorithms for
				// virtual tables. Keep the explicit OR IGNORE contract for normal
				// SQLite projections, then swallow vec0's equivalent duplicate error.
				const insert = db.prepare("INSERT OR IGNORE INTO vec_embeddings (id, embedding) VALUES (?, ?)");
				const existing = db.prepare("SELECT 1 FROM vec_embeddings WHERE id = ?");
				for (const row of rows) {
					const vector = new Float32Array(
						row.vector.buffer,
						row.vector.byteOffset,
						row.vector.byteLength / Float32Array.BYTES_PER_ELEMENT,
					);
					if (vector.length !== dimensions)
						throw new Error(`Embedding ${row.id} has ${vector.length} dimensions, expected ${dimensions}`);
					if (existing.get(row.id) != null) continue;
					try {
						insert.run(row.id, vector);
					} catch (error) {
						if (!isDuplicateVectorProjectionRow(error)) throw error;
					}
				}
			});
			lastId = rows[rows.length - 1]?.id ?? null;
			retries = 0;
			await yieldAfterChunk();
		} catch (error) {
			// Dimension mismatches are durable data errors, not transient rebuild
			// failures. Keep the existing fail-closed behavior for those rows.
			if (error instanceof Error && error.message.startsWith("Embedding ")) throw error;
			if (!isRunning()) throw error;
			if (!canCancel && retries >= MAX_VECTOR_REBUILD_RETRIES_WITHOUT_CANCELLATION) throw error;
			retries++;
			logger.warn("embedding", "Vector projection rebuild failed; retrying the current chunk", {
				error: error instanceof Error ? error.message : String(error),
				retry: retries,
			});
			await new Promise<void>((resolve) => setTimeout(resolve, VECTOR_REBUILD_RETRY_DELAY_MS));
		}
	}
}

export function stagingCoverage(
	db: ReadDb,
	dimensions: number,
	targetFingerprint?: string,
): EmbeddingMigrationCoverage {
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
	const quarantined = migrationFailureCount(db, targetFingerprint);
	return {
		active,
		staged,
		missing,
		wrongDimensions,
		quarantined,
		ready:
			missing === quarantined &&
			wrongDimensions === 0 &&
			active === staged + quarantined &&
			(active === 0 || staged > 0),
	};
}

/** Remove rows whose active source was deleted or changed while staging ran. */
async function pruneStagingRows(accessor: DbAccessor): Promise<void> {
	await withQueuedWrite(accessor, (db) => {
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

async function recordMigrationFailure(
	accessor: DbAccessor,
	row: ActiveEmbeddingRow,
	profile: PersistedEmbeddingProfile,
	failureClass: "context_limit" | "invalid_input",
): Promise<void> {
	await withQueuedWrite(accessor, (db) => {
		if (!tableExists(db, "embedding_index_failures")) return;
		const now = new Date().toISOString();
		db.prepare(
			`INSERT INTO embedding_index_failures
			 (content_hash, source_type, source_id, agent_id, target_fingerprint, provider, model,
			  failure_class, attempts, retry_policy, first_failed_at, last_failed_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 'quarantined', ?, ?)
			 ON CONFLICT(content_hash, target_fingerprint) DO UPDATE SET
			   source_type = excluded.source_type, source_id = excluded.source_id, agent_id = excluded.agent_id,
			   provider = excluded.provider, model = excluded.model, failure_class = excluded.failure_class,
			   attempts = embedding_index_failures.attempts + 1, retry_policy = 'quarantined',
			   last_failed_at = excluded.last_failed_at`,
		).run(
			row.content_hash,
			row.source_type,
			row.source_id,
			row.agent_id,
			profile.fingerprint,
			profile.provider,
			profile.model,
			failureClass,
			now,
			now,
		);
	});
}

export async function stageEmbeddingBatch(input: {
	readonly accessor: DbAccessor;
	readonly configured: EmbeddingConfig;
	/** Live re-read of the current config; falls back to `configured` when unset (#1160). */
	readonly readConfigured?: () => EmbeddingConfig;
	readonly fetchEmbedding: (
		text: string,
		cfg: EmbeddingConfig,
		role?: EmbeddingRole,
		opts?: EmbeddingFetchOptions,
	) => Promise<number[] | null>;
	readonly batchSize: number;
}): Promise<{ staged: number; coverage: EmbeddingMigrationCoverage | null }> {
	const state = await input.accessor.withReadDbAsync(async (db) => readEmbeddingIndexState(db));
	if (state?.state !== "building" || !state.staging) return { staged: 0, coverage: null };
	const profile = state.staging;
	const configured = input.readConfigured ? input.readConfigured() : input.configured;
	// Writes and source purges continue against the active slot during a build.
	// Without this cleanup, an obsolete staging row would keep the count-based
	// readiness gate false forever after its active counterpart disappears.
	await pruneStagingRows(input.accessor);
	const rows = await input.accessor.withReadDbAsync(async (db) => {
		if (!tableExists(db, STAGING_VECTOR_TABLE)) throw new Error("Staging vector index is unavailable");
		const hasFailures = tableExists(db, "embedding_index_failures");
		const failureFilter = hasFailures
			? ` AND NOT EXISTS (
					SELECT 1 FROM embedding_index_failures f
					WHERE f.content_hash = e.content_hash
					  AND f.target_fingerprint = ?
					  AND f.retry_policy = 'quarantined'
				)`
			: "";
		return db
			.prepare(
				`SELECT e.content_hash, e.source_type, e.source_id, e.chunk_text, e.agent_id
				 FROM embeddings e
				 LEFT JOIN embeddings_staging s ON s.content_hash = e.content_hash
				 WHERE (s.id IS NULL OR s.dimensions != ?)
				 ${failureFilter}
				 ORDER BY e.created_at ASC
				 LIMIT ?`,
			)
			.all(
				...(hasFailures
					? [profile.dimensions, profile.fingerprint, input.batchSize]
					: [profile.dimensions, input.batchSize]),
			) as ActiveEmbeddingRow[];
	});

	let staged = 0;
	for (const row of rows) {
		let failureCause: PipelineCauseFamily | undefined;
		const vector = await input.fetchEmbedding(row.chunk_text, configForProfile(profile, configured), "document", {
			usage: { source: "artifact-index", agentId: row.agent_id ?? undefined },
			onFailure: (cause) => {
				failureCause = cause;
			},
		});
		if (!vector) {
			if (isTerminalMigrationFailure(failureCause)) {
				await recordMigrationFailure(input.accessor, row, profile, failureCause);
			}
			continue;
		}
		if (vector.length !== profile.dimensions) {
			throw new Error(
				`Staging provider returned ${vector.length} dimensions for ${profile.model}; expected ${profile.dimensions}`,
			);
		}
		await withQueuedWrite(input.accessor, (db) => {
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

	const coverage = await input.accessor.withReadDbAsync(async (db) =>
		stagingCoverage(db, profile.dimensions, profile.fingerprint),
	);
	return { staged, coverage };
}

/**
 * Promotion swaps durable embedding slots in one short transaction. A virtual
 * sqlite-vec projection is rebuilt after that transaction in bounded chunks so
 * promotion never hides an all-row rebuild behind BEGIN IMMEDIATE.
 */
export async function promoteStagingIndex(
	accessor: DbAccessor,
	options?: { readonly vectorBatchSize?: number; readonly shouldContinue?: () => boolean },
): Promise<boolean> {
	const plan = await withQueuedWrite(accessor, (db) => {
		const state = readEmbeddingIndexState(db);
		if (state?.state !== "building" || !state.staging) return null;
		if (!stagingCoverage(db, state.staging.dimensions, state.staging.fingerprint).ready) return null;
		if (!tableExists(db, STAGING_VECTOR_TABLE)) return null;
		let rebuildVectorIndex = false;
		db.prepare(
			`UPDATE memories SET embedding_model = ?
			 WHERE id IN (SELECT source_id FROM embeddings_staging WHERE source_type = 'memory')`,
		).run(state.staging.model);

		// Keep exactly two durable slots: after the swap the former active slot
		// becomes the inactive/rollback slot, ready to be cleared for the next build.
		db.exec("ALTER TABLE embeddings_staging RENAME TO embeddings_next");
		db.exec("ALTER TABLE embeddings RENAME TO embeddings_staging");
		db.exec("ALTER TABLE embeddings_next RENAME TO embeddings");
		// sqlite-vec virtual-table renames leave its backing tables associated
		// with the old table name. Defer that projection rebuild until after the
		// durable swap. Plain tables retain the inexpensive rename path.
		if (isVecVirtualTable(db, "vec_embeddings") && isVecVirtualTable(db, STAGING_VECTOR_TABLE)) {
			rebuildVectorIndex = true;
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
		return { dimensions: state.staging.dimensions, rebuildVectorIndex };
	});
	if (plan === null) return false;
	if (plan.rebuildVectorIndex) {
		await rebuildActiveVectorIndex(accessor, plan.dimensions, options?.vectorBatchSize, options?.shouldContinue);
	}
	if (accessor.incrementalVacuumAsync) await accessor.incrementalVacuumAsync();
	return true;
}

/**
 * Rebuild the inactive slot without ever querying it. Active/staging coverage
 * is rechecked in the promotion transaction, so a write arriving during the
 * final batch simply postpones promotion until the next pass.
 */
export async function startEmbeddingIndexMigration(input: {
	readonly accessor: DbAccessor;
	readonly configured: EmbeddingConfig;
	/** Live re-read of the current config; falls back to `configured` when unset (#1160). */
	readonly readConfigured?: () => EmbeddingConfig;
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
}): Promise<EmbeddingIndexMigrationHandle | null> {
	// Unknown models still need an isolated rebuild. They use the identity
	// formatter rather than being rejected solely because Signet does not know
	// a model-specific retrieval prefix.
	if (input.configured.provider === "none") return null;

	let running = true;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let staged = 0;
	let failed = 0;
	let coverage: EmbeddingMigrationCoverage | null = null;
	// Consecutive provider-unavailable checks drive exponential backoff and
	// eventually fail the build (#1160) so a stale/stuck build cannot spin at
	// ~100% CPU forever retrying an unreachable provider.
	let consecutiveFailures = 0;
	let nextDelayMs = input.pollMs;
	let tickPromise: Promise<void> | null = null;

	const before = await input.accessor.withReadDbAsync(async (db) => readEmbeddingIndexState(db));
	const initial = await withQueuedWrite(input.accessor, (db) => beginEmbeddingIndexBuild(db, input.configured));
	const staging = initial.staging;
	if (initial.state !== "building" || !staging) return null;
	const resumeExistingBuild = before?.state === "building" && before.staging?.fingerprint === staging.fingerprint;
	try {
		if (resumeExistingBuild) {
			const hasStagingVectorIndex = await input.accessor.withReadDbAsync(async (db) =>
				tableExists(db, STAGING_VECTOR_TABLE),
			);
			if (!hasStagingVectorIndex) throw new Error("Staging vector index is unavailable while resuming a build");
		} else {
			await withQueuedWrite(input.accessor, (db) => resetStagingVectorIndex(db, staging.dimensions));
		}
	} catch (error) {
		await withQueuedWrite(input.accessor, (db) =>
			failEmbeddingIndexBuild(db, error instanceof Error ? error.message : String(error)),
		);
		return null;
	}

	const tick = async (): Promise<void> => {
		if (!running) return;
		nextDelayMs = input.pollMs;
		try {
			const state = await input.accessor.withReadDbAsync(async (db) => readEmbeddingIndexState(db));
			if (state?.state !== "building" || !state.staging) return;
			// The persisted staging profile can go stale when agent.yaml
			// changes mid-build; the migration then spins failing the old
			// provider forever (#1160). Re-begin against the LIVE config (re-read
			// from disk each tick): a no-op when nothing changed, a restart when
			// the config did.
			const configured = input.readConfigured ? input.readConfigured() : input.configured;
			const restarted = await withQueuedWrite(input.accessor, (db) => beginEmbeddingIndexBuild(db, configured));
			if (restarted.state !== "building" || !restarted.staging) {
				// The live config now matches the active generation, so begin
				// abandoned the in-flight build; stop polling until a new build
				// is wanted.
				running = false;
				return;
			}
			const currentStaging = restarted.staging;
			if (currentStaging.fingerprint !== state.staging.fingerprint) {
				logger.warn(
					"embedding",
					"Embedding config changed during migration; restarting the staging build with the current profile",
				);
				await withQueuedWrite(input.accessor, (db) => resetStagingVectorIndex(db, currentStaging.dimensions));
				consecutiveFailures = 0;
				return;
			}
			const providerCfg = configForProfile(state.staging, configured);
			if (!(await input.checkProvider(providerCfg)).available) {
				consecutiveFailures++;
				failed++;
				if (consecutiveFailures >= MAX_CONSECUTIVE_PROVIDER_FAILURES) {
					const message = `Embedding provider unavailable after ${consecutiveFailures} consecutive checks; aborting the build`;
					logger.error("embedding", message);
					await withQueuedWrite(input.accessor, (db) => failEmbeddingIndexBuild(db, message));
					running = false;
					return;
				}
				nextDelayMs = Math.min(input.pollMs * 2 ** Math.min(consecutiveFailures, 6), MAX_PROVIDER_BACKOFF_MS);
				return;
			}
			consecutiveFailures = 0;
			const result = await stageEmbeddingBatch(input);
			staged += result.staged;
			coverage = result.coverage;
			if (coverage?.ready && (await promoteStagingIndex(input.accessor, { shouldContinue: () => running }))) {
				running = false;
				input.onPromoted?.();
			}
		} catch (error) {
			if (error instanceof DbWriteQueueFullError) {
				nextDelayMs = Math.min(Math.max(input.pollMs, 100), MAX_PROVIDER_BACKOFF_MS);
				logger.warn("embedding", "Embedding migration write admission is full; retrying later");
				return;
			}
			if (!running || (error instanceof Error && error.message === "DbAccessor is closed")) {
				running = false;
				return;
			}
			consecutiveFailures++;
			failed++;
			try {
				await withQueuedWrite(input.accessor, (db) =>
					failEmbeddingIndexBuild(db, error instanceof Error ? error.message : String(error)),
				);
			} catch (persistError) {
				logger.warn("embedding", "Failed to persist embedding migration failure", {
					error: persistError instanceof Error ? persistError.message : String(persistError),
				});
			}
			running = false;
		} finally {
			if (running) timer = setTimeout(scheduleTick, nextDelayMs);
		}
	};

	const scheduleTick = (): void => {
		const promise = tick();
		tickPromise = promise;
		void promise
			.catch((error: unknown) => {
				running = false;
				logger.warn("embedding", "Embedding migration tick failed", {
					error: error instanceof Error ? error.message : String(error),
				});
			})
			.finally(() => {
				if (tickPromise === promise) tickPromise = null;
			});
	};
	scheduleTick();

	return {
		async stop(): Promise<void> {
			running = false;
			if (timer) clearTimeout(timer);
			if (tickPromise) await tickPromise;
		},
		getStats: () => ({ running, staged, failed, coverage }),
	};
}
