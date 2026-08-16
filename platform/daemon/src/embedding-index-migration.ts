import { randomUUID } from "node:crypto";
import { type DbAccessor, DbWriteQueueFullError, type ReadDb, type WriteDb } from "./db-accessor";
import type { DbOwnerClient } from "./db-owner-client";
import { ownerBatch, ownerBytesFromHex, ownerReadAll, ownerReadOne, ownerRun } from "./db-owner-sql";
import { yieldEvery } from "./async-yield";
import { vectorToBlob } from "./db-helpers";
import type { EmbeddingFetchOptions } from "./embedding-fetch";
import {
	type EmbeddingIndexState,
	type PersistedEmbeddingProfile,
	readEmbeddingIndexState,
} from "./embedding-index-state";
import { beginEmbeddingIndexBuild, failEmbeddingIndexBuild } from "./embedding-index-state";
import { embeddingProfileFingerprint, recommendedEmbeddingProfileId, type EmbeddingRole } from "./embedding-profile";
import { logger } from "./logger";
import type { EmbeddingConfig } from "./memory-config";
import type { PipelineCauseFamily } from "./pipeline-operation";

const STAGING_VECTOR_TABLE = "vec_embeddings_staging";
const ACTIVE_VECTOR_TABLE = "vec_embeddings";
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

