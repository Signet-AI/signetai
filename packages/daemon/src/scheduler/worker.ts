/**
 * Scheduler worker — polls for due scheduled tasks and spawns CLI processes.
 *
 * Follows the WorkerHandle pattern from pipeline/worker.ts.
 * Polls every 15 seconds (cron granularity is minutes).
 */

import { homedir } from "node:os";
import { join } from "node:path";
import type { TaskHarness } from "@signet/core";
import type { DbAccessor, ReadDb } from "../db-accessor";
import { logger } from "../logger";
import { loadMemoryConfig } from "../memory-config";
import { recordSkillInvocation } from "../skill-invocations";
import { computeNextRun } from "./cron";
import { resolveSkillPrompt } from "./skill-resolver";
import { type SpawnResult, spawnTask } from "./spawn";
import { emitTaskStream } from "./task-stream";

export interface SchedulerHandle {
	stop(): Promise<void>;
	readonly running: boolean;
}

const POLL_INTERVAL_MS = 15_000;
const MAX_CONCURRENT = 3;
const TASK_MODEL_CACHE_TTL_MS = 5_000;

interface TaskModelCacheEntry {
	readonly model: string | undefined;
	readonly expiresAt: number;
}

const taskModelCache = new Map<string, TaskModelCacheEntry>();

function taskModelCacheKey(harness: "claude-code" | "codex", agentsDir: string): string {
	return `${agentsDir}:${harness}`;
}

function getAgentsDir(): string {
	return process.env.SIGNET_PATH || join(homedir(), ".agents");
}

function isTaskHarness(value: string): value is TaskHarness {
	return value === "claude-code" || value === "opencode" || value === "codex";
}

export interface DueTaskRow {
	readonly id: string;
	readonly agent_id: string;
	readonly name: string;
	readonly prompt: string;
	readonly cron_expression: string;
	readonly harness: string;
	readonly working_directory: string | null;
	readonly skill_name: string | null;
	readonly skill_mode: string | null;
}

