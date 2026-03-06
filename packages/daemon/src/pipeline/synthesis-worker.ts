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
import type { PipelineSynthesisConfig } from "../memory-config";
import { handleSynthesisRequest, writeMemoryMd } from "../hooks";
import { getSynthesisProvider } from "../synthesis-llm";
import { logger } from "../logger";
import { getDbAccessor } from "../db-accessor";
import { activeSessionCount } from "../session-tracker";
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
 * Returns 0 if no session-end checkpoints exist.
 */
function getLastSessionEndTime(): number {
	try {
		const row = getDbAccessor().withReadDb((db) => {
			return db.prepare(`
				SELECT MAX(created_at) as last_end
				FROM session_checkpoints
				WHERE trigger = 'session_end'
			`).get() as { last_end: string | null } | undefined;
		});
		if (!row?.last_end) return 0;
		return new Date(row.last_end).getTime();
	} catch {
		return 0;
	}
}

// ---------------------------------------------------------------------------
// Core synthesis execution
// ---------------------------------------------------------------------------

type SynthesisResult = "ok" | "empty" | "failed";

async function runSynthesis(config: PipelineSynthesisConfig): Promise<SynthesisResult> {
	logger.info("synthesis", "Starting scheduled synthesis", {
		provider: config.provider,
		model: config.model,
	});

	try {
		const lastRun = readLastSynthesisTime();

		// Only use incremental merge when MEMORY.md exists to merge into;
		// if the file was deleted, fall back to full regeneration so no
		// memories older than lastRun are silently omitted.
		const memoryMdExists = existsSync(join(getAgentsDir(), "MEMORY.md"));
		const synthesisData = handleSynthesisRequest(
			{ trigger: "scheduled" },
			{
				maxTokens: config.maxTokens,
				sinceTimestamp: lastRun > 0 && memoryMdExists ? lastRun : undefined,
			},
		);

		if (synthesisData.fileCount === 0) {
			logger.info("synthesis", "No session summaries to synthesize, skipping");
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
				logger.error("synthesis", "LLM returned JSON instead of markdown, skipping write",
					undefined, { preview: trimmed.slice(0, 200) });
				return "failed";
			} catch {
				// Not valid JSON — markdown starting with [ or { is fine
			}
		}

		// Write MEMORY.md via shared helper (handles backup)
		writeMemoryMd(result.text);

		logger.info("synthesis", "MEMORY.md synthesized", {
			sessionFiles: synthesisData.fileCount,
			outputLength: result.text.length,
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
	drain(): Promise<void>;
	acquireWriteLock(): boolean;
	releaseWriteLock(): void;
	readonly running: boolean;
	readonly isSynthesizing: boolean;
	/** Trigger an immediate synthesis (e.g. from API). */
	triggerNow(): Promise<{ success: boolean; skipped: boolean; reason?: string }>;
	/** Last synthesis timestamp. */
	readonly lastRunAt: number;
}

export function startSynthesisWorker(
	config: PipelineSynthesisConfig,
): SynthesisWorkerHandle {
	let timer: ReturnType<typeof setTimeout> | null = null;
	let stopped = false;
	let isSynthesizing = false;
	let currentRunPromise: Promise<SynthesisResult> | null = null;
	const idleGapMs = config.idleGapMinutes * 60 * 1000;

	function acquireWriteLock(): boolean {
		if (stopped) return false;
		if (isSynthesizing) return false;
		isSynthesizing = true;
		return true;
	}

	function releaseWriteLock(): void {
		isSynthesizing = false;
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

			if (!acquireWriteLock()) {
				scheduleTick(CHECK_INTERVAL_MS);
				return;
			}

			try {
				currentRunPromise = runSynthesis(config);
				await currentRunPromise;
				// Write timestamp on both success and failure to prevent
				// rapid retry loops (next attempt waits MIN_INTERVAL_MS)
				writeLastSynthesisTime(Date.now());
			} finally {
				currentRunPromise = null;
				releaseWriteLock();
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
			if (!currentRunPromise) return;
			let timeoutId: ReturnType<typeof setTimeout> | null = null;
			try {
				await Promise.race([
					currentRunPromise.then(() => undefined),
					new Promise<void>((resolve) => {
						timeoutId = setTimeout(() => {
							logger.warn("synthesis", "drain() timed out waiting for in-flight synthesis");
							resolve();
						}, config.timeout + DRAIN_TIMEOUT_BUFFER_MS);
					}),
				]);
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
			if (!acquireWriteLock()) {
				return {
					success: false,
					skipped: true,
					reason: stopped ? "Synthesis worker stopped" : "Synthesis already in progress",
				};
			}

			const lastRun = readLastSynthesisTime();
			const elapsed = Date.now() - lastRun;

			if (elapsed < MIN_INTERVAL_MS) {
				const reason = `Too recent — last run ${Math.round(elapsed / 60000)}m ago, minimum is ${Math.round(MIN_INTERVAL_MS / 60000)}m`;
				logger.info("synthesis", "Skipping manual trigger", { reason });
				releaseWriteLock();
				return { success: false, skipped: true, reason };
			}

			try {
				currentRunPromise = runSynthesis(config);
				const result = await currentRunPromise;
				// Write timestamp on both success and failure to prevent
				// rapid retry loops (next attempt waits MIN_INTERVAL_MS)
				writeLastSynthesisTime(Date.now());
				return {
					success: result === "ok",
					skipped: result === "empty",
					reason: result === "empty" ? "No session summaries to synthesize" : undefined,
				};
			} finally {
				currentRunPromise = null;
				releaseWriteLock();
			}
		},
	};
}
