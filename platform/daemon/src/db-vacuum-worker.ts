import type { DbAccessor } from "./db-accessor";
import type { DbOwnerClient } from "./db-owner-client";
import { ownerQueryOne, ownerRunStatement, ownerTransaction } from "./db-owner-maintenance";
import { dbOwnerIncrementalVacuum, dbOwnerVacuumConversion } from "./db-owner-runtime";
import {
	getVacuumConversionStatusAsync,
	markVacuumConversionCompleted,
	markVacuumConversionFailed,
	markVacuumConversionRunning,
	type VacuumConversionStatus,
} from "./db-vacuum";
import { logger } from "./logger";

export interface IncrementalReclaimOptions {
	readonly batchPages?: number;
	readonly maxBatches?: number;
	readonly checkpointKey?: string;
	readonly onCheckpoint?: (reclaimed: number, remaining: number) => void;
}

export interface VacuumConversionHandle {
	readonly running: boolean;
	stop(): void;
	run(): Promise<VacuumConversionStatus>;
}
export async function reclaimIncrementalVacuum(
	owner: DbOwnerClient,
	opts: IncrementalReclaimOptions = {},
): Promise<{ readonly reclaimed: number; readonly remaining: number }> {
	const batchPages = Math.max(1, Math.min(10_000, Math.trunc(opts.batchPages ?? 1_000)));
	const maxBatches = Math.max(1, Math.min(100_000, Math.trunc(opts.maxBatches ?? 100_000)));
	const key = opts.checkpointKey ?? "vacuum.incremental-reclaim";
	let reclaimed = 0;
	let remaining = 0;
	await ownerTransaction(owner, "maintenance.vacuum.checkpoint.ensure", [
		ownerRunStatement(
			"CREATE TABLE IF NOT EXISTS db_vacuum_reclaim_checkpoints (checkpoint_key TEXT PRIMARY KEY, reclaimed INTEGER NOT NULL, remaining INTEGER NOT NULL, updated_at TEXT NOT NULL)",
		),
	]);
	const saved = await ownerQueryOne<{ reclaimed: number; remaining: number }>(
		owner,
		"maintenance.vacuum.checkpoint.read",
		"SELECT reclaimed, remaining FROM db_vacuum_reclaim_checkpoints WHERE checkpoint_key = ?",
		[key],
	);
	reclaimed = saved?.reclaimed ?? 0;
	remaining = saved?.remaining ?? 0;
	let previousRemaining: number | null = remaining > 0 ? remaining : null;
	for (let batch = 0; batch < maxBatches; batch += 1) {
		const before = previousRemaining;
		remaining = await dbOwnerIncrementalVacuum(owner, batchPages);
		const progressed = before === null ? Math.max(0, batchPages) : Math.max(0, before - remaining);
		reclaimed += progressed;
		previousRemaining = remaining;
		await ownerTransaction(owner, "maintenance.vacuum.checkpoint.write", [
			ownerRunStatement(
				"INSERT INTO db_vacuum_reclaim_checkpoints (checkpoint_key, reclaimed, remaining, updated_at) VALUES (?, ?, ?, datetime('now')) ON CONFLICT(checkpoint_key) DO UPDATE SET reclaimed=excluded.reclaimed, remaining=excluded.remaining, updated_at=excluded.updated_at",
				[key, reclaimed, remaining],
			),
		]);
		opts.onCheckpoint?.(reclaimed, remaining);
		if (remaining <= 0 || progressed <= 0) break;
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
	}
	return { reclaimed, remaining };
}
export function startVacuumConversionWorker(
	accessor: DbAccessor,
	opts: { readonly owner: DbOwnerClient; readonly startImmediately?: boolean },
): VacuumConversionHandle {
	let active = true;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let inFlight: Promise<VacuumConversionStatus> | null = null;

	async function run(): Promise<VacuumConversionStatus> {
		if (inFlight) return inFlight;
		const cycle = (async (): Promise<VacuumConversionStatus> => {
			const before = await getVacuumConversionStatusAsync(accessor);
			if (before.state !== "pending" || before.attempts >= before.maxAttempts) return before;

			await markVacuumConversionRunning(accessor);
			const running = await getVacuumConversionStatusAsync(accessor);
			if (running.state !== "running") return running;
			logger.info("db-vacuum", "Post-ready conversion worker started", {
				attempt: running.attempts,
				maxAttempts: running.maxAttempts,
			});

			try {
				await dbOwnerVacuumConversion(opts.owner);
				await markVacuumConversionCompleted(accessor);
				logger.info("db-vacuum", "Post-ready conversion worker completed");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				await markVacuumConversionFailed(accessor, message);
				logger.error(
					"db-vacuum",
					"Post-ready conversion worker failed; retry is available on a later startup while the attempt budget remains",
					error instanceof Error ? error : undefined,
				);
			}
			return await getVacuumConversionStatusAsync(accessor);
		})();
		inFlight = cycle;
		void cycle.then(
			() => {
				if (inFlight === cycle) inFlight = null;
			},
			() => {
				if (inFlight === cycle) inFlight = null;
			},
		);
		return cycle;
	}

	if (opts.startImmediately !== false) {
		timer = setTimeout(() => {
			if (!active) return;
			void run().catch((error) => {
				logger.error("db-vacuum", "Post-ready conversion worker crashed", error instanceof Error ? error : undefined);
			});
		}, 0);
	}

	return {
		get running(): boolean {
			return active;
		},
		stop(): void {
			active = false;
			if (timer) clearTimeout(timer);
			timer = null;
		},
		run,
	};
}
