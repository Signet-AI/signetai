import type { DbAccessor, WriteDb } from "../db-accessor";
import type { DbOwnerMaintenance } from "../db-owner-maintenance";

async function writeTx<T>(accessor: DbAccessor, fn: (db: WriteDb) => T): Promise<T> {
	const writer = accessor.withWriteTxAsync;
	if (!writer) throw new Error("async write API is unavailable");
	return writer(fn);
}
interface MemoryRow {
	readonly id: unknown;
	readonly type: unknown;
	readonly category: unknown;
	readonly content: unknown;
	readonly confidence: unknown;
	readonly importance: unknown;
	readonly source_id: unknown;
	readonly source_type: unknown;
	readonly tags: unknown;
	readonly who: unknown;
	readonly why: unknown;
	readonly project: unknown;
	readonly content_hash: unknown;
	readonly normalized_content: unknown;
	readonly extraction_status: unknown;
	readonly embedding_model: unknown;
	readonly extraction_model: unknown;
	readonly update_count: unknown;
	readonly created_at: unknown;
	readonly agent_id: unknown;
	readonly [key: string]: unknown;
}
import { countChanges, syncVecDeleteByEmbeddingIds } from "../db-helpers";
import { logger } from "../logger";
import { isSystemPressureHigh } from "../system-pressure";
import { txDecrementEntityMentions } from "./graph-transactions";
import { invalidateTraversalCache } from "./graph-traversal";
import { runWriteBatches } from "../yielding-writes";

export interface RetentionConfig {
	readonly intervalMs: number;
	readonly tombstoneRetentionMs: number;
	readonly historyRetentionMs: number;
	readonly completedJobRetentionMs: number;
	readonly deadJobRetentionMs: number;
	readonly batchLimit: number;
}

export const DEFAULT_RETENTION: RetentionConfig = {
	intervalMs: 6 * 60 * 60 * 1000,
	tombstoneRetentionMs: 30 * 24 * 60 * 60 * 1000,
	historyRetentionMs: 180 * 24 * 60 * 60 * 1000,
	completedJobRetentionMs: 14 * 24 * 60 * 60 * 1000,
	deadJobRetentionMs: 30 * 24 * 60 * 60 * 1000,
	batchLimit: 500,
};

export interface RetentionHandle {
	stop(): void;
	readonly running: boolean;
	sweep(): Promise<RetentionSweepResult>;
}

export interface RetentionSweepResult {
	graphLinksPurged: number;
	entitiesOrphaned: number;
	embeddingsPurged: number;
	tombstonesPurged: number;
	historyPurged: number;
	completedJobsPurged: number;
	deadJobsPurged: number;
	completedTranscriptCaptureJobsPurged: number;
	deadTranscriptCaptureJobsPurged: number;
}

const EMPTY_RETENTION_RESULT: RetentionSweepResult = {
	graphLinksPurged: 0,
	entitiesOrphaned: 0,
	embeddingsPurged: 0,
	tombstonesPurged: 0,
	historyPurged: 0,
	completedJobsPurged: 0,
	deadJobsPurged: 0,
	completedTranscriptCaptureJobsPurged: 0,
	deadTranscriptCaptureJobsPurged: 0,
};

function purgeGraphLinks(
	db: WriteDb,
	cutoff: string,
	limit: number,
): { mentionsPurged: number; entitiesOrphaned: number } {
	const expiredIds = db
		.prepare(
			`SELECT id FROM memories
			 WHERE is_deleted = 1 AND deleted_at IS NOT NULL AND deleted_at < ?
			 LIMIT ?`,
		)
		.all(cutoff, limit) as Array<{ id: string }>;

	if (expiredIds.length === 0) return { mentionsPurged: 0, entitiesOrphaned: 0 };

	const placeholders = expiredIds.map(() => "?").join(", ");
	const ids = expiredIds.map((r) => r.id);
	const affectedEntities = db
		.prepare(
			`SELECT DISTINCT entity_id FROM memory_entity_mentions
			 WHERE memory_id IN (${placeholders})`,
		)
		.all(...ids) as Array<{ entity_id: string }>;

	const result = db
		.prepare(
			`DELETE FROM memory_entity_mentions
			 WHERE memory_id IN (${placeholders})`,
		)
		.run(...ids);
	const mentionsPurged = countChanges(result);
	const entityIds = affectedEntities.map((r) => r.entity_id);
	const { entitiesOrphaned } = txDecrementEntityMentions(db, { entityIds });

	return { mentionsPurged, entitiesOrphaned };
}

