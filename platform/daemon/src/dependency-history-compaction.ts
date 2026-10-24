import type { DbOwnerClient } from "./db-owner-client";
import { ownerChanges, ownerTransaction } from "./db-owner-maintenance";
import { logger } from "./logger";
import { isSystemPressureHigh } from "./system-pressure";

export interface DependencyHistoryCompactionBatch {
	readonly pruned: number;
	readonly cursor: number;
	readonly lastRowid: number;
	readonly caughtUp: boolean;
}

export interface DependencyHistoryCompactionCycle {
	readonly batches: number;
	readonly pruned: number;
	readonly cursor: number;
	readonly lastRowid: number;
	readonly caughtUp: boolean;
}

export interface DependencyHistoryCompactionOptions {
	readonly windowRows?: number;
	readonly maxBatchesPerCycle?: number;
	readonly batchDeadlineMs?: number;
	readonly yieldMs?: number;
	readonly continueDelayMs?: number;
	readonly idleIntervalMs?: number;
	readonly errorDelayMs?: number;
	readonly startDelayMs?: number;
	readonly queueIsHealthy?: () => Promise<boolean>;
}

export interface DependencyHistoryCompactionHandle {
	readonly running: boolean;
	runCycle(): Promise<DependencyHistoryCompactionCycle>;
	stop(): Promise<void>;
}

const PRUNE_IDENTICAL_REBUILD_PAIRS_SQL = `
	WITH pairs AS MATERIALIZED (
		SELECT d.rowid AS deleted_rowid, c.rowid AS created_rowid
		FROM entity_dependency_history d
		JOIN entity_dependency_history c ON c.rowid = (
			SELECT MIN(n.rowid) FROM entity_dependency_history n
			WHERE n.dependency_id = d.dependency_id AND n.rowid > d.rowid
		)
		WHERE d.rowid > (SELECT cursor_rowid FROM dependency_history_compaction_state WHERE id = 1)
		  AND d.rowid <= (SELECT cursor_rowid FROM dependency_history_compaction_state WHERE id = 1) + ?
		  AND d.event = 'deleted'
		  AND c.event = 'created'
		  AND d.changed_by = 'db-trigger'
		  AND c.changed_by = 'db-trigger'
		  AND c.source_entity_id = d.source_entity_id
		  AND c.target_entity_id = d.target_entity_id
		  AND c.agent_id = d.agent_id
		  AND c.dependency_type = d.dependency_type
		  AND c.reason = d.reason
		  AND c.created_at = d.created_at
	)
	DELETE FROM entity_dependency_history
	WHERE rowid IN (SELECT deleted_rowid FROM pairs UNION ALL SELECT created_rowid FROM pairs)`;

const ADVANCE_CURSOR_SQL = `
	UPDATE dependency_history_compaction_state
	SET cursor_rowid = MIN(cursor_rowid + ?, COALESCE((SELECT MAX(rowid) FROM entity_dependency_history), 0)),
	    pruned_rows = pruned_rows + changes(),
	    updated_at = datetime('now')
	WHERE id = 1`;

const READ_PROGRESS_SQL = `
	SELECT cursor_rowid AS cursor,
	       COALESCE((SELECT MAX(rowid) FROM entity_dependency_history), 0) AS lastRowid
	FROM dependency_history_compaction_state
	WHERE id = 1`;

function bounded(value: number | undefined, fallback: number, min: number, max: number): number {
	if (value === undefined || !Number.isFinite(value)) return fallback;
	return Math.max(min, Math.min(max, Math.trunc(value)));
}

export async function compactDependencyHistoryBatch(
	owner: DbOwnerClient,
	options: { readonly windowRows?: number; readonly deadlineMs?: number } = {},
): Promise<DependencyHistoryCompactionBatch> {
	const windowRows = bounded(options.windowRows, 5_000, 1, 50_000);
	const results = await ownerTransaction(
		owner,
		"maintenance.dependency-history.compact",
		[
			{ sql: PRUNE_IDENTICAL_REBUILD_PAIRS_SQL, params: [windowRows], result: "run" },
			{ sql: ADVANCE_CURSOR_SQL, params: [windowRows], result: "run", requireChanges: true },
			{ sql: READ_PROGRESS_SQL, result: "all" },
		],
		{ deadlineMs: bounded(options.deadlineMs, 10_000, 100, 60_000) },
	);
	const pruned = ownerChanges(results[0]);
	const progress = (results[2] as readonly { cursor?: unknown; lastRowid?: unknown }[] | undefined)?.[0];
	if (typeof progress?.cursor !== "number" || typeof progress.lastRowid !== "number") {
		throw new Error("dependency history compaction state is missing");
	}
	return {
		pruned,
		cursor: progress.cursor,
		lastRowid: progress.lastRowid,
		caughtUp: progress.cursor >= progress.lastRowid,
	};
}

