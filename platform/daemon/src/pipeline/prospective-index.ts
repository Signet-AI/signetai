import { type LlmProvider, type PipelineHintsConfig, scanMemoryContent } from "@signet/core";
import { DbWriteQueueFullError, type DbAccessor, type WriteDb } from "../db-accessor";
import {
	ownerBatch,
	ownerChanges,
	ownerRunStatement,
	ownerRun,
	ownerTransaction,
	ownerWriteQueryOne,
} from "../db-owner-maintenance";
import { getDbOwnerForAccessor } from "../db-owner-runtime";
import { logger } from "../logger";
import type { PipelineV2Config } from "../memory-config";
import { isSystemPressureHigh } from "../system-pressure";
export const HINTS_WORKER_STOP_GRACE_MS = 250;

export interface HintsWorkerHandle {
	stop(): Promise<void>;
	readonly running: boolean;
}

interface HintJobRow {
	readonly id: string;
	readonly memory_id: string;
	readonly payload: string;
	readonly attempts: number;
	readonly max_attempts: number;
	readonly lease_token: string;
}

interface HintPayload {
	readonly memoryId: string;
	readonly content: string;
}

function buildPrompt(content: string, max: number): string {
	return [
		"Given this fact stored in a personal memory system:",
		`"${content}"`,
		"",
		`Generate ${max} diverse questions or cues a user might use in the future when this fact would be helpful. Include:`,
		`- Direct questions ("Where does X live?")`,
		`- Temporal questions ("When did X happen?")`,
		`- Relational questions ("Who is X's partner?")`,
		`- Indirect/conversational cues ("Tell me about X's move")`,
		"",
		"Return ONLY the questions, one per line. No numbering, no bullets.",
	].join("\n");
}

const PROMPT_RESIDUE_PATTERNS = [
	/\bhowever\b/i,
	/\bbut note\b/i,
	/\balternatively\b/i,
	/\bthe problem says\b/i,
	/\bthe fact says\b/i,
	/\bdiverse questions?\b/i,
	/\bdiverse cues?\b/i,
	/\bwe need to\b/i,
	/\blet'?s\b/i,
	/\bmake sure\b/i,
];

const GENERIC_LABEL_CUE_PATTERNS = [
	/^(who requested|when|current status|what is the current status)\s*:/i,
	/^(direct|temporal|relational|indirect|conversational)\s*:/i,
];
function isHintLine(line: string): boolean {
	if (PROMPT_RESIDUE_PATTERNS.some((pattern) => pattern.test(line))) return false;
	if (GENERIC_LABEL_CUE_PATTERNS.some((pattern) => pattern.test(line))) return false;
	if (line.endsWith("?")) return true;
	if (
		/^(tell|describe|explain|show|what|who|where|when|why|how|which|does|did|is|are|can|could|has|have|will|would)/i.test(
			line,
		)
	)
		return true;
	return false;
}

export async function generateHints(
	provider: LlmProvider,
	content: string,
	cfg: PipelineHintsConfig,
): Promise<readonly string[]> {
	if (!scanMemoryContent(content).contextEligible) return [];
	const prompt = buildPrompt(content, cfg.max);
	const raw = await provider.generate(prompt, {
		timeoutMs: cfg.timeout,
		maxTokens: Math.max(cfg.maxTokens, 1024),
	});
	const stripped = raw.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
	const lines = stripped
		.split("\n")
		.map((l) =>
			l
				.replace(/^\d+[.)]\s*/, "")
				.replace(/^[-*]\s*/, "")
				.trim(),
		)
		.filter((l) => l.length > 10 && l.length < 300 && isHintLine(l));
	logger.debug("pipeline", "Hints generated", {
		rawLen: raw.length,
		parsed: lines.length,
	});
	return lines;
}

