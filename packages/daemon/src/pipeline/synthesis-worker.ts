/**
 * Synthesis worker: session-activity-based MEMORY.md regeneration.
 *
 * Instead of fixed daily/weekly schedules, this worker monitors session
 * activity and triggers synthesis after an idle gap — when the user has
 * stopped using sessions for a configurable number of minutes.
 *
 * Uses a dedicated synthesis LLM provider (separate from extraction)
 * because synthesis needs a smarter model that can reason across long
 * context, whereas extraction uses tiny local models for tagging.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PipelineSynthesisConfig } from "@signet/core";
import { getDbAccessor } from "../db-accessor";
import { appendSynthesisIndexBlock, handleSynthesisRequest, writeMemoryMd } from "../hooks";
import { logger } from "../logger";
import { activeSessionCount } from "../session-tracker";
import { getSynthesisProvider } from "../synthesis-llm";
import { generateWithTracking } from "./provider";

function getAgentsDir(): string {
	return process.env.SIGNET_PATH || join(homedir(), ".agents");
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
const DRAIN_TIMEOUT_BUFFER_MS = 1_000;

// ---------------------------------------------------------------------------
// Timestamp persistence
// ---------------------------------------------------------------------------

function getLastSynthesisPath(): string {
	return join(getAgentsDir(), ".daemon", "last-synthesis.json");
}

export function readLastSynthesisTime(): number {
	try {
		const path = getLastSynthesisPath();
		if (!existsSync(path)) return 0;
		const data = JSON.parse(readFileSync(path, "utf-8"));
		return typeof data.lastRunAt === "number" ? data.lastRunAt : 0;
	} catch {
		return 0;
	}
}

function writeLastSynthesisTime(timestamp: number): void {
	try {
		const path = getLastSynthesisPath();
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

async function runSynthesis(config: PipelineSynthesisConfig): Promise<SynthesisResult> {
	logger.info("synthesis", "Starting scheduled synthesis", {
		provider: config.provider,
		model: config.model,
	});

	try {
		const synthesisData = handleSynthesisRequest({ trigger: "scheduled" }, { maxTokens: config.maxTokens });

		if (synthesisData.fileCount === 0) {
			logger.info("synthesis", "No synthesis sources available, skipping");
			return "empty";
		}

		// Call the synthesis-specific LLM provider
		const provider = getSynthesisProvider();
		const result = await generateWithTracking(provider, synthesisData.prompt, {
			maxTokens: config.maxTokens,
			timeoutMs: config.timeout,
		});

		if (!result.text || result.text.trim().length === 0) {
			logger.warn("synthesis", "LLM returned empty synthesis");
			return "failed";
		}

		// Guard against non-markdown output (e.g. raw JSON error blobs)
		const trimmed = result.text.trim();
		if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
			try {
				JSON.parse(trimmed);
				logger.error("synthesis", "LLM returned JSON instead of markdown, skipping write", undefined, {
					preview: trimmed.slice(0, 200),
				});
				return "failed";
			} catch {
				// Not valid JSON — markdown starting with [ or { is fine
			}
		}

		const finalText = appendSynthesisIndexBlock(result.text, synthesisData.indexBlock ?? "");

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
			...(result.usage
				? {
						inputTokens: result.usage.inputTokens,
						outputTokens: result.usage.outputTokens,
					}
				: {}),
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
	/** Trigger an immediate synthesis (e.g. from API). */
	triggerNow(): Promise<{ success: boolean; skipped: boolean; reason?: string }>;
	/** Last synthesis timestamp. */
	readonly lastRunAt: number;
}

export function startSynthesisWorker(config: PipelineSynthesisConfig): SynthesisWorkerHandle {
	let timer: ReturnType<typeof setTimeout> | null = null;
	let stopped = false;
	let isSynthesizing = false;
	let currentRunPromise: Promise<SynthesisResult> | null = null;
	let nextLockToken = 1;
	let activeLockToken: number | null = null;
	let lockReleasedResolver: (() => void) | null = null;
	let lockReleasedPromise: Promise<void> = Promise.resolve();
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

	async function tick(): Promise<void> {
		if (stopped) return;

		try {
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
				if (result !== "busy") {
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
		timer = setTimeout(() => {
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
		get lastRunAt() {
			return readLastSynthesisTime();
		},
		async triggerNow() {
			if (stopped) {
				return { success: false, skipped: true, reason: "Synthesis worker stopped" };
			}
			const lockToken = acquireWriteLock();
			if (lockToken === null) {
				return {
					success: false,
					skipped: true,
					reason: "Synthesis already in progress",
				};
			}

			try {
				const lastRun = readLastSynthesisTime();
				const elapsed = Date.now() - lastRun;

				if (elapsed < MIN_INTERVAL_MS) {
					const reason = `Too recent — last run ${Math.round(elapsed / 60000)}m ago, minimum is ${Math.round(MIN_INTERVAL_MS / 60000)}m`;
					logger.info("synthesis", "Skipping manual trigger", { reason });
					return { success: false, skipped: true, reason };
				}

				currentRunPromise = runSynthesis(config);
				const result = await currentRunPromise;
				if (result !== "busy") {
					writeLastSynthesisTime(Date.now());
				}
				return {
					success: result === "ok",
					skipped: result === "empty" || result === "busy",
					reason:
						result === "empty"
							? "No session summaries to synthesize"
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