function vectorTableForSlot(slot: "active" | "staging" | undefined): "vec_embeddings" | "vec_embeddings_staging" {
	return slot === "staging" ? STAGING_VECTOR_TABLE : ACTIVE_VECTOR_TABLE;
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
export function resetStagingVectorIndex(db: WriteDb, dimensions: number, projectionSlot?: "active" | "staging"): void {
	const projectionTable = vectorTableForSlot(projectionSlot);
	db.exec(`DROP TABLE IF EXISTS ${projectionTable}`);
	createVectorIndex(db, projectionTable, dimensions);
}

function isDuplicateVectorProjectionRow(error: unknown): boolean {
	return error instanceof Error && /vec_embeddings.*primary key/i.test(error.message);
}

function ownerMaintenanceOptions(
	operation: string,
	estimatedWorkUnits?: number,
): {
	readonly operation: string;
	readonly lane: "maintenance";
	readonly deadlineMs: number;
	readonly estimatedWorkUnits?: number;
} {
	return {
		operation,
		lane: "maintenance",
		deadlineMs: 60_000,
		...(estimatedWorkUnits === undefined ? {} : { estimatedWorkUnits }),
	};
}

async function ownerReadState(owner: DbOwnerClient): Promise<EmbeddingIndexState | null> {
	const row = await ownerReadOne<{
		readonly active_profile_json: string;
		readonly staging_profile_json: string | null;
		readonly state: "ready" | "building" | "failed";
		readonly last_error: string | null;
	}>(
		owner,
		"SELECT active_profile_json, staging_profile_json, state, last_error FROM embedding_index_state WHERE id = 1",
		[],
		ownerMaintenanceOptions("embedding-index.state.read"),
	);
	if (row === null) return null;
	return readEmbeddingIndexStateFromRow(row);
}

function readEmbeddingIndexStateFromRow(row: {
	readonly active_profile_json: string;
	readonly staging_profile_json: string | null;
	readonly state: "ready" | "building" | "failed";
	readonly last_error: string | null;
}): ReturnType<typeof readEmbeddingIndexState> {
	try {
		const active = JSON.parse(row.active_profile_json) as PersistedEmbeddingProfile;
		const staging =
			row.staging_profile_json === null ? null : (JSON.parse(row.staging_profile_json) as PersistedEmbeddingProfile);
		return {
			active,
			staging: staging && staging.projectionSlot === undefined ? { ...staging, projectionSlot: "staging" } : staging,
			state: row.state,
			lastError: row.last_error,
		};
	} catch {
		return null;
	}
}

async function ownerTableExists(owner: DbOwnerClient, name: string): Promise<boolean> {
	return (
		((await ownerReadOne<{ readonly present: number }>(
			owner,
			"SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?",
			[name],
			ownerMaintenanceOptions("embedding-index.table-exists"),
		)) ?? null) !== null
	);
}

async function ownerIsVecVirtualTable(owner: DbOwnerClient, name: string): Promise<boolean> {
	const row = await ownerReadOne<{ readonly sql: string | null }>(
		owner,
		"SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
		[name],
		ownerMaintenanceOptions("embedding-index.table-kind"),
	);
	return typeof row?.sql === "string" && /^CREATE\s+VIRTUAL\s+TABLE/i.test(row.sql);
}

async function resetStagingVectorIndexThroughOwner(
	owner: DbOwnerClient,
	dimensions: number,
	projectionSlot?: "active" | "staging",
): Promise<void> {
	const table = vectorTableForSlot(projectionSlot);
	await ownerBatch(
		owner,
		[
			{ sql: `DROP TABLE IF EXISTS ${table}` },
			{
				sql: `CREATE VIRTUAL TABLE ${table} USING vec0(id TEXT PRIMARY KEY, embedding FLOAT[${assertDimensions(dimensions)}] distance_metric=cosine)`,
			},
		],
		ownerMaintenanceOptions("embedding-index.reset-projection"),
	);
}

async function rebuildVectorIndexThroughOwner(
	owner: DbOwnerClient,
	projectionSlot: "active" | "staging" | undefined,
	dimensions: number,
	batchSize = VECTOR_REBUILD_BATCH_SIZE,
	shouldContinue?: () => boolean,
): Promise<void> {
	const canCancel = shouldContinue !== undefined;
	const isRunning = shouldContinue ?? (() => true);
	const limit = Math.max(1, Math.min(50, Math.floor(batchSize)));
	const table = vectorTableForSlot(projectionSlot);
	let lastId: string | null = null;
	let initialized = false;
	let retries = 0;
	const yieldAfterChunk = yieldEvery(1);

	while (true) {
		if (!isRunning()) throw new Error("Embedding vector rebuild stopped");
		try {
			if (!initialized) {
				await resetStagingVectorIndexThroughOwner(owner, dimensions, projectionSlot);
				initialized = true;
			}
			const rows: readonly { readonly id: string; readonly vector_hex: string }[] = await ownerReadAll<{
				readonly id: string;
				readonly vector_hex: string;
			}>(
				owner,
				lastId === null
					? "SELECT id, hex(vector) AS vector_hex FROM embeddings ORDER BY id LIMIT ?"
					: "SELECT id, hex(vector) AS vector_hex FROM embeddings WHERE id > ? ORDER BY id LIMIT ?",
				lastId === null ? [limit] : [lastId, limit],
				ownerMaintenanceOptions("embedding-index.rebuild.read", limit),
			);
			if (rows.length === 0) return;
			const statements = rows.map((row) => ({
				sql: `INSERT INTO ${table} (id, embedding)
					SELECT ?, ?
					WHERE EXISTS (SELECT 1 FROM embeddings WHERE id = ?)
					AND NOT EXISTS (SELECT 1 FROM ${table} WHERE id = ?)`,
				params: [row.id, ownerBytesFromHex(row.vector_hex), row.id, row.id],
			}));
			await ownerBatch(owner, statements, {
				...ownerMaintenanceOptions("embedding-index.rebuild.write", rows.length),
				requireChanges: false,
			});
			lastId = rows[rows.length - 1]?.id ?? null;
			retries = 0;
			await yieldAfterChunk();
		} catch (error) {
			if (!isRunning()) throw error;
			if (!canCancel && retries >= MAX_VECTOR_REBUILD_RETRIES_WITHOUT_CANCELLATION) throw error;
			retries++;
			logger.warn("embedding", "Owner vector projection rebuild failed; retrying the current chunk", {
				error: error instanceof Error ? error.message : String(error),
				retry: retries,
			});
			await new Promise<void>((resolve) => setTimeout(resolve, VECTOR_REBUILD_RETRY_DELAY_MS));
		}
	}
}

/**
 * Rebuild the inactive sqlite-vec projection from durable BLOB rows in bounded
 * transactions. The projection is allowed to lag while active writers run, so
 * duplicate ids are intentionally ignored. A failed chunk keeps its keyset
 * cursor and retries until the caller stops the migration.
 */
async function rebuildVectorIndex(
	accessor: DbAccessor,
	projectionSlot: "active" | "staging" | undefined,
	dimensions: number,
	batchSize = VECTOR_REBUILD_BATCH_SIZE,
	shouldContinue?: () => boolean,
	owner?: DbOwnerClient,
): Promise<void> {
	if (owner) return rebuildVectorIndexThroughOwner(owner, projectionSlot, dimensions, batchSize, shouldContinue);
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
					const projectionTable = vectorTableForSlot(projectionSlot);
					db.exec(`DROP TABLE IF EXISTS ${projectionTable}`);
					createVectorIndex(db, projectionTable, dimensions);
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
				const projectionTable = vectorTableForSlot(projectionSlot);
				const insert = db.prepare(`INSERT OR IGNORE INTO ${projectionTable} (id, embedding) VALUES (?, ?)`);
				const existing = db.prepare(`SELECT 1 FROM ${projectionTable} WHERE id = ?`);
				const canonical = db.prepare("SELECT 1 FROM embeddings WHERE id = ?");
				for (const row of rows) {
					const vector = new Float32Array(
						row.vector.buffer,
						row.vector.byteOffset,
						row.vector.byteLength / Float32Array.BYTES_PER_ELEMENT,
					);
					if (vector.length !== dimensions)
						throw new Error(`Embedding ${row.id} has ${vector.length} dimensions, expected ${dimensions}`);
					// The read batch can outlive a concurrent purge. Re-check the
					// durable row in this write transaction before creating its
					// projection so a deleted embedding is never resurrected.
					if (canonical.get(row.id) == null || existing.get(row.id) != null) continue;
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

async function completeProjectionRebuild(
	accessor: DbAccessor,
	profile: PersistedEmbeddingProfile,
	batchSize?: number,
	shouldContinue?: () => boolean,
	owner?: DbOwnerClient,
): Promise<void> {
	await rebuildVectorIndex(accessor, profile.projectionSlot, profile.dimensions, batchSize, shouldContinue, owner);
	if (owner) {
		await ownerBatch(
			owner,
			[
				{
					sql: `UPDATE embedding_index_state
						SET active_profile_json = ?, staging_profile_json = NULL,
						    state = 'ready', last_error = NULL, updated_at = ?
						WHERE id = 1 AND state = 'building'`,
					params: [JSON.stringify({ ...profile, projectionRebuild: undefined }), new Date().toISOString()],
					requireChanges: true,
				},
				{
					sql: `UPDATE memories SET embedding_model = ? WHERE id IN (SELECT source_id FROM embeddings WHERE source_type = 'memory')`,
					params: [profile.model],
				},
			],
			ownerMaintenanceOptions("embedding-index.promote-complete"),
		);
		return;
	}
	const completed = await withQueuedWrite(accessor, (db) => {
		const state = readEmbeddingIndexState(db);
		if (
			state?.state !== "building" ||
			!state.staging?.projectionRebuild ||
			state.staging.fingerprint !== profile.fingerprint
		)
			return false;
		db.prepare(
			`UPDATE memories SET embedding_model = ?
			 WHERE id IN (SELECT source_id FROM embeddings WHERE source_type = 'memory')`,
		).run(profile.model);
		db.prepare(
			`UPDATE embedding_index_state
			 SET active_profile_json = ?, staging_profile_json = NULL,
			     state = 'ready', last_error = NULL, updated_at = ?
			 WHERE id = 1`,
		).run(JSON.stringify({ ...profile, projectionRebuild: undefined }), new Date().toISOString());
		return true;
	});
	if (!completed) throw new Error("Embedding vector rebuild state changed before completion");
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

async function ownerStagingCoverage(
	owner: DbOwnerClient,
	dimensions: number,
	targetFingerprint?: string,
): Promise<EmbeddingMigrationCoverage> {
	const active =
		(
			await ownerReadOne<{ readonly n: number }>(
				owner,
				"SELECT COUNT(*) AS n FROM embeddings",
				[],
				ownerMaintenanceOptions("embedding-index.coverage"),
			)
		)?.n ?? 0;
	const staged =
		(
			await ownerReadOne<{ readonly n: number }>(
				owner,
				"SELECT COUNT(*) AS n FROM embeddings_staging",
				[],
				ownerMaintenanceOptions("embedding-index.coverage"),
			)
		)?.n ?? 0;
	const missing =
		(
			await ownerReadOne<{ readonly n: number }>(
				owner,
				"SELECT COUNT(*) AS n FROM embeddings e LEFT JOIN embeddings_staging s ON s.content_hash = e.content_hash WHERE s.id IS NULL",
				[],
				ownerMaintenanceOptions("embedding-index.coverage"),
			)
		)?.n ?? 0;
	const wrongDimensions =
		(
			await ownerReadOne<{ readonly n: number }>(
				owner,
				"SELECT COUNT(*) AS n FROM embeddings_staging WHERE dimensions != ?",
				[dimensions],
				ownerMaintenanceOptions("embedding-index.coverage"),
			)
		)?.n ?? 0;
	let quarantined = 0;
	if (targetFingerprint !== undefined && (await ownerTableExists(owner, "embedding_index_failures"))) {
		quarantined =
			(
				await ownerReadOne<{ readonly n: number }>(
					owner,
					`SELECT COUNT(*) AS n FROM embedding_index_failures f
					 INNER JOIN embeddings e ON e.content_hash = f.content_hash
					 WHERE f.target_fingerprint = ? AND f.retry_policy = 'quarantined'`,
					[targetFingerprint],
					ownerMaintenanceOptions("embedding-index.coverage"),
				)
			)?.n ?? 0;
	}
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

async function pruneStagingRowsThroughOwner(owner: DbOwnerClient): Promise<void> {
	const state = await ownerReadState(owner);
	const table = vectorTableForSlot(state?.staging?.projectionSlot);
	await ownerBatch(
		owner,
		[
			{
				sql: `DELETE FROM ${table} WHERE id IN (SELECT s.id FROM embeddings_staging s LEFT JOIN embeddings e ON e.content_hash = s.content_hash WHERE e.id IS NULL)`,
			},
			{
				sql: "DELETE FROM embeddings_staging WHERE id IN (SELECT s.id FROM embeddings_staging s LEFT JOIN embeddings e ON e.content_hash = s.content_hash WHERE e.id IS NULL)",
			},
		],
		ownerMaintenanceOptions("embedding-index.prune-staging"),
	);
}

async function recordMigrationFailureThroughOwner(
	owner: DbOwnerClient,
	row: ActiveEmbeddingRow,
	profile: PersistedEmbeddingProfile,
	failureClass: "context_limit" | "invalid_input",
): Promise<void> {
	if (!(await ownerTableExists(owner, "embedding_index_failures"))) return;
	const now = new Date().toISOString();
	await ownerRun(
		owner,
		`INSERT INTO embedding_index_failures
			(content_hash, source_type, source_id, agent_id, target_fingerprint, provider, model,
			 failure_class, attempts, retry_policy, first_failed_at, last_failed_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 'quarantined', ?, ?)
			ON CONFLICT(content_hash, target_fingerprint) DO UPDATE SET
			 source_type = excluded.source_type, source_id = excluded.source_id, agent_id = excluded.agent_id,
			 provider = excluded.provider, model = excluded.model, failure_class = excluded.failure_class,
			 attempts = embedding_index_failures.attempts + 1, retry_policy = 'quarantined', last_failed_at = excluded.last_failed_at`,
		[
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
		],
		ownerMaintenanceOptions("embedding-index.record-failure"),
	);
}

async function stageEmbeddingBatchThroughOwner(input: {
	readonly owner: DbOwnerClient;
	readonly configured: EmbeddingConfig;
	readonly readConfigured?: () => EmbeddingConfig;
	readonly fetchEmbedding: (
		text: string,
		cfg: EmbeddingConfig,
		role?: EmbeddingRole,
		opts?: EmbeddingFetchOptions,
	) => Promise<number[] | null>;
	readonly batchSize: number;
}): Promise<{ staged: number; coverage: EmbeddingMigrationCoverage | null }> {
	const state = await ownerReadState(input.owner);
	if (state?.state !== "building" || !state.staging) return { staged: 0, coverage: null };
	const profile = state.staging;
	const vectorTable = vectorTableForSlot(profile.projectionSlot);
	const configured = input.readConfigured ? input.readConfigured() : input.configured;
	await pruneStagingRowsThroughOwner(input.owner);
	const hasFailures = await ownerTableExists(input.owner, "embedding_index_failures");
	const failureFilter = hasFailures
		? ` AND NOT EXISTS (SELECT 1 FROM embedding_index_failures f WHERE f.content_hash = e.content_hash AND f.target_fingerprint = ? AND f.retry_policy = 'quarantined')`
		: "";
	const rows = await ownerReadAll<ActiveEmbeddingRow>(
		input.owner,
		`SELECT e.content_hash, e.source_type, e.source_id, e.chunk_text, e.agent_id
		 FROM embeddings e LEFT JOIN embeddings_staging s ON s.content_hash = e.content_hash
		 WHERE (s.id IS NULL OR s.dimensions != ?)${failureFilter}
		 ORDER BY e.created_at ASC LIMIT ?`,
		hasFailures ? [profile.dimensions, profile.fingerprint, input.batchSize] : [profile.dimensions, input.batchSize],
		ownerMaintenanceOptions("embedding-index.stage.read", input.batchSize),
	);
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
			if (isTerminalMigrationFailure(failureCause))
				await recordMigrationFailureThroughOwner(input.owner, row, profile, failureCause);
			continue;
		}
		if (vector.length !== profile.dimensions)
			throw new Error(
				`Staging provider returned ${vector.length} dimensions for ${profile.model}; expected ${profile.dimensions}`,
			);
		const id = randomUUID();
		const results = await ownerBatch(
			input.owner,
			[
				{
					sql: `UPDATE embeddings_staging SET vector = ?, dimensions = ?, source_type = ?, source_id = ?, chunk_text = ?, created_at = datetime('now'), agent_id = ? WHERE content_hash = ? AND EXISTS (SELECT 1 FROM embeddings WHERE content_hash = ?)`,
					params: [
						vectorToBlob(vector),
						vector.length,
						row.source_type,
						row.source_id,
						row.chunk_text,
						row.agent_id,
						row.content_hash,
						row.content_hash,
					],
				},
				{
					sql: `INSERT INTO embeddings_staging (id, content_hash, vector, dimensions, source_type, source_id, chunk_text, created_at, agent_id)
					SELECT ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?
					WHERE EXISTS (SELECT 1 FROM embeddings WHERE content_hash = ?)
					AND NOT EXISTS (SELECT 1 FROM embeddings_staging WHERE content_hash = ?)`,
					params: [
						id,
						row.content_hash,
						vectorToBlob(vector),
						vector.length,
						row.source_type,
						row.source_id,
						row.chunk_text,
						row.agent_id,
						row.content_hash,
						row.content_hash,
					],
				},
				{
					sql: `INSERT INTO ${vectorTable} (id, embedding)
					SELECT id, ? FROM embeddings_staging
					WHERE content_hash = ? AND EXISTS (SELECT 1 FROM embeddings WHERE content_hash = ?)
					AND NOT EXISTS (SELECT 1 FROM ${vectorTable} WHERE id = embeddings_staging.id)`,
					params: [vectorToBlob(vector), row.content_hash, row.content_hash],
				},
			],
			ownerMaintenanceOptions("embedding-index.stage.write", 3),
		);
		if (results.some((result) => result.changes > 0)) staged++;
	}
	return { staged, coverage: await ownerStagingCoverage(input.owner, profile.dimensions, profile.fingerprint) };
}

/** Remove rows whose active source was deleted or changed while staging ran. */
async function pruneStagingRows(accessor: DbAccessor): Promise<void> {
	await withQueuedWrite(accessor, (db) => {
		const state = readEmbeddingIndexState(db);
		const vectorTable = vectorTableForSlot(state?.staging?.projectionSlot);
		const stale = db
			.prepare(
				`SELECT s.id FROM embeddings_staging s
				 LEFT JOIN embeddings e ON e.content_hash = s.content_hash
				 WHERE e.id IS NULL`,
			)
			.all() as Array<{ id: string }>;
		if (stale.length === 0) return;
		const deleteVector = db.prepare(`DELETE FROM ${vectorTable} WHERE id = ?`);
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
	readonly owner?: DbOwnerClient;
}): Promise<{ staged: number; coverage: EmbeddingMigrationCoverage | null }> {
	if (input.owner) return stageEmbeddingBatchThroughOwner({ ...input, owner: input.owner });
	const state = await input.accessor.withReadDbAsync(async (db) => readEmbeddingIndexState(db));
	if (state?.state !== "building" || !state.staging) return { staged: 0, coverage: null };
	const profile = state.staging;
	const vectorTable = vectorTableForSlot(profile.projectionSlot);
	const configured = input.readConfigured ? input.readConfigured() : input.configured;
	// Writes and source purges continue against the active slot during a build.
	// Without this cleanup, an obsolete staging row would keep the count-based
	// readiness gate false forever after its active counterpart disappears.
	await pruneStagingRows(input.accessor);
	const rows = await input.accessor.withReadDbAsync(async (db) => {
		if (!tableExists(db, vectorTable)) throw new Error("Staging vector index is unavailable");
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
				db.prepare(`INSERT OR REPLACE INTO ${vectorTable} (id, embedding) VALUES (?, ?)`).run(
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

async function promoteStagingIndexThroughOwner(
	accessor: DbAccessor,
	owner: DbOwnerClient,
	options?: { readonly vectorBatchSize?: number; readonly shouldContinue?: () => boolean },
): Promise<boolean> {
	const state = await ownerReadState(owner);
	if (state?.state !== "building" || !state.staging || state.staging.projectionRebuild) return false;
	if (!(await ownerStagingCoverage(owner, state.staging.dimensions, state.staging.fingerprint)).ready) return false;
	const stagingVectorTable = vectorTableForSlot(state.staging.projectionSlot);
	const activeVectorTable = vectorTableForSlot(state.active.projectionSlot);
	if (!(await ownerTableExists(owner, stagingVectorTable))) return false;
	const rebuildVectorIndex =
		(await ownerIsVecVirtualTable(owner, activeVectorTable)) &&
		(await ownerIsVecVirtualTable(owner, stagingVectorTable));
	const nextProfile = { ...state.staging, projectionRebuild: true } as const;
	const statements: Array<{
		readonly sql: string;
		readonly params?: readonly unknown[];
		readonly requireChanges?: boolean;
	}> = [
		{
			sql: `UPDATE embedding_index_state SET staging_profile_json = ?, state = 'building', last_error = NULL, updated_at = ? WHERE id = 1 AND state = 'building' AND staging_profile_json = ?`,
			params: [JSON.stringify(nextProfile), new Date().toISOString(), JSON.stringify(state.staging)],
			requireChanges: true,
		},
		{ sql: "ALTER TABLE embeddings_staging RENAME TO embeddings_next" },
		{ sql: "ALTER TABLE embeddings RENAME TO embeddings_staging" },
		{ sql: "ALTER TABLE embeddings_next RENAME TO embeddings" },
	];
	if (rebuildVectorIndex) {
		// The old projection remains paired with embeddings_staging until the
		// owner publishes the rebuilt projection in completeProjectionRebuild.
	} else {
		statements.push(
			{
				sql: `UPDATE memories SET embedding_model = ? WHERE id IN (SELECT source_id FROM embeddings WHERE source_type = 'memory')`,
				params: [state.staging.model],
			},
			{ sql: `ALTER TABLE ${stagingVectorTable} RENAME TO vec_embeddings_next` },
			{ sql: `ALTER TABLE ${activeVectorTable} RENAME TO vec_embeddings_old` },
			{ sql: "ALTER TABLE vec_embeddings_next RENAME TO vec_embeddings" },
			{ sql: "ALTER TABLE vec_embeddings_old RENAME TO vec_embeddings_staging" },
			{
				sql: `UPDATE embedding_index_state SET active_profile_json = ?, staging_profile_json = NULL, state = 'ready', last_error = NULL, updated_at = ? WHERE id = 1 AND state = 'building'`,
				params: [JSON.stringify({ ...state.staging, projectionSlot: "active" }), new Date().toISOString()],
			},
		);
	}
	await ownerBatch(owner, statements, ownerMaintenanceOptions("embedding-index.promote", statements.length));
	if (rebuildVectorIndex) {
		await completeProjectionRebuild(accessor, nextProfile, options?.vectorBatchSize, options?.shouldContinue, owner);
	}
	await ownerRun(owner, "PRAGMA incremental_vacuum", [], ownerMaintenanceOptions("embedding-index.incremental-vacuum"));
	return true;
}

async function beginEmbeddingIndexBuildThroughOwner(
	owner: DbOwnerClient,
	cfg: EmbeddingConfig,
): Promise<EmbeddingIndexState> {
	const current = await ownerReadState(owner);
	if (current === null) throw new Error("Embedding index state is unavailable in DB owner");
	const stagingConfig: EmbeddingConfig = { ...cfg, profile: recommendedEmbeddingProfileId(cfg) };
	const staging = {
		...profileForStorageForOwner(stagingConfig),
		projectionSlot: current.active.projectionSlot === "staging" ? ("active" as const) : ("staging" as const),
	};
	if (current.state === "building" && current.staging?.fingerprint === staging.fingerprint) return current;
	if (current.active.fingerprint === staging.fingerprint) {
		if (current.state !== "building") return current;
		await ownerBatch(
			owner,
			[
				{ sql: "DELETE FROM embeddings_staging" },
				{
					sql: "UPDATE embedding_index_state SET staging_profile_json = NULL, state = 'ready', last_error = NULL, updated_at = ? WHERE id = 1 AND state = 'building'",
					params: [new Date().toISOString()],
					requireChanges: true,
				},
			],
			ownerMaintenanceOptions("embedding-index.abandon"),
		);
		return { active: current.active, staging: null, state: "ready", lastError: null };
	}
	await ownerBatch(
		owner,
		[
			{ sql: "DELETE FROM embeddings_staging" },
			{
				sql: "UPDATE embedding_index_state SET staging_profile_json = ?, state = 'building', last_error = NULL, updated_at = ? WHERE id = 1",
				params: [JSON.stringify(staging), new Date().toISOString()],
				requireChanges: true,
			},
		],
		ownerMaintenanceOptions("embedding-index.begin"),
	);
	return { active: current.active, staging, state: "building", lastError: null };
}

function profileForStorageForOwner(cfg: EmbeddingConfig): PersistedEmbeddingProfile {
	return {
		fingerprint: embeddingProfileFingerprintForOwner(cfg),
		provider: cfg.provider,
		model: cfg.model,
		dimensions: assertDimensions(cfg.dimensions),
		baseUrl: cfg.base_url,
		...(cfg.profile ? { profile: cfg.profile } : {}),
	};
}

function embeddingProfileFingerprintForOwner(cfg: EmbeddingConfig): string {
	return embeddingProfileFingerprint(cfg);
}

/**
 * Promotion swaps durable embedding slots in one short transaction. A virtual
 * sqlite-vec projection is rebuilt in the inactive projection slot after that
 * transaction in bounded chunks, while search keeps serving the old slot.
 */
export async function promoteStagingIndex(
	accessor: DbAccessor,
	options?: {
		readonly vectorBatchSize?: number;
		readonly shouldContinue?: () => boolean;
		readonly owner?: DbOwnerClient;
	},
): Promise<boolean> {
	if (options?.owner) return promoteStagingIndexThroughOwner(accessor, options.owner, options);
	const plan = await withQueuedWrite(accessor, (db) => {
		const state = readEmbeddingIndexState(db);
		if (state?.state !== "building" || !state.staging) return null;
		if (state.staging.projectionRebuild) return null;
		if (!stagingCoverage(db, state.staging.dimensions, state.staging.fingerprint).ready) return null;
		if (!tableExists(db, vectorTableForSlot(state.staging.projectionSlot))) return null;
		let rebuildVectorIndex = false;
		const nextProfile = { ...state.staging, projectionRebuild: true } as const;
		const stagingVectorTable = vectorTableForSlot(state.staging.projectionSlot);
		const activeVectorTable = vectorTableForSlot(state.active.projectionSlot);

		// Keep exactly two durable slots: after the swap the former active slot
		// becomes the inactive/rollback slot, ready to be cleared for the next build.
		db.exec("ALTER TABLE embeddings_staging RENAME TO embeddings_next");
		db.exec("ALTER TABLE embeddings RENAME TO embeddings_staging");
		db.exec("ALTER TABLE embeddings_next RENAME TO embeddings");
		// Keep the old projection in place while the new projection is rebuilt in
		// the inactive table. Search pairs this old projection with the old durable
		// slot until the final state transaction publishes the new projection.
		if (isVecVirtualTable(db, activeVectorTable) && isVecVirtualTable(db, stagingVectorTable)) {
			rebuildVectorIndex = true;
			db.prepare(
				`UPDATE embedding_index_state
				 SET staging_profile_json = ?, state = 'building', last_error = NULL, updated_at = ?
				 WHERE id = 1`,
			).run(JSON.stringify(nextProfile), new Date().toISOString());
		} else {
			db.prepare(
				`UPDATE memories SET embedding_model = ?
				 WHERE id IN (SELECT source_id FROM embeddings WHERE source_type = 'memory')`,
			).run(state.staging.model);
			db.exec(`ALTER TABLE ${stagingVectorTable} RENAME TO vec_embeddings_next`);
			db.exec(`ALTER TABLE ${activeVectorTable} RENAME TO vec_embeddings_old`);
			db.exec("ALTER TABLE vec_embeddings_next RENAME TO vec_embeddings");
			db.exec("ALTER TABLE vec_embeddings_old RENAME TO vec_embeddings_staging");
			db.prepare(
				`UPDATE embedding_index_state
				 SET active_profile_json = ?, staging_profile_json = NULL,
				     state = 'ready', last_error = NULL, updated_at = ?
				 WHERE id = 1`,
			).run(JSON.stringify({ ...state.staging, projectionSlot: "active" }), new Date().toISOString());
		}
		return { dimensions: state.staging.dimensions, profile: nextProfile, rebuildVectorIndex };
	});
	if (plan === null) return false;
	if (plan.rebuildVectorIndex) {
		await completeProjectionRebuild(accessor, plan.profile, options?.vectorBatchSize, options?.shouldContinue);
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
	/** The only SQL execution path for production embedding maintenance. */
	readonly owner?: DbOwnerClient;
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

	const before = input.owner
		? await ownerReadState(input.owner)
		: await input.accessor.withReadDbAsync(async (db) => readEmbeddingIndexState(db));
	const initial = input.owner
		? await beginEmbeddingIndexBuildThroughOwner(input.owner, input.configured)
		: await withQueuedWrite(input.accessor, (db) => beginEmbeddingIndexBuild(db, input.configured));
	const staging = initial.staging;
	if (initial.state !== "building" || !staging) return null;
	if (staging.projectionRebuild) {
		try {
			await completeProjectionRebuild(input.accessor, staging, undefined, undefined, input.owner);
			if (input.owner)
				await ownerRun(
					input.owner,
					"PRAGMA incremental_vacuum",
					[],
					ownerMaintenanceOptions("embedding-index.incremental-vacuum"),
				);
			else if (input.accessor.incrementalVacuumAsync) await input.accessor.incrementalVacuumAsync();
			input.onPromoted?.();
		} catch (error) {
			logger.warn("embedding", "Interrupted vector projection rebuild remains queued for retry", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
		return null;
	}
	const resumeExistingBuild = before?.state === "building" && before.staging?.fingerprint === staging.fingerprint;
	try {
		if (resumeExistingBuild) {
			const hasStagingVectorIndex = input.owner
				? await ownerTableExists(input.owner, vectorTableForSlot(staging.projectionSlot))
				: await input.accessor.withReadDbAsync(async (db) =>
						tableExists(db, vectorTableForSlot(staging.projectionSlot)),
					);
			if (!hasStagingVectorIndex) throw new Error("Staging vector index is unavailable while resuming a build");
		} else {
			if (input.owner)
				await resetStagingVectorIndexThroughOwner(input.owner, staging.dimensions, staging.projectionSlot);
			else
				await withQueuedWrite(input.accessor, (db) =>
					resetStagingVectorIndex(db, staging.dimensions, staging.projectionSlot),
				);
		}
	} catch (error) {
		if (input.owner)
			await ownerRun(
				input.owner,
				"UPDATE embedding_index_state SET state = 'failed', last_error = ?, updated_at = ? WHERE id = 1",
				[error instanceof Error ? error.message : String(error), new Date().toISOString()],
				ownerMaintenanceOptions("embedding-index.fail"),
			);
		else
			await withQueuedWrite(input.accessor, (db) =>
				failEmbeddingIndexBuild(db, error instanceof Error ? error.message : String(error)),
			);
		return null;
	}

	const tick = async (): Promise<void> => {
		if (!running) return;
		nextDelayMs = input.pollMs;
		try {
			const state = input.owner
				? await ownerReadState(input.owner)
				: await input.accessor.withReadDbAsync(async (db) => readEmbeddingIndexState(db));
			if (state?.state !== "building" || !state.staging) return;
			if (state.staging.projectionRebuild) {
				try {
					await completeProjectionRebuild(input.accessor, state.staging, undefined, () => running, input.owner);
					if (input.owner)
						await ownerRun(
							input.owner,
							"PRAGMA incremental_vacuum",
							[],
							ownerMaintenanceOptions("embedding-index.incremental-vacuum"),
						);
					else if (input.accessor.incrementalVacuumAsync) await input.accessor.incrementalVacuumAsync();
					running = false;
					input.onPromoted?.();
				} catch (error) {
					logger.warn("embedding", "Interrupted vector projection rebuild remains queued for retry", {
						error: error instanceof Error ? error.message : String(error),
					});
				}
				return;
			}
			// The persisted staging profile can go stale when agent.yaml

			// changes mid-build; the migration then spins failing the old
			// provider forever (#1160). Re-begin against the LIVE config (re-read
			// from disk each tick): a no-op when nothing changed, a restart when
			// the config did.
			const configured = input.readConfigured ? input.readConfigured() : input.configured;
			const restarted = input.owner
				? await beginEmbeddingIndexBuildThroughOwner(input.owner, configured)
				: await withQueuedWrite(input.accessor, (db) => beginEmbeddingIndexBuild(db, configured));
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
				if (input.owner)
					await resetStagingVectorIndexThroughOwner(
						input.owner,
						currentStaging.dimensions,
						currentStaging.projectionSlot,
					);
				else
					await withQueuedWrite(input.accessor, (db) =>
						resetStagingVectorIndex(db, currentStaging.dimensions, currentStaging.projectionSlot),
					);
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
			const result = await stageEmbeddingBatch({ ...input, owner: input.owner });
			staged += result.staged;
			coverage = result.coverage;
			if (
				coverage?.ready &&
				(await promoteStagingIndex(input.accessor, { shouldContinue: () => running, owner: input.owner }))
			) {
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
			const owner = input.owner;
			const pendingProjection = owner
				? await (async () => {
						const current = await ownerReadState(owner);
						return current?.state === "building" && current.staging?.projectionRebuild === true;
					})()
				: await input.accessor.withReadDbAsync(async (db) => {
						const current = readEmbeddingIndexState(db);
						return current?.state === "building" && current.staging?.projectionRebuild === true;
					});
			if (pendingProjection) {
				logger.warn("embedding", "Vector projection rebuild remains queued for retry", {
					error: error instanceof Error ? error.message : String(error),
				});
				return;
			}
			consecutiveFailures++;
			failed++;
			try {
				if (input.owner)
					await ownerRun(
						input.owner,
						"UPDATE embedding_index_state SET state = 'failed', last_error = ?, updated_at = ? WHERE id = 1",
						[error instanceof Error ? error.message : String(error), new Date().toISOString()],
						ownerMaintenanceOptions("embedding-index.fail"),
					);
				else
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
