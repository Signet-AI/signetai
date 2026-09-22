import { logger } from "./logger";
import { type PressureRecoveryOutcome, getRuntimePressureEnvelope } from "./runtime-pressure";
import { getActiveTelemetry } from "./telemetry";

export type PressureLevel = "normal" | "elevated" | "critical";

const ELEVATED_THRESHOLD_MS = 100;
const CRITICAL_THRESHOLD_MS = 500;
const CLEAR_COOLDOWN_MS = 5_000;

let currentLevel: PressureLevel = "normal";
let lastLagAt = 0;
let startupGraceUntil = 0;
let recoveryOutcome: PressureRecoveryOutcome = "not_observed";
export function reportStartupGrace(durationMs = 10_000): void {
	startupGraceUntil = Date.now() + durationMs;
	if (currentLevel === "normal") currentLevel = "elevated";
	logger.info(
		"system-pressure",
		`Startup grace period active for ${Math.round(durationMs / 1000)}s — background workers deferred`,
	);
}
const EVENT_LOOP_WEDGE_COOLDOWN_MS = 10 * 60 * 1000;
let lastWedgeEmitAt = 0;
function reportEventLoopWedge(lagMs: number, now: number): void {
	if (lastWedgeEmitAt !== 0 && now - lastWedgeEmitAt < EVENT_LOOP_WEDGE_COOLDOWN_MS) return;
	const telemetry = getActiveTelemetry();
	if (!telemetry) return;
	const properties = {
		type: "EventLoopLag",
		message: `event loop critically blocked for ${Math.round(lagMs)}ms`,
		lagMs: Math.round(lagMs),
		...getRuntimePressureEnvelope(now),
		recoveryOutcome,
	};
	if (telemetry.recordDeferred) {
		telemetry.recordDeferred("error.occurred", properties);
	} else {
		telemetry.record("error.occurred", properties);
	}
	lastWedgeEmitAt = now;
}
function schedulePressureWarning(message: string): void {
	setImmediate(() => logger.warn("system-pressure", message));
}

export function reportEventLoopLag(lagMs: number, now: number = Date.now()): void {
	if (lagMs >= CRITICAL_THRESHOLD_MS) {
		recoveryOutcome = "still_degraded";
		reportEventLoopWedge(lagMs, now);
		if (currentLevel !== "critical") {
			schedulePressureWarning(`Event loop critically blocked (${lagMs}ms) — background work should pause`);
		}
		currentLevel = "critical";
		lastLagAt = now;
	} else if (lagMs >= ELEVATED_THRESHOLD_MS) {
		recoveryOutcome = "still_degraded";
		if (currentLevel === "normal") {
			schedulePressureWarning(`Event loop degraded (${lagMs}ms) — background work yielding`);
		}
		if (currentLevel !== "critical") currentLevel = "elevated";
		lastLagAt = now;
	}
}
export function tickPressureState(): void {
	const now = Date.now();
	if (startupGraceUntil !== 0 && now >= startupGraceUntil) {
		startupGraceUntil = 0;
	}
	if (currentLevel !== "normal" && now >= startupGraceUntil && now - lastLagAt > CLEAR_COOLDOWN_MS) {
		currentLevel = "normal";
		recoveryOutcome = "recovered";
	}
}
export function getSystemPressure(): PressureLevel {
	return currentLevel;
}
export function isSystemPressureHigh(): boolean {
	return currentLevel !== "normal";
}
export function getPressureRecoveryOutcome(): PressureRecoveryOutcome {
	return recoveryOutcome;
}
export function resetPressureState(): void {
	currentLevel = "normal";
	lastLagAt = 0;
	startupGraceUntil = 0;
	recoveryOutcome = "not_observed";
	lastWedgeEmitAt = 0;
}
export async function awaitPressureClear(timeoutMs = 30_000): Promise<boolean> {
	if (currentLevel === "normal") return true;
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		await new Promise<void>((resolve) => setTimeout(resolve, 500));
		tickPressureState();
		if (getSystemPressure() === "normal") return true;
	}
	recoveryOutcome = "still_degraded";
	logger.warn("system-pressure", `Pressure did not clear within ${timeoutMs}ms — proceeding`);
	return false;
}
