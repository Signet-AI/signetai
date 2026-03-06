/**
 * Scheduler worker — polls for due scheduled tasks and spawns CLI processes.
 *
 * Follows the WorkerHandle pattern from pipeline/worker.ts.
 * Polls every 15 seconds (cron granularity is minutes).
 */

import { homedir } from "node:os";
import { join } from "node:path";
import type { DbAccessor, ReadDb } from "../db-accessor";
import { loadMemoryConfig } from "../memory-config";
import type { WorkerHandle } from "../pipeline/worker";
import { computeNextRun } from "./cron";
import { resolveSkillPrompt } from "./skill-resolver";
import { spawnTask, type SpawnResult } from "./spawn";
import { emitTaskStream } from "./task-stream";
import { logger } from "../logger";

const POLL_INTERVAL_MS = 15_000;
const MAX_CONCURRENT = 3;
const AGENTS_DIR = process.env.SIGNET_PATH || join(homedir(), ".agents");
const TASK_MODEL_CACHE_TTL_MS = 5_000;

interface TaskModelCacheEntry {
	readonly model: string | undefined;
	readonly expiresAt: number;
}

const taskModelCache = new Map<string, TaskModelCacheEntry>();

export interface DueTaskRow {
	readonly id: string;
	readonly name: string;
	readonly prompt: string;
	readonly cron_expression: string;
	readonly harness: string;
	readonly working_directory: string | null;
	readonly skill_name: string | null;
	readonly skill_mode: string | null;
}

export function selectDueTasks(
	db: ReadDb,
	nowIso: string,
	limit: number,
): ReadonlyArray<DueTaskRow> {
	if (limit <= 0) return [];

	return db
		.prepare(
			`SELECT t.id, t.name, t.prompt, t.cron_expression,
			        t.harness, t.working_directory,
			        t.skill_name, t.skill_mode
			 FROM scheduled_tasks t
			 WHERE t.enabled = 1
			   AND t.next_run_at IS NOT NULL
			   AND t.next_run_at <= ?
			   AND NOT EXISTS (
			       SELECT 1 FROM task_runs r
			       WHERE r.task_id = t.id AND r.status = 'running'
			   )
			 ORDER BY t.next_run_at ASC
			 LIMIT ?`,
		)
		.all(nowIso, limit) as ReadonlyArray<DueTaskRow>;
}

export function resolveTaskModel(
	harness: DueTaskRow["harness"],
	agentsDir: string = AGENTS_DIR,
): string | undefined {
	if (harness !== "codex") return undefined;

	const now = Date.now();
	const cached = taskModelCache.get(agentsDir);
	if (cached && cached.expiresAt > now) {
		return cached.model;
	}

	const cfg = loadMemoryConfig(agentsDir);
	const model = cfg.pipelineV2.extraction.provider === "codex"
		? cfg.pipelineV2.extraction.model
		: undefined;
	taskModelCache.set(agentsDir, {
		model,
		expiresAt: now + TASK_MODEL_CACHE_TTL_MS,
	});
	return model;
}

export function clearTaskModelCache(): void {
	taskModelCache.clear();
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
			const nowIso = new Date().toISOString();
			const dueTasks = db.withReadDb((rdb) =>
				selectDueTasks(rdb, nowIso, MAX_CONCURRENT - activeProcesses.size),
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

	emitTaskStream({
		type: "run-started",
		taskId: task.id,
		runId,
		startedAt: now,
		timestamp: new Date().toISOString(),
	});

	logger.info("scheduler", `Executing task: ${task.name}`, {
		taskId: task.id,
		runId,
		harness: task.harness,
	});

	// Resolve skill content into prompt
	const effectivePrompt = resolveSkillPrompt(
		task.prompt,
		task.skill_name,
		task.skill_mode,
	);
	const model = resolveTaskModel(task.harness);

	// Spawn the process
	let result: SpawnResult;
	try {
		result = await spawnTask(
			task.harness as "claude-code" | "opencode" | "codex",
			effectivePrompt,
			task.working_directory,
			undefined,
			{
				onStdoutChunk: (chunk) => {
					emitTaskStream({
						type: "run-output",
						taskId: task.id,
						runId,
						stream: "stdout",
						chunk,
						timestamp: new Date().toISOString(),
					});
				},
				onStderrChunk: (chunk) => {
					emitTaskStream({
						type: "run-output",
						taskId: task.id,
						runId,
						stream: "stderr",
						chunk,
						timestamp: new Date().toISOString(),
					});
				},
			},
			model,
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

	emitTaskStream({
		type: "run-completed",
		taskId: task.id,
		runId,
		status,
		completedAt,
		exitCode: result.exitCode,
		error: result.error,
		timestamp: new Date().toISOString(),
	});

	logger.info("scheduler", `Task ${task.name} ${status}`, {
		taskId: task.id,
		runId,
		exitCode: result.exitCode,
		timedOut: result.timedOut,
	});
}