function purgeEmbeddings(db: WriteDb, cutoff: string, limit: number): number {
	const expiredIds = db
		.prepare(
			`SELECT id FROM memories
			 WHERE is_deleted = 1 AND deleted_at IS NOT NULL AND deleted_at < ?
			 LIMIT ?`,
		)
		.all(cutoff, limit) as Array<{ id: string }>;

	if (expiredIds.length === 0) return 0;

	const placeholders = expiredIds.map(() => "?").join(", ");
	const ids = expiredIds.map((r) => r.id);
	const embRows = db
		.prepare(
			`SELECT id FROM embeddings
			 WHERE source_type = 'memory' AND source_id IN (${placeholders})`,
		)
		.all(...ids) as Array<{ id: string }>;
	const vectorsDeleted = syncVecDeleteByEmbeddingIds(
		db,
		embRows.map((r) => r.id),
	);
	if (!vectorsDeleted) {
		throw new Error("failed to reconcile vec_embeddings before retention purge");
	}

	const result = db
		.prepare(
			`DELETE FROM embeddings
			 WHERE source_type = 'memory' AND source_id IN (${placeholders})`,
		)
		.run(...ids);
	return countChanges(result);
}
export function archiveToCold(
	db: WriteDb,
	memoryIds: ReadonlyArray<string>,
	reason: string,
	coldSourceId?: string,
): void {
	if (memoryIds.length === 0) return;
	const tableExists = db
		.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memories_cold'`)
		.get();
	if (!tableExists) {
		logger.warn("retention", "memories_cold table missing — skipping archival (run migrations)", {
			count: memoryIds.length,
		});
		return;
	}

	const placeholders = memoryIds.map(() => "?").join(", ");
	const now = new Date().toISOString();
	const rows = db.prepare(`SELECT * FROM memories WHERE id IN (${placeholders})`).all(...memoryIds) as MemoryRow[];
	const stmt = db.prepare(`
		INSERT INTO memories_cold (
			archive_id, memory_id, type, category, content, confidence, importance,
			source_id, source_type, tags, who, why, project,
			content_hash, normalized_content, extraction_status,
			embedding_model, extraction_model, update_count,
			original_created_at, archived_at, archived_reason,
			cold_source_id, agent_id, original_row_json
		)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`);

	for (const row of rows) {
		stmt.run(
			crypto.randomUUID(),
			row.id,
			row.type,
			row.category,
			row.content,
			row.confidence,
			row.importance,
			row.source_id,
			row.source_type,
			row.tags,
			row.who,
			row.why,
			row.project,
			row.content_hash,
			row.normalized_content,
			row.extraction_status,
			row.embedding_model,
			row.extraction_model,
			row.update_count,
			row.created_at,
			now,
			reason,
			coldSourceId ?? null,
			typeof row.agent_id === "string" ? row.agent_id : "default",
			JSON.stringify(row),
		);
	}
}

