import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { runMigrations } from "../../core/src/migrations";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEST_DIR = join(tmpdir(), `signet-predictor-comparisons-${Date.now()}`);
process.env.SIGNET_PATH = TEST_DIR;

const { closeDbAccessor, getDbAccessor, initDbAccessor } = await import("./db-accessor");
const {
	getComparisonsByEntity,
	getComparisonsByProject,
	listComparisons,
	listTrainingRuns,
	recordComparison,
	recordTrainingRun,
} = await import("./predictor-comparisons");

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

describe("predictor comparison helpers", () => {
	it("records and filters comparison rows", () => {
		recordComparison(getDbAccessor(), {
			sessionKey: "session-1",
			agentId: "default",
			predictorNdcg: 0.8,
			baselineNdcg: 0.6,
			predictorWon: true,
			margin: 0.2,
			alpha: 0.1,
			emaUpdated: false,
			focalEntityId: "entity-1",
			focalEntityName: "Signet",
			project: "signetai",
			candidateCount: 10,
			traversalCount: 4,
			constraintCount: 2,
		});
		recordComparison(getDbAccessor(), {
			sessionKey: "session-2",
			agentId: "default",
			predictorNdcg: 0.4,
			baselineNdcg: 0.5,
			predictorWon: false,
			margin: -0.1,
			alpha: 0.2,
			emaUpdated: true,
			focalEntityId: "entity-2",
			focalEntityName: "Other",
			project: "other",
			candidateCount: 6,
			traversalCount: 1,
			constraintCount: 0,
		});

		const filtered = listComparisons(getDbAccessor(), {
			agentId: "default",
			project: "signetai",
			limit: 50,
			offset: 0,
		});

		expect(filtered.total).toBe(1);
		expect(filtered.rows[0]?.sessionKey).toBe("session-1");
		expect(filtered.rows[0]?.predictorWon).toBe(true);
	});

	it("aggregates by project and entity", () => {
		recordComparison(getDbAccessor(), {
			sessionKey: "session-1",
			agentId: "default",
			predictorNdcg: 0.8,
			baselineNdcg: 0.6,
			predictorWon: true,
			margin: 0.2,
			alpha: 0.1,
			emaUpdated: false,
			focalEntityId: "entity-1",
			focalEntityName: "Signet",
			project: "signetai",
			candidateCount: 10,
			traversalCount: 4,
			constraintCount: 2,
		});
		recordComparison(getDbAccessor(), {
			sessionKey: "session-2",
			agentId: "default",
			predictorNdcg: 0.7,
			baselineNdcg: 0.5,
			predictorWon: true,
			margin: 0.2,
			alpha: 0.1,
			emaUpdated: false,
			focalEntityId: "entity-1",
			focalEntityName: "Signet",
			project: "signetai",
			candidateCount: 9,
			traversalCount: 3,
			constraintCount: 1,
		});
		recordComparison(getDbAccessor(), {
			sessionKey: "session-3",
			agentId: "default",
			predictorNdcg: 0.4,
			baselineNdcg: 0.5,
			predictorWon: false,
			margin: -0.1,
			alpha: 0.2,
			emaUpdated: true,
			focalEntityId: "entity-2",
			focalEntityName: "Other",
			project: "other",
			candidateCount: 6,
			traversalCount: 1,
			constraintCount: 0,
		});

		const byProject = getComparisonsByProject(getDbAccessor(), "default");
		const byEntity = getComparisonsByEntity(getDbAccessor(), "default");

		expect(byProject[0]?.project).toBe("signetai");
		expect(byProject[0]?.wins).toBe(2);
		expect(byEntity[0]?.entityId).toBe("entity-1");
		expect(byEntity[0]?.wins).toBe(2);
	});

	it("records and lists training runs", () => {
		recordTrainingRun(getDbAccessor(), {
			agentId: "default",
			modelVersion: 3,
			loss: 0.42,
			sampleCount: 12,
			durationMs: 900,
			canaryNdcg: 0.71,
			canaryNdcgDelta: 0.05,
			canaryScoreVariance: 0.02,
			canaryTopkChurn: 0.1,
		});

		const runs = listTrainingRuns(getDbAccessor(), "default", 10);
		expect(runs).toHaveLength(1);
		expect(runs[0]?.modelVersion).toBe(3);
		expect(runs[0]?.loss).toBeCloseTo(0.42, 5);
	});
});
