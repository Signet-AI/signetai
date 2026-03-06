import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { runMigrations } from "../../core/src/migrations";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEST_DIR = join(tmpdir(), `signet-predictor-comparison-${Date.now()}`);
process.env.SIGNET_PATH = TEST_DIR;

const { closeDbAccessor, getDbAccessor, initDbAccessor } = await import("./db-accessor");
const {
	computeNdcg,
	computeFtsOverlapScore,
	runSessionComparison,
	updateSuccessRate,
	shouldTriggerTraining,
	detectDrift,
} = await import("./predictor-comparison");
const { recordComparison } = await import("./predictor-comparisons");
const { getPredictorState, updatePredictorState } = await import("./predictor-state");
const { evaluateColdStartExit } = await import("./predictor-scoring");

function ensureDir(path: string): void {
	mkdirSync(path, { recursive: true });
}

function setupDb(): Database {
	const dbPath = join(TEST_DIR, "memory", "memories.db");
	ensureDir(join(TEST_DIR, "memory"));
	if (existsSync(dbPath)) rmSync(dbPath);

	const db = new Database(dbPath);
	runMigrations(db as Parameters<typeof runMigrations>[0]);
	closeDbAccessor();
	initDbAccessor(dbPath);
	return db;
}

let db: Database;

beforeEach(() => {
	if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
	ensureDir(TEST_DIR);
	db = setupDb();
});

