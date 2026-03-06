/**
 * Predictor state persistence across daemon restarts.
 *
 * Stores alpha, success rate, cold-start tracking, and session
 * counts in a per-agent JSON file.
 * Path: ~/.agents/memory/predictor/state-{agentId}.json
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { logger } from "./logger";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PredictorState {
	readonly successRate: number;
	readonly alpha: number;
	readonly sessionsAfterColdStart: number;
	readonly coldStartExited: boolean;
	readonly lastComparisonAt: string | null;
	readonly lastTrainingAt: string | null;
}

const DEFAULT_STATE: PredictorState = {
	successRate: 0.5,
	alpha: 1.0,
	sessionsAfterColdStart: 0,
	coldStartExited: false,
	lastComparisonAt: null,
	lastTrainingAt: null,
};

// ---------------------------------------------------------------------------
// File path — scoped by agent_id per cross-cutting invariant #1
// ---------------------------------------------------------------------------

function statePath(agentId: string): string {
	const safeId = agentId.replace(/[/\\]/g, "_").replace(/\.\./g, "_");
	const agentsDir = process.env.SIGNET_PATH || join(homedir(), ".agents");
	return join(agentsDir, "memory", "predictor", `state-${safeId}.json`);
}

// ---------------------------------------------------------------------------
// Runtime validation
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null;
}

function parseState(raw: unknown): PredictorState {
	if (!isRecord(raw)) return { ...DEFAULT_STATE };
	return {
		successRate:
			typeof raw.successRate === "number" && Number.isFinite(raw.successRate)
				? Math.max(0, Math.min(1, raw.successRate))
				: DEFAULT_STATE.successRate,
		alpha:
			typeof raw.alpha === "number" && Number.isFinite(raw.alpha)
				? Math.max(0, Math.min(1, raw.alpha))
				: DEFAULT_STATE.alpha,
		sessionsAfterColdStart:
			typeof raw.sessionsAfterColdStart === "number" &&
			Number.isFinite(raw.sessionsAfterColdStart)
				? Math.max(0, Math.floor(raw.sessionsAfterColdStart))
				: DEFAULT_STATE.sessionsAfterColdStart,
		coldStartExited:
			typeof raw.coldStartExited === "boolean"
				? raw.coldStartExited
				: DEFAULT_STATE.coldStartExited,
		lastComparisonAt:
			typeof raw.lastComparisonAt === "string"
				? raw.lastComparisonAt
				: DEFAULT_STATE.lastComparisonAt,
		lastTrainingAt:
			typeof raw.lastTrainingAt === "string"
				? raw.lastTrainingAt
				: DEFAULT_STATE.lastTrainingAt,
	};
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Load persisted predictor state for the given agent. Returns defaults if file missing. */
export function getPredictorState(agentId: string): PredictorState {
	const path = statePath(agentId);
	if (!existsSync(path)) return { ...DEFAULT_STATE };
	try {
		const content = readFileSync(path, "utf-8");
		return parseState(JSON.parse(content));
	} catch {
		logger.warn("predictor", "Failed to read predictor state, using defaults");
		return { ...DEFAULT_STATE };
	}
}

/** Merge partial updates into persisted predictor state for the given agent. */
export function updatePredictorState(
	agentId: string,
	update: Partial<PredictorState>,
): void {
	const current = getPredictorState(agentId);
	const next: PredictorState = {
		successRate: update.successRate ?? current.successRate,
		alpha: update.alpha ?? current.alpha,
		sessionsAfterColdStart:
			update.sessionsAfterColdStart ?? current.sessionsAfterColdStart,
		coldStartExited: update.coldStartExited ?? current.coldStartExited,
		lastComparisonAt:
			update.lastComparisonAt ?? current.lastComparisonAt,
		lastTrainingAt:
			update.lastTrainingAt ?? current.lastTrainingAt,
	};

	const path = statePath(agentId);
	try {
		const dir = dirname(path);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
		writeFileSync(path, JSON.stringify(next, null, 2), "utf-8");
	} catch (err) {
		logger.warn("predictor", "Failed to write predictor state", {
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

/**
 * Compute the effective alpha floor based on early active ramp.
 *
 * After cold start exit:
 * - Sessions 1-10:  alpha floor = 0.8 (max predictor influence = 0.2)
 * - Sessions 11-20: alpha floor = 0.6 (max predictor influence = 0.4)
 * - Sessions 21+:   no floor (alpha determined solely by success rate)
 */
export function getAlphaFloor(sessionsAfterColdStart: number): number {
	if (sessionsAfterColdStart <= 10) return 0.8;
	if (sessionsAfterColdStart <= 20) return 0.6;
	return 0;
}

/**
 * Compute the effective alpha to use for RRF fusion.
 *
 * During cold start:  always 1.0 (pure baseline)
 * After cold start:   max(alphaFloor, 1 - successRate)
 *
 * Sprint 3 will update successRate via EMA. For now it stays at
 * 0.5 (the default), meaning alpha = max(floor, 0.5).
 */
export function computeEffectiveAlpha(state: PredictorState): number {
	if (!state.coldStartExited) return 1.0;
	const floor = getAlphaFloor(state.sessionsAfterColdStart);
	const fromSuccessRate = 1.0 - state.successRate;
	return Math.max(floor, fromSuccessRate);
}
