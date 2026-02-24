/**
 * Scheduler worker — polls for due scheduled tasks and spawns CLI processes.
 *
 * Follows the WorkerHandle pattern from pipeline/worker.ts.
 * Polls every 15 seconds (cron granularity is minutes).
 */

import type { DbAccessor } from "../db-accessor";
import type { WorkerHandle } from "../pipeline/worker";
import { computeNextRun } from "./cron";
import { spawnTask, type SpawnResult } from "./spawn";
import { logger } from "../logger";

const POLL_INTERVAL_MS = 15_000;
const MAX_CONCURRENT = 3;

interface DueTaskRow {
	readonly id: string;
	readonly name: string;
	readonly prompt: string;
	readonly cron_expression: string;
	readonly harness: string;
	readonly working_directory: string | null;
}

/** Start the scheduler worker. Returns a handle to stop it. */
export function startSchedulerWorker(db: DbAccessor): WorkerHandle {
	let running = true;
	let timer: ReturnType<typeof setTimeout> | null = null;
	const activeProcesses = new Set<Promise<void>>();

	// On startup, mark any leftover "running" runs as failed (daemon restart)
	db.withWriteTx((wdb) => {
		wdb.prepare(
			`UPDATE task_runs
			 SET status = 'failed', error = 'daemon_restart',
			     completed_at = datetime('now')
			 WHERE status IN ('pending', 'running')`,
		).run();
	});

	async function poll(): Promise<void> {
		if (!running) return;

		try {
			// Find due tasks (enabled, next_run_at <= now, not already running)
			const dueTasks = db.withReadDb((rdb) =>
				rdb
					.prepare(
						`SELECT t.id, t.name, t.prompt, t.cron_expression,
						        t.harness, t.working_directory
						 FROM scheduled_tasks t
						 WHERE t.enabled = 1
						   AND t.next_run_at <= datetime('now')
						   AND NOT EXISTS (
						       SELECT 1 FROM task_runs r
						       WHERE r.task_id = t.id AND r.status = 'running'
						   )
						 ORDER BY t.next_run_at ASC
						 LIMIT ?`,
					)
					.all(MAX_CONCURRENT - activeProcesses.size) as ReadonlyArray<DueTaskRow>,
			);

			for (const task of dueTasks) {
				if (activeProcesses.size >= MAX_CONCURRENT) break;
				const p = executeTask(db, task);
				activeProcesses.add(p);
				p.finally(() => activeProcesses.delete(p));
			}
		} catch (err) {
			logger.error("scheduler", "Poll error", {
				error: err instanceof Error ? err.message : String(err),
			});
		}

		if (running) {
			timer = setTimeout(poll, POLL_INTERVAL_MS);
		}
	}

	// Start polling
	timer = setTimeout(poll, 1000); // initial delay 1s

	logger.info("scheduler", "Scheduler worker started", {
		pollIntervalMs: POLL_INTERVAL_MS,
		maxConcurrent: MAX_CONCURRENT,
	});

	return {
		get running() {
			return running;
		},
		async stop() {
			running = false;
			if (timer !== null) {
				clearTimeout(timer);
				timer = null;
			}
			// Wait for active processes to finish
			if (activeProcesses.size > 0) {
				logger.info(
					"scheduler",
					`Waiting for ${activeProcesses.size} active tasks to finish`,
				);
				await Promise.allSettled([...activeProcesses]);
			}
			logger.info("scheduler", "Scheduler worker stopped");
		},
	};
}

/** Lease and execute a single task. */
async function executeTask(
	db: DbAccessor,
	task: DueTaskRow,
): Promise<void> {
	const runId = crypto.randomUUID();
	const now = new Date().toISOString();

	// Lease: insert run row + advance next_run_at atomically
	let nextRun: string;
	try {
		nextRun = computeNextRun(task.cron_expression);
	} catch {
		logger.error("scheduler", `Invalid cron for task ${task.name}`, {
			taskId: task.id,
			cron: task.cron_expression,
		});
		return;
	}

	db.withWriteTx((wdb) => {
		wdb.prepare(
			`INSERT INTO task_runs (id, task_id, status, started_at)
			 VALUES (?, ?, 'running', ?)`,
		).run(runId, task.id, now);

		wdb.prepare(
			`UPDATE scheduled_tasks
			 SET next_run_at = ?, last_run_at = ?, updated_at = ?
			 WHERE id = ?`,
		).run(nextRun, now, now, task.id);
	});

	logger.info("scheduler", `Executing task: ${task.name}`, {
		taskId: task.id,
		runId,
		harness: task.harness,
	});

	// Spawn the process
	let result: SpawnResult;
	try {
		result = await spawnTask(
			task.harness as "claude-code" | "opencode",
			task.prompt,
			task.working_directory,
		);
	} catch (err) {
		result = {
			exitCode: null,
			stdout: "",
			stderr: "",
			error: err instanceof Error ? err.message : String(err),
			timedOut: false,
		};
	}

	// Record result
	const completedAt = new Date().toISOString();
	const status = result.error !== null || (result.exitCode !== null && result.exitCode !== 0)
		? "failed"
		: "completed";

	db.withWriteTx((wdb) => {
		wdb.prepare(
			`UPDATE task_runs
			 SET status = ?, completed_at = ?, exit_code = ?,
			     stdout = ?, stderr = ?, error = ?
			 WHERE id = ?`,
		).run(
			status,
			completedAt,
			result.exitCode,
			result.stdout,
			result.stderr,
			result.error,
			runId,
		);
	});

	logger.info("scheduler", `Task ${task.name} ${status}`, {
		taskId: task.id,
		runId,
		exitCode: result.exitCode,
		timedOut: result.timedOut,
	});
}