function purgeTombstones(db: WriteDb, cutoff: string, limit: number): number {
	const expiredIds = db
		.prepare(
			`SELECT id FROM memories
			 WHERE is_deleted = 1 AND deleted_at IS NOT NULL AND deleted_at < ?
			 LIMIT ?`,
		)
		.all(cutoff, limit) as Array<{ id: string }>;

	if (expiredIds.length === 0) return 0;

	const placeholders = expiredIds.map(() => "?").join(", ");
	const ids = expiredIds.map((r) => r.id);
	archiveToCold(db, ids, "retention_decay");
	db.prepare(`DELETE FROM memories WHERE id IN (${placeholders})`).run(...ids);

	return expiredIds.length;
}
function purgeExpiredRows(
	db: WriteDb,
	table: string,
	where: string,
	cutoff: string,
	limit: number,
	allowMissingTable = false,
): number {
	try {
		const deleted = db
			.prepare(
				`DELETE FROM ${table}
				 WHERE id IN (SELECT id FROM ${table} WHERE ${where} LIMIT ?)
				 RETURNING id`,
			)
			.all(cutoff, limit) as Array<{ id: string }>;
		return deleted.length;
	} catch (error) {
		if (allowMissingTable && error instanceof Error && error.message.includes("no such table")) return 0;
		throw error;
	}
}

function clampNumber(value: number, fallback: number, min: number, max: number): number {
	if (!Number.isFinite(value)) return fallback;
	return Math.max(min, Math.min(max, Math.trunc(value)));
}

function normalizeRetentionConfig(cfg: RetentionConfig): RetentionConfig {
	return {
		intervalMs: clampNumber(cfg.intervalMs, DEFAULT_RETENTION.intervalMs, 60_000, 7 * 24 * 60 * 60 * 1000),
		tombstoneRetentionMs: clampNumber(
			cfg.tombstoneRetentionMs,
			DEFAULT_RETENTION.tombstoneRetentionMs,
			0,
			3650 * 24 * 60 * 60 * 1000,
		),
		historyRetentionMs: clampNumber(
			cfg.historyRetentionMs,
			DEFAULT_RETENTION.historyRetentionMs,
			0,
			3650 * 24 * 60 * 60 * 1000,
		),
		completedJobRetentionMs: clampNumber(
			cfg.completedJobRetentionMs,
			DEFAULT_RETENTION.completedJobRetentionMs,
			0,
			3650 * 24 * 60 * 60 * 1000,
		),
		deadJobRetentionMs: clampNumber(
			cfg.deadJobRetentionMs,
			DEFAULT_RETENTION.deadJobRetentionMs,
			0,
			3650 * 24 * 60 * 60 * 1000,
		),
		batchLimit: clampNumber(cfg.batchLimit, DEFAULT_RETENTION.batchLimit, 1, 10_000),
	};
}

