import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Buffer } from "node:buffer";
import type { DreamingConfig } from "@signet/core";
import { runMigrations } from "../../../core/src/migrations";
import type { DbAccessor, ReadDb } from "../db-accessor";
import { enqueueDreamingSurprisalAttention } from "./dreaming";
import {
	type DreamingSurprisalObservation,
	rankDreamingSurprisal,
	selectDreamingSurprisalInDb,
} from "./dreaming-surprisal";

const CONFIG = {
	enabled: true,
	sampleSize: 128,
	maxCandidates: 3,
	minObservations: 8,
	neighborCount: 3,
	treeLeafSize: 4,
	minScore: 0.75,
} as const;

const DREAMING_CONFIG: DreamingConfig = {
	tokenThreshold: 100_000,
	maxInterval: 6 * 60 * 60 * 1_000,
	timeout: 300_000,
	maxInputTokens: 32_000,
	maxOutputTokens: 16_000,
	backfillOnFirstRun: false,
	surprisal: CONFIG,
};

function wrapDb(db: Database): DbAccessor {
	return {
		withReadDb<T>(fn: (db: Database) => T): T {
			return fn(db);
		},
		withWriteTx<T>(fn: (db: Database) => T): T {
			db.exec("BEGIN IMMEDIATE");
			try {
				const result = fn(db);
				db.exec("COMMIT");
				return result;
			} catch (error) {
				db.exec("ROLLBACK");
				throw error;
			}
		},
	} as unknown as DbAccessor;
}

function vectorBlob(values: readonly number[]): Buffer {
	return Buffer.from(new Float32Array(values).buffer);
}

function makeObservations(): DreamingSurprisalObservation[] {
	const observations: DreamingSurprisalObservation[] = [];
	for (let index = 0; index < 19; index += 1) {
		observations.push({
			id: `cluster-${index}`,
			capturedAt: `2026-01-01T00:00:${String(index).padStart(2, "0")}.000Z`,
			vector: new Float32Array([1, (index % 3) * 0.001, ((index + 1) % 2) * 0.001]),
		});
	}
	observations.push({
		id: "semantic-outlier",
		capturedAt: "2026-01-01T00:01:00.000Z",
		vector: new Float32Array([-1, 0, 0]),
	});
	return observations;
}

function seedMemory(db: Database, agentId: string, id: string, values: readonly number[], createdAt: string): void {
	db.prepare(
		`INSERT INTO memories
			(id, type, content, agent_id, created_at, updated_at, updated_by, memory_kind)
		 VALUES (?, 'fact', ?, ?, ?, ?, 'test', 'episodic')`,
	).run(id, `${agentId}:${id}`, agentId, createdAt, createdAt);
	db.prepare(
		`INSERT INTO embeddings
			(id, content_hash, vector, dimensions, source_type, source_id, chunk_text, created_at, agent_id)
		 VALUES (?, ?, ?, ?, 'memory', ?, ?, ?, ?)`,
	).run(
		`embedding-${agentId}-${id}`,
		`hash-${agentId}-${id}`,
		vectorBlob(values),
		values.length,
		id,
		id,
		createdAt,
		agentId,
	);
}