afterEach(() => {
	if (db) db.close();
	closeDbAccessor();
	if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// NDCG computation
// ---------------------------------------------------------------------------

describe("computeNdcg", () => {
	it("returns 1.0 for a perfect ranking", () => {
		const ranking = ["a", "b", "c"];
		const relevance = new Map([
			["a", 1.0],
			["b", 0.8],
			["c", 0.5],
		]);
		const ndcg = computeNdcg(ranking, relevance, 3);
		expect(ndcg).toBeCloseTo(1.0, 5);
	});

	it("returns less than 1.0 for a suboptimal ranking", () => {
		const ranking = ["c", "b", "a"]; // worst-first
		const relevance = new Map([
			["a", 1.0],
			["b", 0.5],
			["c", 0.1],
		]);
		const ndcg = computeNdcg(ranking, relevance, 3);
		expect(ndcg).toBeLessThan(1.0);
		expect(ndcg).toBeGreaterThan(0);
	});

	it("returns 0 when all relevance scores are 0", () => {
		const ranking = ["a", "b", "c"];
		const relevance = new Map([
			["a", 0],
			["b", 0],
			["c", 0],
		]);
		const ndcg = computeNdcg(ranking, relevance, 3);
		expect(ndcg).toBe(0);
	});

	it("returns 0 for empty ranking", () => {
		const relevance = new Map([["a", 1.0]]);
		expect(computeNdcg([], relevance, 10)).toBe(0);
	});

	it("handles k larger than ranking length", () => {
		const ranking = ["a"];
		const relevance = new Map([
			["a", 1.0],
			["b", 0.5],
		]);
		const ndcg = computeNdcg(ranking, relevance, 10);
		// Only one item in ranking, so DCG uses just "a"
		// IDCG uses both sorted desc
		expect(ndcg).toBeGreaterThan(0);
		expect(ndcg).toBeLessThanOrEqual(1.0);
	});

	it("handles missing relevance scores as 0", () => {
		const ranking = ["a", "b", "unknown"];
		const relevance = new Map([
			["a", 1.0],
			["b", 0.5],
		]);
		const ndcg = computeNdcg(ranking, relevance, 3);
		// "unknown" treated as 0 relevance
		expect(ndcg).toBeCloseTo(1.0, 5);
	});
});

// ---------------------------------------------------------------------------
// FTS overlap
// ---------------------------------------------------------------------------

describe("computeFtsOverlapScore", () => {
	it("computes the fraction of injected memories with FTS hits", () => {
		const mems = [
			{ memory_id: "a", source: "effective", effective_score: 1, predictor_score: null, was_injected: 1, relevance_score: null, fts_hit_count: 3, entity_slot: null, is_constraint: 0 },
			{ memory_id: "b", source: "effective", effective_score: 0.5, predictor_score: null, was_injected: 1, relevance_score: null, fts_hit_count: 0, entity_slot: null, is_constraint: 0 },
			{ memory_id: "c", source: "effective", effective_score: 0.3, predictor_score: null, was_injected: 0, relevance_score: null, fts_hit_count: 5, entity_slot: null, is_constraint: 0 },
		] as const;
		const injected = new Set(["a", "b"]);
		const score = computeFtsOverlapScore(mems, injected);
		expect(score).toBeCloseTo(0.5, 5); // 1 of 2 injected had FTS hits
	});

	it("returns 0 when no memories are injected", () => {
		expect(computeFtsOverlapScore([], new Set())).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// EMA update
// ---------------------------------------------------------------------------

describe("updateSuccessRate", () => {
	it("increases rate on a win with sufficient confidence", () => {
		updatePredictorState("test-agent", { successRate: 0.5 });
		const updated = updateSuccessRate("test-agent", true, 0.8);
		expect(updated).toBe(true);
		const state = getPredictorState("test-agent");
		// EMA: 0.1 * 1 + 0.9 * 0.5 = 0.55
		expect(state.successRate).toBeCloseTo(0.55, 5);
	});

	it("decreases rate on a loss with sufficient confidence", () => {
		updatePredictorState("test-agent", { successRate: 0.5 });
		const updated = updateSuccessRate("test-agent", false, 0.8);
		expect(updated).toBe(true);
		const state = getPredictorState("test-agent");
		// EMA: 0.1 * 0 + 0.9 * 0.5 = 0.45
		expect(state.successRate).toBeCloseTo(0.45, 5);
	});

	it("does NOT update when confidence is below threshold", () => {
		updatePredictorState("test-agent", { successRate: 0.5 });
		const updated = updateSuccessRate("test-agent", true, 0.3);
		expect(updated).toBe(false);
		const state = getPredictorState("test-agent");
		expect(state.successRate).toBeCloseTo(0.5, 5);
	});

	it("success rate stays within [0, 1]", () => {
		updatePredictorState("test-agent", { successRate: 0.99 });
		updateSuccessRate("test-agent", true, 0.9);
		const state = getPredictorState("test-agent");
		expect(state.successRate).toBeLessThanOrEqual(1.0);
		expect(state.successRate).toBeGreaterThanOrEqual(0);
	});
});

// ---------------------------------------------------------------------------
// Cold start condition 3
// ---------------------------------------------------------------------------

describe("evaluateColdStartExit condition 3", () => {
	it("blocks exit when successRate <= 0.4", () => {
		const status = { trained: true, training_pairs: 100, model_version: 1, last_trained: null };
		const state = {
			successRate: 0.3,
			alpha: 0.7,
			sessionsAfterColdStart: 0,
			coldStartExited: false,
			lastComparisonAt: null,
			lastTrainingAt: null,
		};
		expect(evaluateColdStartExit(status, 10, state)).toBe(false);
	});

	it("allows exit when successRate > 0.4 and other conditions met", () => {
		const status = { trained: true, training_pairs: 100, model_version: 1, last_trained: null };
		const state = {
			successRate: 0.5,
			alpha: 0.5,
			sessionsAfterColdStart: 0,
			coldStartExited: false,
			lastComparisonAt: null,
			lastTrainingAt: null,
		};
		expect(evaluateColdStartExit(status, 10, state)).toBe(true);
	});

	it("always returns true if already exited", () => {
		const status = { trained: true, training_pairs: 100, model_version: 1, last_trained: null };
		const state = {
			successRate: 0.1,
			alpha: 0.9,
			sessionsAfterColdStart: 5,
			coldStartExited: true,
			lastComparisonAt: null,
			lastTrainingAt: null,
		};
		expect(evaluateColdStartExit(status, 10, state)).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Training trigger
// ---------------------------------------------------------------------------

describe("shouldTriggerTraining", () => {
	it("triggers when enough comparisons accumulated", () => {
		const accessor = getDbAccessor();
		const config = {
			enabled: true,
			trainIntervalSessions: 3,
			minTrainingSessions: 10,
			scoreTimeoutMs: 5000,
			trainTimeoutMs: 30000,
			crashDisableThreshold: 3,
			rrfK: 12,
			explorationRate: 0.1,
			driftResetWindow: 20,
		};

		// No training yet, lastTrainingAt is null → counts all comparisons
		updatePredictorState("train-agent", { lastTrainingAt: null });

		// Insert enough comparisons
		for (let i = 0; i < 3; i++) {
			recordComparison(accessor, {
				sessionKey: `session-${i}`,
				agentId: "train-agent",
				predictorNdcg: 0.8,
				baselineNdcg: 0.6,
				predictorWon: true,
				margin: 0.2,
				alpha: 0.5,
				emaUpdated: true,
				candidateCount: 10,
				traversalCount: 0,
				constraintCount: 0,
			});
		}

		expect(shouldTriggerTraining("train-agent", config, accessor)).toBe(true);
	});

	it("does not trigger when insufficient comparisons", () => {
		const accessor = getDbAccessor();
		const config = {
			enabled: true,
			trainIntervalSessions: 10,
			minTrainingSessions: 10,
			scoreTimeoutMs: 5000,
			trainTimeoutMs: 30000,
			crashDisableThreshold: 3,
			rrfK: 12,
			explorationRate: 0.1,
			driftResetWindow: 20,
		};

		updatePredictorState("no-train-agent", { lastTrainingAt: null });
		recordComparison(accessor, {
			sessionKey: "session-0",
			agentId: "no-train-agent",
			predictorNdcg: 0.5,
			baselineNdcg: 0.5,
			predictorWon: false,
			margin: 0,
			alpha: 0.5,
			emaUpdated: false,
			candidateCount: 5,
			traversalCount: 0,
			constraintCount: 0,
		});

		expect(shouldTriggerTraining("no-train-agent", config, accessor)).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Drift detection
// ---------------------------------------------------------------------------

describe("detectDrift", () => {
	it("flags drifting when win rate is below threshold over full window", () => {
		const accessor = getDbAccessor();

		// Insert a window of all losses
		for (let i = 0; i < 10; i++) {
			recordComparison(accessor, {
				sessionKey: `drift-session-${i}`,
				agentId: "drift-agent",
				predictorNdcg: 0.3,
				baselineNdcg: 0.5,
				predictorWon: false,
				margin: -0.2,
				alpha: 0.5,
				emaUpdated: true,
				candidateCount: 10,
				traversalCount: 0,
				constraintCount: 0,
			});
		}

		const result = detectDrift("drift-agent", accessor, 10);
		expect(result.drifting).toBe(true);
		expect(result.recentWinRate).toBe(0);
	});

	it("does not flag drifting when win rate is healthy", () => {
		const accessor = getDbAccessor();

		// Insert a window of all wins
		for (let i = 0; i < 10; i++) {
			recordComparison(accessor, {
				sessionKey: `healthy-session-${i}`,
				agentId: "healthy-agent",
				predictorNdcg: 0.8,
				baselineNdcg: 0.5,
				predictorWon: true,
				margin: 0.3,
				alpha: 0.3,
				emaUpdated: true,
				candidateCount: 10,
				traversalCount: 0,
				constraintCount: 0,
			});
		}

		const result = detectDrift("healthy-agent", accessor, 10);
		expect(result.drifting).toBe(false);
		expect(result.recentWinRate).toBe(1.0);
	});

	it("does not flag drifting when window is not full", () => {
		const accessor = getDbAccessor();

		// Only 3 comparisons but window is 10 → not enough data
		for (let i = 0; i < 3; i++) {
			recordComparison(accessor, {
				sessionKey: `partial-session-${i}`,
				agentId: "partial-agent",
				predictorNdcg: 0.3,
				baselineNdcg: 0.5,
				predictorWon: false,
				margin: -0.2,
				alpha: 0.5,
				emaUpdated: true,
				candidateCount: 10,
				traversalCount: 0,
				constraintCount: 0,
			});
		}

		const result = detectDrift("partial-agent", accessor, 10);
		expect(result.drifting).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Session comparison integration
// ---------------------------------------------------------------------------

describe("runSessionComparison", () => {
	it("returns null when no session scores exist", () => {
		const result = runSessionComparison("nonexistent", "default", getDbAccessor());
		expect(result).toBeNull();
	});

	it("computes comparison when session data exists", () => {
		const accessor = getDbAccessor();
		const sessionKey = "test-session-1";

		// Insert session_scores
		accessor.withWriteTx((wdb) => {
			wdb.prepare(
				`INSERT INTO session_scores
				 (id, session_key, score, confidence, project, created_at)
				 VALUES (?, ?, ?, ?, ?, ?)`,
			).run("score-1", sessionKey, 0.8, 0.9, "signetai", new Date().toISOString());
		});

		// Insert session_memories with relevance scores
		accessor.withWriteTx((wdb) => {
			const now = new Date().toISOString();
			const stmt = wdb.prepare(
				`INSERT INTO session_memories
				 (id, session_key, memory_id, source, effective_score,
				  predictor_score, final_score, rank, was_injected,
				  relevance_score, fts_hit_count, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			);

			// Memory A: high effective, high predictor, high relevance
			stmt.run("sm-1", sessionKey, "mem-a", "effective", 0.9, 0.85, 0.9, 0, 1, 0.95, 2, now);
			// Memory B: medium effective, low predictor, medium relevance
			stmt.run("sm-2", sessionKey, "mem-b", "effective", 0.7, 0.3, 0.7, 1, 1, 0.6, 0, now);
			// Memory C: low effective, high predictor, high relevance
			stmt.run("sm-3", sessionKey, "mem-c", "effective", 0.3, 0.9, 0.3, 2, 0, 0.8, 1, now);
		});

		const result = runSessionComparison(sessionKey, "default", accessor);

		expect(result).not.toBeNull();
		if (result === null) return;

		expect(result.sessionKey).toBe(sessionKey);
		expect(result.hasPredictorScores).toBe(true);
		expect(result.candidateCount).toBe(3);
		expect(result.scorerConfidence).toBeCloseTo(0.9, 5);
		expect(result.baselineNdcg).toBeGreaterThan(0);
		expect(result.predictorNdcg).toBeGreaterThan(0);
		expect(typeof result.predictorWon).toBe("boolean");
		expect(result.ftsOverlapScore).toBeCloseTo(0.5, 5); // 1 of 2 injected had FTS hits
		expect(result.project).toBe("signetai");
	});

	it("handles sessions with no predictor scores (cold start)", () => {
		const accessor = getDbAccessor();
		const sessionKey = "cold-session";

		accessor.withWriteTx((wdb) => {
			wdb.prepare(
				`INSERT INTO session_scores
				 (id, session_key, score, confidence, created_at)
				 VALUES (?, ?, ?, ?, ?)`,
			).run("score-cold", sessionKey, 0.7, 0.8, new Date().toISOString());
		});

		accessor.withWriteTx((wdb) => {
			const now = new Date().toISOString();
			wdb.prepare(
				`INSERT INTO session_memories
				 (id, session_key, memory_id, source, effective_score,
				  final_score, rank, was_injected, relevance_score,
				  fts_hit_count, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			).run("sm-cold-1", sessionKey, "mem-x", "effective", 0.8, 0.8, 0, 1, 0.7, 0, now);
		});

		const result = runSessionComparison(sessionKey, "default", accessor);

		expect(result).not.toBeNull();
		if (result === null) return;

		expect(result.hasPredictorScores).toBe(false);
		expect(result.predictorNdcg).toBe(0);
		expect(result.predictorWon).toBe(false);
		expect(result.baselineNdcg).toBeGreaterThan(0);
	});
});