export function selectDueTasks(db: ReadDb, nowIso: string, limit: number): ReadonlyArray<DueTaskRow> {
	if (limit <= 0) return [];

	return db
		.prepare(
			`SELECT t.id, COALESCE(h.agent_id, 'default') AS agent_id, t.name, t.prompt, t.cron_expression,
			        t.harness, t.working_directory,
			        t.skill_name, t.skill_mode
			 FROM scheduled_tasks t
			 LEFT JOIN task_scope_hints h ON h.task_id = t.id
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
	agentsDir: string = getAgentsDir(),
): string | undefined {
	if (harness !== "codex" && harness !== "claude-code") return undefined;

	const now = Date.now();
	const cacheKey = taskModelCacheKey(harness, agentsDir);
	const cached = taskModelCache.get(cacheKey);
	if (cached && cached.expiresAt > now) {
		return cached.model;
	}

	const cfg = loadMemoryConfig(agentsDir);
	const extraction = cfg.pipelineV2.extraction;
	const model = extraction.provider === harness ? extraction.model : undefined;
	taskModelCache.set(cacheKey, {
		model,
		expiresAt: now + TASK_MODEL_CACHE_TTL_MS,
	});
	return model;
}

export function clearTaskModelCache(): void {
	taskModelCache.clear();
}

type ExecuteTaskDeps = {
	readonly computeNextRun: typeof computeNextRun;
	readonly resolveSkillPrompt: typeof resolveSkillPrompt;
	readonly spawnTask: typeof spawnTask;
	readonly emitTaskStream: typeof emitTaskStream;
	readonly logger: typeof logger;
	readonly resolveTaskModel: typeof resolveTaskModel;
	readonly recordSkillInvocation: typeof recordSkillInvocation;
};

const DEFAULT_EXECUTE_TASK_DEPS: ExecuteTaskDeps = {
	computeNextRun,
	resolveSkillPrompt,
	spawnTask,
	emitTaskStream,
	logger,
	resolveTaskModel,
	recordSkillInvocation,
};

/** Start the scheduler worker. Returns a handle to stop it. */
export function startSchedulerWorker(db: DbAccessor): SchedulerHandle {
	let running = true;
	let timer: ReturnType<typeof setTimeout> | null = null;
	const activeProcesses = new Set<Promise<void>>();

	// On startup, mark any leftover "running" runs as failed (daemon restart)
	db.withWriteTx((wdb) => {
		wdb
			.prepare(
				`UPDATE task_runs
			 SET status = 'failed', error = 'daemon_restart',
			     completed_at = datetime('now')
			 WHERE status IN ('pending', 'running')`,
			)
			.run();
	});

	async function poll(): Promise<void> {
		if (!running) return;

		try {
			// Find due tasks (enabled, next_run_at <= now, not already running)
			const nowIso = new Date().toISOString();
			const dueTasks = db.withReadDb((rdb) => selectDueTasks(rdb, nowIso, MAX_CONCURRENT - activeProcesses.size));

			for (const task of dueTasks) {
				if (activeProcesses.size >= MAX_CONCURRENT) break;
				const p = executeTask(db, task);
				activeProcesses.add(p);
				p.finally(() => activeProcesses.delete(p));
			}
		} catch (err) {
			logger.error("scheduler", "Poll error", undefined, {
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
				logger.info("scheduler", `Waiting for ${activeProcesses.size} active tasks to finish`);
				await Promise.allSettled([...activeProcesses]);
			}
			logger.info("scheduler", "Scheduler worker stopped");
		},
	};
}

/** Lease and execute a single task. */
export async function executeTask(
	db: DbAccessor,
	task: DueTaskRow,
	deps: ExecuteTaskDeps = DEFAULT_EXECUTE_TASK_DEPS,
): Promise<void> {
	const runId = crypto.randomUUID();
	const now = new Date().toISOString();

	// Lease: insert run row + advance next_run_at atomically
	let nextRun: string;
	try {
		nextRun = deps.computeNextRun(task.cron_expression);
	} catch {
		deps.logger.error("scheduler", `Invalid cron for task ${task.name}`, undefined, {
			taskId: task.id,
			cron: task.cron_expression,
		});
		return;
	}

	db.withWriteTx((wdb) => {
		wdb
			.prepare(
				`INSERT INTO task_runs (id, task_id, status, started_at)
			 VALUES (?, ?, 'running', ?)`,
			)
			.run(runId, task.id, now);

		wdb
			.prepare(
				`UPDATE scheduled_tasks
			 SET next_run_at = ?, last_run_at = ?, updated_at = ?
			 WHERE id = ?`,
			)
			.run(nextRun, now, now, task.id);
	});

	deps.emitTaskStream({
		type: "run-started",
		taskId: task.id,
		runId,
		startedAt: now,
		timestamp: new Date().toISOString(),
	});

	deps.logger.info("scheduler", `Executing task: ${task.name}`, {
		taskId: task.id,
		runId,
		harness: task.harness,
	});

	// Resolve skill content into prompt
	const effectivePrompt = deps.resolveSkillPrompt(task.prompt, task.skill_name, task.skill_mode);

	// Spawn the process
	let result: SpawnResult;
	const startedMs = Date.now();
	try {
		if (!isTaskHarness(task.harness)) {
			throw new Error(`Unsupported harness: ${task.harness}`);
		}
		const model = task.harness === "claude-code" || task.harness === "codex" ? deps.resolveTaskModel(task.harness) : undefined;
		result = await deps.spawnTask(
			task.harness,
			effectivePrompt,
			task.working_directory,
			undefined,
			{
				onStdoutChunk: (chunk) => {
					deps.emitTaskStream({
						type: "run-output",
						taskId: task.id,
						runId,
						stream: "stdout",
						chunk,
						timestamp: new Date().toISOString(),
					});
				},
				onStderrChunk: (chunk) => {
					deps.emitTaskStream({
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
	const status = result.error !== null || (result.exitCode !== null && result.exitCode !== 0) ? "failed" : "completed";

	db.withWriteTx((wdb) => {
		wdb
			.prepare(
				`UPDATE task_runs
			 SET status = ?, completed_at = ?, exit_code = ?,
			     stdout = ?, stderr = ?, error = ?
			 WHERE id = ?`,
			)
			.run(status, completedAt, result.exitCode, result.stdout, result.stderr, result.error, runId);
	});

	deps.emitTaskStream({
		type: "run-completed",
		taskId: task.id,
		runId,
		status,
		completedAt,
		exitCode: result.exitCode,
		error: result.error,
		timestamp: new Date().toISOString(),
	});

	deps.logger.info("scheduler", `Task ${task.name} ${status}`, {
		taskId: task.id,
		runId,
		exitCode: result.exitCode,
		timedOut: result.timedOut,
	});

	if (task.skill_name) {
		deps.recordSkillInvocation({
			skillName: task.skill_name,
			agentId: task.agent_id,
			source: "scheduler",
			latencyMs: Date.now() - startedMs,
			success: status === "completed",
			errorText: result.error ?? undefined,
		});
	}
}