describe("dreaming surprisal attention", () => {
	let db: Database;
	let accessor: DbAccessor;

	beforeEach(() => {
		db = new Database(":memory:");
		runMigrations(db as unknown as Parameters<typeof runMigrations>[0]);
		accessor = wrapDb(db);
	});

	afterEach(() => {
		db.close();
	});

	it("ranks a semantic outlier above a coherent embedding cluster", () => {
		const selection = rankDreamingSurprisal(makeObservations(), CONFIG, () => 1000);

		expect(selection.sampled).toBe(20);
		expect(selection.valid).toBe(20);
		expect(selection.embeddingRequests).toBe(0);
		expect(selection.embeddingTokens).toBe(0);
		expect(selection.embeddingCostUsd).toBe(0);
		expect(selection.candidates[0]?.id).toBe("semantic-outlier");
		expect(selection.candidates[0]?.score).toBeGreaterThanOrEqual(CONFIG.minScore);
		expect(selection.candidates.length).toBeLessThanOrEqual(CONFIG.maxCandidates);
		expect(selection.candidates.every((candidate) => candidate.score >= 0 && candidate.score <= 1)).toBe(true);
	});

	it("fails open when the sample is too small or has no valid vectors", () => {
		const tooSmall = rankDreamingSurprisal(makeObservations().slice(0, 7), CONFIG);
		expect(tooSmall.candidates).toEqual([]);
		expect(tooSmall.skippedReason).toBe("too_few_observations");

		const invalid = rankDreamingSurprisal(
			[{ id: "bad", capturedAt: "2026-01-01T00:00:00.000Z", vector: new Float32Array([Number.NaN, 0]) }],
			CONFIG,
		);
		expect(invalid.candidates).toEqual([]);
		expect(invalid.skippedReason).toBe("no_valid_vectors");
	});

	it("does not promote a uniform embedding sample into attention", () => {
		const observations = Array.from({ length: 12 }, (_, index) => ({
			id: `same-${index}`,
			capturedAt: `2026-01-01T00:00:${String(index).padStart(2, "0")}.000Z`,
			vector: new Float32Array([1, 0, 0]),
		}));

		const selection = rankDreamingSurprisal(observations, CONFIG);
		expect(selection.candidates).toEqual([]);
	});

	it("fails open when the embedding store is unavailable", () => {
		const unavailableDb = {
			prepare(): never {
				throw new Error("embedding store unavailable");
			},
		} as unknown as ReadDb;

		const selection = selectDreamingSurprisalInDb(unavailableDb, "default", CONFIG, null);
		expect(selection.candidates).toEqual([]);
		expect(selection.skippedReason).toBe("embedding_store_unavailable");
	});

	it("reads only the bounded agent-scoped primary embedding sample", () => {
		const observations = makeObservations();
		for (const observation of observations) {
			seedMemory(db, "default", observation.id, [...observation.vector], observation.capturedAt);
		}
		seedMemory(db, "default", "malformed-dimensions", [0, 1, 0], "2026-01-01T00:01:30.000Z");
		db.prepare("UPDATE embeddings SET dimensions = 99 WHERE source_id = 'malformed-dimensions'").run();
		seedMemory(db, "other-agent", "other-outlier", [-1, 0, 0], "2026-01-01T00:02:00.000Z");

		const selection = selectDreamingSurprisalInDb(db, "default", CONFIG, null);
		expect(selection.sampled).toBe(21);
		expect(selection.valid).toBe(20);
		expect(selection.candidates[0]?.id).toBe("semantic-outlier");
		expect(selection.candidates.some((candidate) => candidate.id === "other-outlier")).toBe(false);
	});

	it("queues hints without advancing the evidence cursor", () => {
		for (const observation of makeObservations()) {
			seedMemory(db, "default", observation.id, [...observation.vector], observation.capturedAt);
		}
		db.prepare(
			`INSERT INTO dreaming_state (agent_id, tokens_since_last_pass, evidence_cursor)
			 VALUES ('default', 0, 'cursor-sentinel')`,
		).run();

		const selection = enqueueDreamingSurprisalAttention(accessor, "default", DREAMING_CONFIG);
		expect(selection?.candidates[0]?.id).toBe("semantic-outlier");
		expect(
			db.prepare("SELECT kind, subject_ref, details_json FROM dreaming_attention WHERE agent_id = 'default'").all(),
		).toEqual(
			expect.arrayContaining([expect.objectContaining({ kind: "surprisal", subject_ref: "memory:semantic-outlier" })]),
		);
		expect(db.prepare("SELECT evidence_cursor FROM dreaming_state WHERE agent_id = 'default'").get()).toEqual({
			evidence_cursor: "cursor-sentinel",
		});
	});
});