async function leaseJob(
	owner: import("../db-owner-client").DbOwnerClient,
	maxAttempts: number,
): Promise<HintJobRow | null> {
	const now = new Date().toISOString();
	const epoch = Math.floor(Date.now() / 1000);
	const leaseToken = crypto.randomUUID();
	return (
		(await ownerWriteQueryOne<HintJobRow>(
			owner,
			"pipeline.prospective-index.lease",
			`WITH selected AS (
				 SELECT id
				 FROM memory_jobs
				 WHERE (status = 'leased' AND job_type = 'prospective_index' AND lease_token = ?)
				    OR (job_type = 'prospective_index'
				        AND status = 'pending'
				        AND attempts < ?
				        AND (failed_at IS NULL
				             OR (? - CAST(strftime('%s', failed_at) AS INTEGER))
				                > MIN((1 << attempts) * 5, 120)))
				 ORDER BY CASE WHEN status = 'leased' THEN 0 ELSE 1 END, created_at ASC
				 LIMIT 1
			)
			UPDATE memory_jobs
			 SET status = 'leased',
			     leased_at = CASE WHEN status = 'leased' THEN leased_at ELSE ? END,
			     lease_token = CASE WHEN status = 'leased' THEN lease_token ELSE ? END,
			     attempts = CASE WHEN status = 'leased' THEN attempts ELSE attempts + 1 END,
			     updated_at = CASE WHEN status = 'leased' THEN updated_at ELSE ? END
			 WHERE id = (SELECT id FROM selected)
			 RETURNING id, memory_id, payload, attempts, max_attempts, lease_token`,
			[leaseToken, maxAttempts, epoch, now, leaseToken, now],
			{ estimatedWorkUnits: 1 },
		)) ?? null
	);
}

async function updateJob(
	owner: import("../db-owner-client").DbOwnerClient,
	operation: string,
	sql: string,
	params: readonly (string | number)[],
): Promise<void> {
	await ownerTransaction(owner, operation, [ownerRunStatement(sql, params)], { estimatedWorkUnits: 1 });
}

async function completeJobAndWriteHints(
	owner: import("../db-owner-client").DbOwnerClient,
	job: HintJobRow,
	memoryId: string,
	hints: readonly string[],
): Promise<void> {
	const now = new Date().toISOString();
	await ownerBatch(
		owner,
		"pipeline.prospective-index.complete-with-hints",
		[
			{
				...ownerRunStatement(
					`UPDATE memory_jobs
					 SET status = 'completed', completed_at = ?, leased_at = NULL, lease_token = NULL, updated_at = ?
					 WHERE id = ? AND status = 'leased' AND lease_token = ?`,
					[now, now, job.id, job.lease_token],
				),
				requireChanges: true,
			},
			ownerRunStatement(
				`INSERT OR IGNORE INTO memory_hints (id, memory_id, agent_id, hint, created_at)
				 SELECT lower(hex(randomblob(16))), ?, m.agent_id, value, ?
				 FROM memories m, json_each(?)
				 WHERE m.id = ? AND m.is_deleted = 0 AND m.agent_id IS NOT NULL AND m.agent_id <> ''`,
				[memoryId, now, JSON.stringify(hints), memoryId],
			),
		],
		{ estimatedWorkUnits: Math.max(1, hints.length) },
		false,
	);
}

async function completeJob(owner: import("../db-owner-client").DbOwnerClient, job: HintJobRow): Promise<void> {
	const now = new Date().toISOString();
	await updateJob(
		owner,
		"pipeline.prospective-index.complete-empty",
		`UPDATE memory_jobs
		 SET status = 'completed', completed_at = ?, leased_at = NULL, lease_token = NULL, updated_at = ?
		 WHERE id = ? AND status = 'leased' AND lease_token = ?`,
		[now, now, job.id, job.lease_token],
	);
}

async function recoverStaleLeasesOnOwner(
	owner: import("../db-owner-client").DbOwnerClient,
	now: string,
): Promise<{ readonly total: number }> {
	const results = await ownerBatch(
		owner,
		"pipeline.prospective-index.recover-stale-leases",
		[
			ownerRunStatement(
				`UPDATE memory_jobs
				 SET status = 'dead', leased_at = NULL, lease_token = NULL,
				     failed_at = ?, error = COALESCE(error, ?), updated_at = ?
				 WHERE status = 'leased' AND job_type = 'prospective_index' AND attempts >= max_attempts`,
				[now, "lease expired before completion", now],
			),
			ownerRunStatement(
				`UPDATE memory_jobs
				 SET status = 'pending', leased_at = NULL, lease_token = NULL, updated_at = ?
				 WHERE status = 'leased' AND job_type = 'prospective_index' AND attempts < max_attempts`,
				[now],
			),
		],
		{ estimatedWorkUnits: 2 },
	);
	return { total: ownerChanges(results[0]) + ownerChanges(results[1]) };
}

function isRetryableWriteAdmissionError(error: unknown): boolean {
	return error instanceof DbWriteQueueFullError || (error instanceof Error && error.name === "DbOwnerAdmissionError");
}