export async function runRetentionSweepOnce(
	accessor: DbAccessor,
	cfg: RetentionConfig = DEFAULT_RETENTION,
	ownerMaintenance?: DbOwnerMaintenance,
): Promise<RetentionSweepResult> {
	if (ownerMaintenance && !(await ownerMaintenance.queueIsHealthy())) return EMPTY_RETENTION_RESULT;
	const normalizedCfg = normalizeRetentionConfig(cfg);
	const now = Date.now();
	const tombstoneCutoff = new Date(now - normalizedCfg.tombstoneRetentionMs).toISOString();
	const historyCutoff = new Date(now - normalizedCfg.historyRetentionMs).toISOString();
	const completedJobCutoff = new Date(now - normalizedCfg.completedJobRetentionMs).toISOString();
	const deadJobCutoff = new Date(now - normalizedCfg.deadJobRetentionMs).toISOString();
	const retentionResult = await writeTx(accessor, (db) => {
		const graph = purgeGraphLinks(db, tombstoneCutoff, normalizedCfg.batchLimit);
		const embeddingsPurged = purgeEmbeddings(db, tombstoneCutoff, normalizedCfg.batchLimit);
		const tombstonesPurged = purgeTombstones(db, tombstoneCutoff, normalizedCfg.batchLimit);
		return { ...graph, embeddingsPurged, tombstonesPurged };
	});
	const graphLinksPurged = retentionResult.mentionsPurged;
	const entitiesOrphaned = retentionResult.entitiesOrphaned;
	const embeddingsPurged = retentionResult.embeddingsPurged;
	const tombstonesPurged = retentionResult.tombstonesPurged;

	if (entitiesOrphaned > 0) invalidateTraversalCache();
	const steps = [
		{ table: "memory_history", where: "created_at < ?", cutoff: historyCutoff, allowMissingTable: false },
		{
			table: "memory_jobs",
			where: "status = 'completed' AND completed_at IS NOT NULL AND completed_at < ?",
			cutoff: completedJobCutoff,
			allowMissingTable: false,
		},
		{
			table: "memory_jobs",
			where: "status = 'dead' AND failed_at IS NOT NULL AND failed_at < ?",
			cutoff: deadJobCutoff,
			allowMissingTable: false,
		},
		{
			table: "transcript_capture_jobs",
			where: "status = 'completed' AND completed_at IS NOT NULL AND completed_at < ?",
			cutoff: completedJobCutoff,
			allowMissingTable: true,
		},
		{
			table: "transcript_capture_jobs",
			where: "status = 'dead' AND updated_at IS NOT NULL AND updated_at < ?",
			cutoff: deadJobCutoff,
			allowMissingTable: true,
		},
	] as const;
	const postRetention = await runWriteBatches(
		accessor,
		steps,
		(db, step) =>
			purgeExpiredRows(db, step.table, step.where, step.cutoff, normalizedCfg.batchLimit, step.allowMissingTable),
		{ label: "retention sweep", maxPerTx: 1 },
	);
	if (postRetention.error) throw new Error(postRetention.error);
	const [
		historyPurged,
		completedJobsPurged,
		deadJobsPurged,
		completedTranscriptCaptureJobsPurged,
		deadTranscriptCaptureJobsPurged,
	] = postRetention.items;

	return {
		graphLinksPurged,
		entitiesOrphaned,
		embeddingsPurged,
		tombstonesPurged,
		historyPurged,
		completedJobsPurged,
		deadJobsPurged,
		completedTranscriptCaptureJobsPurged,
		deadTranscriptCaptureJobsPurged,
	};
}

export function startRetentionWorker(
	accessor: DbAccessor,
	cfg: RetentionConfig = DEFAULT_RETENTION,
	ownerMaintenance?: DbOwnerMaintenance,
): RetentionHandle {
	const normalizedCfg = normalizeRetentionConfig(cfg);
	let running = true;
	let timer: ReturnType<typeof setTimeout> | null = null;

	async function doSweep(): Promise<RetentionSweepResult> {
		const result = await runRetentionSweepOnce(accessor, normalizedCfg, ownerMaintenance);
		const total =
			result.graphLinksPurged +
			result.entitiesOrphaned +
			result.embeddingsPurged +
			result.tombstonesPurged +
			result.historyPurged +
			result.completedJobsPurged +
			result.deadJobsPurged +
			result.completedTranscriptCaptureJobsPurged +
			result.deadTranscriptCaptureJobsPurged;

		if (total > 0) {
			logger.info("retention", "Sweep completed", { ...result });
		}
		return result;
	}

	async function runScheduledSweep(): Promise<void> {
		if (running && !isSystemPressureHigh()) {
			await doSweep().catch((e) => {
				logger.warn("retention", "Sweep error", {
					error: e instanceof Error ? e.message : String(e),
				});
			});
		}
		if (running) timer = setTimeout(runScheduledSweep, normalizedCfg.intervalMs);
	}
	timer = setTimeout(runScheduledSweep, 60_000);

	logger.info("retention", "Worker started", {
		intervalMs: normalizedCfg.intervalMs,
		tombstoneDays: Math.round(normalizedCfg.tombstoneRetentionMs / 86400000),
		historyDays: Math.round(normalizedCfg.historyRetentionMs / 86400000),
	});

	return {
		get running() {
			return running;
		},
		stop() {
			running = false;
			if (timer !== null) {
				clearTimeout(timer);
				timer = null;
			}
			logger.info("retention", "Worker stopped");
		},
		sweep: doSweep,
	};
}
