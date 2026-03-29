/**
 * Synthesis worker: session-activity-based MEMORY.md regeneration.
 *
 * Instead of fixed daily/weekly schedules, this worker monitors session
 * activity and triggers synthesis after an idle gap — when the user has
 * stopped using sessions for a configurable number of minutes.
 *
 * Renders MEMORY.md programmatically from canonical artifacts, thread
 * heads, and DB-native runtime state after an idle gap.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PipelineSynthesisConfig } from "@signet/core";
import { getDbAccessor } from "../db-accessor";
import { handleSynthesisRequest, writeMemoryMd } from "../hooks";
import { logger } from "../logger";
import { activeSessionCount } from "../session-tracker";

function getAgentsDir(): string {
	return process.env.SIGNET_PATH || join(homedir(), ".agents");
}

function normalizeAgentId(agentId?: string): string {
	const next = agentId?.trim();
	return next && next.length > 0 ? next : "default";
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** How often the worker checks if synthesis is due (60s). */
const CHECK_INTERVAL_MS = 60_000;

/** Minimum time between syntheses to avoid rapid re-runs (1 hour). */
const MIN_INTERVAL_MS = 60 * 60 * 1000;

/** Initial delay after daemon start before first check (60s). */
const STARTUP_DELAY_MS = 60_000;
const FORCE_RETRY_MS = 5_000;
const DRAIN_TIMEOUT_BUFFER_MS = 1_000;

// ---------------------------------------------------------------------------
// Timestamp persistence
// ---------------------------------------------------------------------------

function getLastSynthesisPath(agentId?: string): string {
	const key = normalizeAgentId(agentId);
	const file = key === "default" ? "last-synthesis.json" : `last-synthesis.${encodeURIComponent(key)}.json`;
	return join(getAgentsDir(), ".daemon", file);
}

export function readLastSynthesisTime(agentId?: string): number {
	try {
		const path = getLastSynthesisPath(agentId);
		if (!existsSync(path)) return 0;
		const data = JSON.parse(readFileSync(path, "utf-8"));
		return typeof data.lastRunAt === "number" ? data.lastRunAt : 0;
	} catch {
		return 0;
	}
}

function writeLastSynthesisTime(timestamp: number, agentId?: string): void {
	try {
		const path = getLastSynthesisPath(agentId);
		mkdirSync(join(getAgentsDir(), ".daemon"), { recursive: true });
		writeFileSync(path, JSON.stringify({ lastRunAt: timestamp }));
	} catch (e) {
		logger.warn("synthesis", "Failed to persist synthesis timestamp", {
			error: e instanceof Error ? e.message : String(e),
		});
	}
}

// ---------------------------------------------------------------------------
// Session activity detection
// ---------------------------------------------------------------------------

/**
 * Get the timestamp of the most recent session end from checkpoints.
 * Falls back to the latest completed summary job when no checkpoint exists.
 */
function parseLastEndTimestamp(row: unknown): number {
	if (typeof row !== "object" || row === null || !("last_end" in row)) {
		return 0;
	}
	const value = row.last_end;
	if (typeof value !== "string" || value.length === 0) {
		return 0;
	}
	const ts = Date.parse(value);
	return Number.isNaN(ts) ? 0 : ts;
}

function isExpectedSessionActivityLookupError(error: unknown, table: string): boolean {
	if (!(error instanceof Error)) return false;
	const message = error.message.toLowerCase();
	return (
		message.includes(`no such table: ${table}`) ||
		message.includes("dbaccessor not initialised") ||
		message.includes("dbaccessor is closed")
	);
}

function getLastSessionEndTime(): number {
	try {
		const checkpointRow = getDbAccessor().withReadDb((db) => {
			return db
				.prepare(`
				SELECT MAX(created_at) as last_end
				FROM session_checkpoints
				WHERE trigger = 'session_end'
			`)
				.get();
		});
		const checkpointTs = parseLastEndTimestamp(checkpointRow);
		if (checkpointTs > 0) {
			return checkpointTs;
		}
	} catch (error) {
		if (!isExpectedSessionActivityLookupError(error, "session_checkpoints")) {
			logger.error(
				"synthesis",
				"Failed to query session_checkpoints for synthesis scheduling",
				error instanceof Error ? error : new Error(String(error)),
			);
			throw error;
		}
	}

	try {
		const summaryRow = getDbAccessor().withReadDb((db) => {
			return db
				.prepare(`
					SELECT MAX(completed_at) as last_end
					FROM summary_jobs
					WHERE status = 'completed'
				`)
				.get();
		});
		return parseLastEndTimestamp(summaryRow);
	} catch (error) {
		if (!isExpectedSessionActivityLookupError(error, "summary_jobs")) {
			logger.error(
				"synthesis",
				"Failed to query summary_jobs for synthesis scheduling",
				error instanceof Error ? error : new Error(String(error)),
			);
			throw error;
		}
		return 0;
	}
}