export function startHintsWorker(deps: {
	readonly accessor: DbAccessor;
	readonly provider: LlmProvider;
	readonly pipelineCfg: PipelineV2Config;
	readonly recoverLeasesOnStart?: boolean;
}): HintsWorkerHandle {
	const { accessor, provider, pipelineCfg } = deps;
	const rawCfg = pipelineCfg.hints;
	if (!rawCfg?.enabled) {
		return { stop: async () => {}, running: false };
	}
	const cfg = rawCfg;
	const recoverLeasesOnStart = deps.recoverLeasesOnStart === true;
	const ownerPromise = getDbOwnerForAccessor(accessor);

	let running = true;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let tickPromise: Promise<void> | null = null;
	let stopPromise: Promise<void> | null = null;
	type PendingWrite = {
		readonly kind: "completion" | "failure" | "recovery";
		readonly job: HintJobRow;
		readonly run: () => Promise<void>;
		readonly retryAt: number;
	};
	let pendingWrite: PendingWrite | null = null;

	function makeRecoveryWrite(job: HintJobRow, error: string): PendingWrite {
		return {
			kind: "recovery",
			job,
			run: async () => {
				const owner = await ownerPromise;
				await ownerRun(
					owner,
					"pipeline.prospective-index.recover",
					`UPDATE memory_jobs
					 SET status = CASE WHEN attempts >= max_attempts THEN 'dead' ELSE 'pending' END,
					     leased_at = NULL, lease_token = NULL, failed_at = ?, updated_at = ?,
					     payload = CASE WHEN json_valid(payload)
					                    THEN json_set(payload, '$.lastError', ?)
					                    ELSE payload END
					 WHERE id = ? AND status = 'leased' AND lease_token = ?`,
					[new Date().toISOString(), new Date().toISOString(), error, job.id, job.lease_token],
				);
			},
			retryAt: 0,
		};
	}

	function makeLeaseReleaseWrite(job: HintJobRow): PendingWrite {
		return {
			kind: "recovery",
			job,
			run: async () => {
				const owner = await ownerPromise;
				await ownerRun(
					owner,
					"pipeline.prospective-index.release",
					`UPDATE memory_jobs
					 SET status = 'pending', leased_at = NULL, lease_token = NULL, updated_at = ?
					 WHERE id = ? AND status = 'leased' AND lease_token = ?`,
					[new Date().toISOString(), job.id, job.lease_token],
				);
			},
			retryAt: 0,
		};
	}

	async function executePendingWrite(write: PendingWrite, ignoreRetryAt = false): Promise<boolean> {
		if (!ignoreRetryAt && write.retryAt > Date.now()) return false;
		try {
			await write.run();
			if (pendingWrite === write) pendingWrite = null;
			return true;
		} catch (error) {
			const retryable = isRetryableWriteAdmissionError(error);
			if (retryable) {
				if (pendingWrite === write) {
					pendingWrite = { ...write, retryAt: Date.now() + Math.max(cfg.poll, 25) };
				}
				logger.warn("pipeline", "Hints worker write admission deferred", {
					jobId: write.job.id,
					memoryId: write.job.memory_id,
					kind: write.kind,
					retryable: true,
					error: error instanceof Error ? error.message : String(error),
				});
				return false;
			}
			if (write.kind === "completion") {
				const message = error instanceof Error ? error.message : String(error);
				const failure: PendingWrite = {
					kind: "failure",
					job: write.job,
					run: async () => {
						const owner = await ownerPromise;
						await updateJob(
							owner,
							"pipeline.prospective-index.fail-completion",
							`UPDATE memory_jobs
							 SET status = CASE WHEN attempts >= max_attempts THEN 'dead' ELSE 'pending' END,
							     leased_at = NULL, lease_token = NULL, failed_at = ?, updated_at = ?,
							     payload = CASE WHEN json_valid(payload)
							                    THEN json_set(payload, '$.lastError', ?)
							                    ELSE payload END
							 WHERE id = ? AND status = 'leased' AND lease_token = ?`,
							[new Date().toISOString(), new Date().toISOString(), message, write.job.id, write.job.lease_token],
						);
					},
					retryAt: 0,
				};
				pendingWrite = failure;
				await executePendingWrite(failure);
				return false;
			}
			if (write.kind === "failure") {
				const message = error instanceof Error ? error.message : String(error);
				const recovery = makeRecoveryWrite(write.job, message);
				pendingWrite = recovery;
				return executePendingWrite(recovery);
			}
			if (write.kind === "recovery") {
				if (pendingWrite === write) {
					pendingWrite = { ...write, retryAt: Date.now() + Math.max(cfg.poll, 25) };
				}
				logger.warn("pipeline", "Hints worker lease recovery deferred", {
					jobId: write.job.id,
					memoryId: write.job.memory_id,
					retryable: false,
					error: error instanceof Error ? error.message : String(error),
				});
				return false;
			}
			if (pendingWrite === write) pendingWrite = null;
			logger.warn("pipeline", "Hints worker write admission failed", {
				jobId: write.job.id,
				memoryId: write.job.memory_id,
				kind: write.kind,
				retryable: false,
				error: error instanceof Error ? error.message : String(error),
			});
			return false;
		}
	}

	async function releaseLeasedJob(job: HintJobRow): Promise<void> {
		const release = makeLeaseReleaseWrite(job);
		pendingWrite = release;
		await executePendingWrite(release);
	}

	async function tick(): Promise<void> {
		if (!running) return;
		let job: HintJobRow | null = null;
		try {
			if (isSystemPressureHigh()) return;

			if (pendingWrite) {
				await executePendingWrite(pendingWrite);
				return;
			}

			job = await leaseJob(await ownerPromise, 3);
			if (!job) return;
			const j = job;
			if (!running) {
				await releaseLeasedJob(j);
				return;
			}

			let payload: HintPayload;
			try {
				payload = JSON.parse(j.payload) as HintPayload;
			} catch {
				const write: PendingWrite = {
					kind: "failure",
					job: j,
					run: async () => {
						const owner = await ownerPromise;
						await updateJob(
							owner,
							"pipeline.prospective-index.fail-invalid-payload",
							`UPDATE memory_jobs
							 SET status = CASE WHEN attempts >= max_attempts THEN 'dead' ELSE 'pending' END,
							     leased_at = NULL, lease_token = NULL, failed_at = ?, updated_at = ?,
							     payload = CASE WHEN json_valid(payload)
							                    THEN json_set(payload, '$.lastError', ?)
							                    ELSE payload END
							 WHERE id = ? AND status = 'leased' AND lease_token = ?`,
							[new Date().toISOString(), new Date().toISOString(), "invalid payload", j.id, j.lease_token],
						);
					},
					retryAt: 0,
				};
				pendingWrite = write;
				await executePendingWrite(write);
				return;
			}
			const hints = await generateHints(provider, payload.content, cfg);
			if (!running) {
				await releaseLeasedJob(j);
				return;
			}

			if (hints.length > 0) {
				const write: PendingWrite = {
					kind: "completion",
					job: j,
					run: async () => {
						await completeJobAndWriteHints(await ownerPromise, j, payload.memoryId, hints);
					},
					retryAt: 0,
				};
				pendingWrite = write;
				if (!(await executePendingWrite(write))) return;
				logger.info("pipeline", "Prospective hints generated", {
					memoryId: payload.memoryId,
					hints: hints.length,
				});
			} else {
				const write: PendingWrite = {
					kind: "completion",
					job: j,
					run: async () => {
						await completeJob(await ownerPromise, j);
					},
					retryAt: 0,
				};
				pendingWrite = write;
				if (!(await executePendingWrite(write))) return;
				logger.debug("pipeline", "No hints generated (empty LLM response)", {
					memoryId: payload.memoryId,
				});
			}
		} catch (e) {
			if (job) {
				const j = job;
				const msg = e instanceof Error ? e.message : String(e);
				if (!running) {
					await releaseLeasedJob(j);
				} else {
					const write: PendingWrite = {
						kind: "failure",
						job: j,
						run: async () => {
							await updateJob(
								await ownerPromise,
								"pipeline.prospective-index.fail",
								`UPDATE memory_jobs
								 SET status = CASE WHEN attempts >= max_attempts THEN 'dead' ELSE 'pending' END,
								     leased_at = NULL, lease_token = NULL, failed_at = ?, updated_at = ?,
								     payload = CASE WHEN json_valid(payload)
								                    THEN json_set(payload, '$.lastError', ?)
								                    ELSE payload END
								 WHERE id = ? AND status = 'leased' AND lease_token = ?`,
								[new Date().toISOString(), new Date().toISOString(), msg, j.id, j.lease_token],
							);
						},
						retryAt: 0,
					};
					pendingWrite = write;
					await executePendingWrite(write);
					logger.warn("pipeline", "Hints worker job failed", {
						jobId: j.id,
						memoryId: j.memory_id,
						error: msg,
						attempt: j.attempts,
					});
				}
			}
			logger.warn("pipeline", "Hints worker tick failed", {
				error: e instanceof Error ? e.message : String(e),
			});
		} finally {
			if (running) {
				schedule();
			} else if (pendingWrite) {
				startDeferredDrain();
			}
		}
	}

	function schedule(): void {
		if (!running) return;
		timer = setTimeout(() => {
			const current = tick();
			tickPromise = current;
			void current.then(
				() => {
					if (tickPromise === current) tickPromise = null;
				},
				() => {
					if (tickPromise === current) tickPromise = null;
				},
			);
		}, cfg.poll);
	}

	async function drainPendingWrite(deadlineAt: number, logExpired = true): Promise<void> {
		while (pendingWrite && Date.now() < deadlineAt) {
			const write = pendingWrite;
			const waitMs = Math.min(Math.max(0, write.retryAt - Date.now()), 25, Math.max(0, deadlineAt - Date.now()));
			if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
			if (pendingWrite !== write) continue;
			if (Date.now() >= deadlineAt) break;
			if (!(await waitForPromiseOrDeadline(executePendingWrite(write, true), deadlineAt))) break;
		}
		if (pendingWrite && logExpired) {
			logger.warn("pipeline", "Hints worker shutdown drain expired", {
				jobId: pendingWrite.job.id,
				memoryId: pendingWrite.job.memory_id,
				kind: pendingWrite.kind,
				retryable: false,
			});
		}
	}

	function startDeferredDrain(): void {
		void drainPendingWrite(Date.now() + HINTS_WORKER_STOP_GRACE_MS, false).catch((error) => {
			logger.warn("pipeline", "Hints worker post-stop recovery drain failed", {
				error: error instanceof Error ? error.message : String(error),
			});
		});
	}

	async function waitForPromiseOrDeadline(promise: Promise<unknown>, deadlineAt: number): Promise<boolean> {
		let settled = false;
		const completion = promise.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		const remainingMs = Math.max(0, deadlineAt - Date.now());
		if (remainingMs > 0) {
			let timeout: ReturnType<typeof setTimeout> | null = null;
			const deadline = new Promise<void>((resolve) => {
				timeout = setTimeout(resolve, remainingMs);
			});
			await Promise.race([completion, deadline]);
			if (timeout !== null) clearTimeout(timeout);
		}
		return settled;
	}
	if (recoverLeasesOnStart) {
		void ownerPromise
			.then((owner) => recoverStaleLeasesOnOwner(owner, new Date().toISOString()))
			.then((recovered) => {
				if (recovered.total > 0) {
					logger.info("pipeline", "Recovered prospective index leases before worker start", {
						count: recovered.total,
					});
				}
			})
			.catch((error) => {
				logger.warn("pipeline", "Prospective index lease recovery before worker start failed", {
					error: error instanceof Error ? error.message : String(error),
				});
			})
			.finally(() => {
				if (running) schedule();
			});
	} else {
		schedule();
	}

	return {
		async stop() {
			if (stopPromise) return stopPromise;
			stopPromise = (async () => {
				running = false;
				if (timer) {
					clearTimeout(timer);
					timer = null;
				}
				const deadlineAt = Date.now() + HINTS_WORKER_STOP_GRACE_MS;
				const tickAtStop = tickPromise;
				if (tickAtStop && !(await waitForPromiseOrDeadline(tickAtStop, deadlineAt))) {
					logger.warn("pipeline", "Hints worker shutdown tick still in flight", {
						graceMs: HINTS_WORKER_STOP_GRACE_MS,
						pendingWrite: pendingWrite?.kind ?? null,
					});
					return;
				}
				await drainPendingWrite(deadlineAt);
				if (pendingWrite?.retryAt && pendingWrite.retryAt > Date.now()) startDeferredDrain();
			})();
			return stopPromise;
		},
		get running() {
			return running;
		},
	};
}

export function enqueueHintsJob(db: WriteDb, memoryId: string, content: string): void {
	const id = crypto.randomUUID();
	const now = new Date().toISOString();
	const payload = JSON.stringify({ memoryId, content } satisfies HintPayload);
	db.prepare(
		`INSERT INTO memory_jobs
		 (id, memory_id, job_type, status, payload, attempts, max_attempts, created_at, updated_at)
		 VALUES (?, ?, 'prospective_index', 'pending', ?, 0, 3, ?, ?)`,
	).run(id, memoryId, payload, now, now);
}
