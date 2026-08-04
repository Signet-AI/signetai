/**
 * System pressure signal derived from event-loop lag.
 *
 * Background write loops (embedding promotion, extraction apply, dreaming,
 * maintenance) call {@link isSystemPressureHigh} between batches and pause
 * when the event loop is degraded. This converts the resource monitor from
 * a passive observer ("Event loop blocked" log lines) into an active
 * backpressure mechanism that prevents the #1059 death spiral: background
 * work yields when the system is struggling, instead of monopolizing the
 * thread until the watchdog kills the process.
 *
 * The signal is intentionally coarse — three levels, not a continuous score.
 * Background loops need a boolean gate, not a throttle curve. The cooldown
 * keeps pressure "elevated" briefly after the last detected lag so a loop
 * doesn't resume into a still-recovering event loop.
 */

import { logger } from "./logger";

export type PressureLevel = "normal" | "elevated" | "critical";

const ELEVATED_THRESHOLD_MS = 100;
const CRITICAL_THRESHOLD_MS = 500;
/** Stay elevated for this long after the last lag detection before clearing. */
const CLEAR_COOLDOWN_MS = 5_000;

let currentLevel: PressureLevel = "normal";
let lastLagAt = 0;
let startupGraceUntil = 0;

/**
 * Set a startup grace period during which background workers skip their ticks.
 * Called once after migrations complete and workers are about to start.
 * Prevents the thundering herd of all workers firing their first tick
 * simultaneously on a fresh daemon start before the event-loop monitor has
 * had time to calibrate.
 */
export function reportStartupGrace(durationMs = 10_000): void {
	startupGraceUntil = Date.now() + durationMs;
	if (currentLevel === "normal") currentLevel = "elevated";
	logger.info(
		"system-pressure",
		`Startup grace period active for ${Math.round(durationMs / 1000)}s — background workers deferred`,
	);
}

/**
 * Called by the event-loop monitor when it detects lag. The lag value is the
 * difference between the expected callback interval and the actual interval —
 * i.e. how long the event loop was blocked since the last tick.
 */
export function reportEventLoopLag(lagMs: number): void {
	if (lagMs >= CRITICAL_THRESHOLD_MS) {
		if (currentLevel !== "critical") {
			logger.warn("system-pressure", `Event loop critically blocked (${lagMs}ms) — background work should pause`);
		}
		currentLevel = "critical";
		lastLagAt = Date.now();
	} else if (lagMs >= ELEVATED_THRESHOLD_MS) {
		if (currentLevel === "normal") {
			logger.warn("system-pressure", `Event loop degraded (${lagMs}ms) — background work yielding`);
		}
		if (currentLevel !== "critical") currentLevel = "elevated";
		lastLagAt = Date.now();
	}
}

/** Current pressure level, auto-clearing after the cooldown if no new lag. */
export function getSystemPressure(): PressureLevel {
	// Startup grace: keep elevated until the grace period expires, regardless
	// of lag detection. The cooldown timer should not clear it early.
	if (Date.now() < startupGraceUntil) {
		return currentLevel === "normal" ? "elevated" : currentLevel;
	}
	if (Date.now() >= startupGraceUntil && startupGraceUntil !== 0) {
		startupGraceUntil = 0; // grace expired — fall through to normal cooldown logic
	}
	if (currentLevel !== "normal" && Date.now() - lastLagAt > CLEAR_COOLDOWN_MS) {
		currentLevel = "normal";
	}
	return currentLevel;
}

/** True when background work should pause to let the event loop recover. */
export function isSystemPressureHigh(): boolean {
	return getSystemPressure() !== "normal";
}

/**
 * Block until pressure clears or the timeout expires. Returns false on
 * timeout (the caller may proceed anyway — a delayed background pass is
 * better than a deadlocked one, and the watchdog will catch a true hang).
 */
export async function awaitPressureClear(timeoutMs = 30_000): Promise<boolean> {
	if (getSystemPressure() === "normal") return true;
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		await new Promise<void>((resolve) => setTimeout(resolve, 500));
		if (getSystemPressure() === "normal") return true;
	}
	logger.warn("system-pressure", `Pressure did not clear within ${timeoutMs}ms — proceeding`);
	return false;
}