// ---------------------------------------------------------------------------
// Core synthesis execution
// ---------------------------------------------------------------------------

type SynthesisResult = "ok" | "empty" | "failed" | "busy";
export type SynthesisDrainResult = "completed" | "timeout";

function shouldRecordSuccess(result: SynthesisResult): boolean {
	return result === "ok" || result === "empty";
}

async function runSynthesis(config: PipelineSynthesisConfig, agentId?: string): Promise<SynthesisResult> {
	logger.info("synthesis", "Starting scheduled synthesis", {
		provider: config.provider,
		model: config.model,
		agentId: agentId ?? "default",
	});

	try {
		const synthesisData = handleSynthesisRequest(
			{ trigger: "scheduled" },
			{
				maxTokens: config.maxTokens,
				agentId,
			},
		);

		if (synthesisData.fileCount === 0) {
			logger.info("synthesis", "No synthesis sources available, skipping");
			return "empty";
		}

		if (!synthesisData.prompt || synthesisData.prompt.trim().length === 0) {
			logger.warn("synthesis", "Renderer returned empty MEMORY.md projection");
			return "failed";
		}
		const finalText = synthesisData.prompt.trimEnd();

		// Write MEMORY.md via shared helper (handles backup)
		const writeResult = writeMemoryMd(finalText, { owner: "synthesis-worker" });
		if (!writeResult.ok) {
			if (writeResult.code === "busy") {
				logger.warn("synthesis", "MEMORY.md head busy, deferring synthesis write");
				return "busy";
			}
			logger.error("synthesis", `MEMORY.md write refused: ${writeResult.error}`);
			return "failed";
		}

		logger.info("synthesis", "MEMORY.md synthesized", {
			sourceItems: synthesisData.fileCount,
			outputLength: finalText.length,
		});

		return "ok";
	} catch (e) {
		logger.error("synthesis", "Synthesis failed", e instanceof Error ? e : new Error(String(e)));
		return "failed";
	}
}

// ---------------------------------------------------------------------------
// Worker handle
// ---------------------------------------------------------------------------

export interface SynthesisWorkerHandle {
	stop(): void;
	/** Drain in-flight synthesis work. Must be called after stop() to prevent new locks. */
	drain(): Promise<SynthesisDrainResult>;
	/**
	 * Acquire the shared write lock for manual/legacy synthesis paths.
	 * The returned token is single-use and must always be released in a finally block.
	 */
	acquireWriteLock(): number | null;
	/** Release a token previously returned by acquireWriteLock(). */
	releaseWriteLock(token: number): void;
	readonly running: boolean;
	readonly isSynthesizing: boolean;
	readonly pendingForceCount: number;
	/** Trigger an immediate synthesis (e.g. from API). */
	triggerNow(opts?: { readonly force?: boolean; readonly source?: string; readonly agentId?: string }): Promise<{
		success: boolean;
		skipped: boolean;
		reason?: string;
	}>;
	/** Last synthesis timestamp. */
	readonly lastRunAt: number;
}