export function startDependencyHistoryCompaction(
	owner: DbOwnerClient,
	options: DependencyHistoryCompactionOptions = {},
): DependencyHistoryCompactionHandle {
	const windowRows = bounded(options.windowRows, 5_000, 1, 50_000);
	const maxBatchesPerCycle = bounded(options.maxBatchesPerCycle, 50, 1, 10_000);
	const yieldMs = bounded(options.yieldMs, 10, 0, 60_000);
	const continueDelayMs = bounded(options.continueDelayMs, 1_000, 0, 24 * 60 * 60 * 1000);
	const idleIntervalMs = bounded(options.idleIntervalMs, 6 * 60 * 60 * 1000, 0, 7 * 24 * 60 * 60 * 1000);
	const errorDelayMs = bounded(options.errorDelayMs, 5 * 60 * 1000, 0, 24 * 60 * 60 * 1000);
	const startDelayMs = bounded(options.startDelayMs, 60_000, 0, 24 * 60 * 60 * 1000);
	let active = true;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let inFlight: Promise<DependencyHistoryCompactionCycle> | null = null;
	let wake: (() => void) | null = null;

	const pause = (ms: number): Promise<void> =>
		new Promise<void>((resolve) => {
			const pending = setTimeout(() => {
				wake = null;
				resolve();
			}, ms);
			wake = () => {
				clearTimeout(pending);
				wake = null;
				resolve();
			};
		});

	async function cycle(): Promise<DependencyHistoryCompactionCycle> {
		let batches = 0;
		let pruned = 0;
		let last: DependencyHistoryCompactionBatch | null = null;
		while (active && batches < maxBatchesPerCycle) {
			if (isSystemPressureHigh()) break;
			if (options.queueIsHealthy !== undefined && !(await options.queueIsHealthy())) break;
			last = await compactDependencyHistoryBatch(owner, { windowRows, deadlineMs: options.batchDeadlineMs });
			batches += 1;
			pruned += last.pruned;
			if (last.caughtUp) break;
			if (yieldMs > 0) await pause(yieldMs);
		}
		const result: DependencyHistoryCompactionCycle = {
			batches,
			pruned,
			cursor: last?.cursor ?? 0,
			lastRowid: last?.lastRowid ?? 0,
			caughtUp: last?.caughtUp ?? false,
		};
		if (pruned > 0) logger.info("retention", "Compacted identical dependency history rebuild pairs", { ...result });
		return result;
	}

	function runCycle(): Promise<DependencyHistoryCompactionCycle> {
		if (inFlight) return inFlight;
		const current = cycle();
		inFlight = current;
		const clear = (): void => {
			if (inFlight === current) inFlight = null;
		};
		void current.then(clear, clear);
		return current;
	}

	function nextDelay(result: DependencyHistoryCompactionCycle): number {
		if (result.caughtUp) return idleIntervalMs;
		if (result.batches === 0) return errorDelayMs;
		return continueDelayMs;
	}

	function schedule(delayMs: number): void {
		if (!active) return;
		timer = setTimeout(() => {
			timer = null;
			void runCycle().then(
				(result) => schedule(nextDelay(result)),
				(error: unknown) => {
					if (active) {
						logger.warn("retention", "Dependency history compaction failed; retrying later", {
							error: error instanceof Error ? error.message : String(error),
							retryInMs: errorDelayMs,
						});
					}
					schedule(errorDelayMs);
				},
			);
		}, delayMs);
		timer.unref?.();
	}

	schedule(startDelayMs);

	return {
		get running(): boolean {
			return active;
		},
		runCycle,
		stop(): Promise<void> {
			active = false;
			if (timer !== null) clearTimeout(timer);
			timer = null;
			wake?.();
			const current = inFlight;
			if (current === null) return Promise.resolve();
			return current.then(
				() => undefined,
				() => undefined,
			);
		},
	};
}