export function startSynthesisWorker(config: PipelineSynthesisConfig): SynthesisWorkerHandle {
	type PendingForce = {
		source: string;
		readonly agentId: string;
		count: number;
	};

	let timer: ReturnType<typeof setTimeout> | null = null;
	let stopped = false;
	let isSynthesizing = false;
	let currentRunPromise: Promise<SynthesisResult> | null = null;
	let nextLockToken = 1;
	let activeLockToken: number | null = null;
	let lockReleasedResolver: (() => void) | null = null;
	let lockReleasedPromise: Promise<void> = Promise.resolve();
	const pendingQueue: PendingForce[] = [];
	const idleGapMs = config.idleGapMinutes * 60 * 1000;

	function acquireWriteLock(): number | null {
		if (stopped || isSynthesizing) return null;
		isSynthesizing = true;
		activeLockToken = nextLockToken++;
		lockReleasedPromise = new Promise<void>((resolve) => {
			lockReleasedResolver = resolve;
		});
		return activeLockToken;
	}

	function releaseWriteLock(token: number): void {
		if (activeLockToken !== token) return;
		activeLockToken = null;
		isSynthesizing = false;
		lockReleasedResolver?.();
		lockReleasedResolver = null;
	}

	function enqueuePendingForce(source: string, agentId?: string): void {
		const key = normalizeAgentId(agentId);
		const existing = pendingQueue.find((entry) => entry.agentId === key);
		if (existing) {
			existing.count += 1;
			existing.source = source;
			return;
		}
		pendingQueue.push({ source, agentId: key, count: 1 });
	}

	function clearPendingForceFor(agentId?: string): void {
		const key = normalizeAgentId(agentId);
		let idx = pendingQueue.findIndex((entry) => entry.agentId === key);
		while (idx !== -1) {
			pendingQueue.splice(idx, 1);
			idx = pendingQueue.findIndex((entry) => entry.agentId === key);
		}
	}

	async function runForcedDrainAttempt(entry: PendingForce): Promise<"completed" | "retry"> {
		const lockToken = acquireWriteLock();
		if (lockToken === null) {
			return "retry";
		}

		try {
			currentRunPromise = runSynthesis(config, entry.agentId);
			const result = await currentRunPromise;
			if (result === "busy" || result === "failed") {
				logger.info("synthesis", "Retrying forced synthesis after busy head", {
					source: entry.source,
					agentId: entry.agentId,
					result,
				});
				return "retry";
			}
			if (shouldRecordSuccess(result)) {
				writeLastSynthesisTime(Date.now(), entry.agentId);
			}
			return "completed";
		} finally {
			currentRunPromise = null;
			releaseWriteLock(lockToken);
		}
	}

	async function tick(): Promise<void> {
		if (stopped) return;

		try {
			const pending = pendingQueue[0];
			if (pending) {
				const state = await runForcedDrainAttempt(pending);
				if (state === "completed") {
					if (pending.count <= 1) {
						pendingQueue.shift();
					} else {
						pending.count -= 1;
					}
					scheduleTick(pendingQueue.length > 0 ? FORCE_RETRY_MS : CHECK_INTERVAL_MS);
					return;
				}
				if (pendingQueue.length > 1) {
					const head = pendingQueue.shift();
					if (head) pendingQueue.push(head);
				}
				scheduleTick(FORCE_RETRY_MS);
				return;
			}

			if (isSynthesizing) {
				scheduleTick(CHECK_INTERVAL_MS);
				return;
			}

			// Don't synthesize while sessions are active
			if (activeSessionCount() > 0) {
				scheduleTick(CHECK_INTERVAL_MS);
				return;
			}

			// Check when the last session ended
			const lastSessionEnd = getLastSessionEndTime();
			if (lastSessionEnd === 0) {
				// No session-end checkpoints yet — nothing to synthesize from
				scheduleTick(CHECK_INTERVAL_MS);
				return;
			}

			const idleSince = Date.now() - lastSessionEnd;
			if (idleSince < idleGapMs) {
				// Not idle long enough
				scheduleTick(CHECK_INTERVAL_MS);
				return;
			}

			// Check if we already synthesized since the last session ended
			const lastRun = readLastSynthesisTime();
			if (lastRun >= lastSessionEnd) {
				// Already synthesized after the most recent session
				scheduleTick(CHECK_INTERVAL_MS);
				return;
			}

			// Enforce minimum interval
			const elapsed = Date.now() - lastRun;
			if (elapsed < MIN_INTERVAL_MS) {
				scheduleTick(CHECK_INTERVAL_MS);
				return;
			}

			const lockToken = acquireWriteLock();
			if (lockToken === null) {
				scheduleTick(CHECK_INTERVAL_MS);
				return;
			}

			try {
				currentRunPromise = runSynthesis(config);
				const result = await currentRunPromise;
				if (shouldRecordSuccess(result)) {
					// Busy means another writer currently owns the shared
					// MEMORY.md head lease. Leave last-run untouched so the
					// next tick retries instead of waiting a full interval.
					writeLastSynthesisTime(Date.now());
				}
			} finally {
				currentRunPromise = null;
				releaseWriteLock(lockToken);
			}
		} catch (e) {
			logger.error("synthesis", "Unhandled tick error", e instanceof Error ? e : new Error(String(e)));
		}

		scheduleTick(CHECK_INTERVAL_MS);
	}

	function scheduleTick(delay: number): void {
		if (stopped) return;
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => {
			timer = null;
			tick().catch((err) => {
				logger.error("synthesis", "Unhandled tick error", err instanceof Error ? err : new Error(String(err)));
			});
		}, delay);
	}

	// Initial delay to let other workers settle
	scheduleTick(STARTUP_DELAY_MS);

	logger.info("synthesis", "Synthesis worker started", {
		provider: config.provider,
		model: config.model,
		idleGapMinutes: config.idleGapMinutes,
	});

	return {
		stop() {
			stopped = true;
			if (timer) clearTimeout(timer);
			logger.info("synthesis", "Synthesis worker stopped");
		},
		async drain() {
			// Cancel any pending tick to prevent new synthesis starting
			if (timer) {
				clearTimeout(timer);
				timer = null;
			}
			if (!isSynthesizing) return "completed";
			let timeoutId: ReturnType<typeof setTimeout> | null = null;
			let timedOut = false;
			try {
				await Promise.race([
					// External callers can hold the write lock without setting
					// currentRunPromise, so drain must wait for both the active run
					// and the shared lock release before shutdown continues.
					Promise.all([currentRunPromise ?? Promise.resolve(), lockReleasedPromise]).then(() => undefined),
					new Promise<void>((resolve) => {
						timeoutId = setTimeout(() => {
							timedOut = true;
							logger.warn("synthesis", "drain() timed out waiting for in-flight synthesis");
							resolve();
						}, config.timeout + DRAIN_TIMEOUT_BUFFER_MS);
					}),
				]);
				return timedOut ? "timeout" : "completed";
			} finally {
				if (timeoutId !== null) clearTimeout(timeoutId);
			}
		},
		acquireWriteLock,
		releaseWriteLock,
		get running() {
			return !stopped;
		},
		get isSynthesizing() {
			return isSynthesizing;
		},
		get pendingForceCount() {
			return pendingQueue.reduce((sum, entry) => sum + entry.count, 0);
		},
		get lastRunAt() {
			return readLastSynthesisTime();
		},
		async triggerNow(opts) {
			if (stopped) {
				return { success: false, skipped: true, reason: "Synthesis worker stopped" };
			}
			const lockToken = acquireWriteLock();
			if (lockToken === null) {
				if (opts?.force) {
					enqueuePendingForce(opts.source ?? "manual", opts.agentId);
					scheduleTick(FORCE_RETRY_MS);
					return {
						success: false,
						skipped: true,
						reason: "Synthesis already in progress (queued forced retry)",
					};
				}
				return {
					success: false,
					skipped: true,
					reason: "Synthesis already in progress",
				};
			}

			try {
				const key = normalizeAgentId(opts?.agentId);
				const lastRun = readLastSynthesisTime(key);
				const elapsed = Date.now() - lastRun;

				if (!opts?.force && elapsed < MIN_INTERVAL_MS) {
					const reason = `Too recent — last run ${Math.round(elapsed / 60000)}m ago, minimum is ${Math.round(MIN_INTERVAL_MS / 60000)}m`;
					logger.info("synthesis", "Skipping manual trigger", {
						reason,
						source: opts?.source ?? "manual",
					});
					return { success: false, skipped: true, reason };
				}

				currentRunPromise = runSynthesis(config, opts?.agentId);
				const result = await currentRunPromise;
				if ((result === "busy" || result === "failed") && opts?.force) {
					enqueuePendingForce(opts.source ?? "manual", opts.agentId);
					scheduleTick(FORCE_RETRY_MS);
				}
				if (shouldRecordSuccess(result)) {
					writeLastSynthesisTime(Date.now(), key);
					clearPendingForceFor(opts?.agentId);
				}
				return {
					success: result === "ok",
					skipped: result === "empty" || result === "busy",
					reason:
						result === "empty"
							? "No session summaries to synthesize"
							: result === "busy" && opts?.force
								? "MEMORY.md head busy (queued forced retry)"
								: result === "busy"
									? "MEMORY.md head busy"
									: undefined,
				};
			} finally {
				currentRunPromise = null;
				releaseWriteLock(lockToken);
			}
		},
	};
}
