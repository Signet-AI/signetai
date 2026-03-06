/**
 * Tests for predictor training pair collection and export.
 *
 * Verifies:
 * - Feature vector extraction produces expected values
 * - Label computation follows the formula correctly
 * - Export returns valid data
 * - Privacy: no memory content leaks into training pairs
 * - Retention cleanup works
 */

import { Database } from "bun:sqlite";
import { describe, expect, it, beforeEach } from "bun:test";
import {
	computeCombinedLabel,
	collectTrainingPairs,
	saveTrainingPairs,
	exportTrainingPairs,
	purgeOldTrainingPairs,
} from "./predictor-training-pairs";
import type { DbAccessor, WriteDb, ReadDb } from "./db-accessor";
import {
	runMigrations,
} from "@signet/core";

// ---------------------------------------------------------------------------
// Test DB helper
// ---------------------------------------------------------------------------

function createTestDb(): { db: Database; accessor: DbAccessor } {
	const db = new Database(":memory:");
	db.exec("PRAGMA journal_mode = WAL");
	db.exec("PRAGMA busy_timeout = 5000");

	// Run all migrations to get the schema
	runMigrations(db);

	const accessor: DbAccessor = {
		withWriteTx<T>(fn: (db: WriteDb) => T): T {
			db.exec("BEGIN IMMEDIATE");
			try {
				const result = fn(db);
				db.exec("COMMIT");
				return result;
			} catch (err) {
				db.exec("ROLLBACK");
				throw err;
			}
		},
		withReadDb<T>(fn: (db: ReadDb) => T): T {
			return fn(db);
		},
		close(): void {
			db.close();
		},
	};

	return { db, accessor };
}

function insertMemory(
	db: Database,
	id: string,
	content: string,
	opts: {
		importance?: number;
		accessCount?: number;
		createdAt?: string;
	} = {},
): void {
	const now = new Date().toISOString();
	db.prepare(
		`INSERT INTO memories
		 (id, content, type, importance, access_count, created_at, updated_at, updated_by)
		 VALUES (?, ?, 'fact', ?, ?, ?, ?, 'test')`,
	).run(
		id,
		content,
		opts.importance ?? 0.5,
		opts.accessCount ?? 3,
		opts.createdAt ?? now,
		now,
	);
}

function insertSessionMemory(
	db: Database,
	sessionKey: string,
	memoryId: string,
	opts: {
		rank?: number;
		wasInjected?: number;
		relevanceScore?: number | null;
		ftsHitCount?: number;
		effectiveScore?: number | null;
		predictorScore?: number | null;
	} = {},
): void {
	const id = crypto.randomUUID();
	db.prepare(
		`INSERT INTO session_memories
		 (id, session_key, memory_id, source, effective_score, predictor_score,
		  final_score, rank, was_injected, relevance_score, fts_hit_count, created_at)
		 VALUES (?, ?, ?, 'hybrid', ?, ?, 0.5, ?, ?, ?, ?, ?)`,
	).run(
		id,
		sessionKey,
		memoryId,
		opts.effectiveScore ?? 0.8,
		opts.predictorScore ?? null,
		opts.rank ?? 1,
		opts.wasInjected ?? 1,
		opts.relevanceScore ?? null,
		opts.ftsHitCount ?? 0,
		new Date().toISOString(),
	);
}

function insertSessionScore(
	db: Database,
	sessionKey: string,
	score: number,
): void {
	const id = crypto.randomUUID();
	db.prepare(
		`INSERT INTO session_scores
		 (id, session_key, project, harness, score, memories_recalled,
		  memories_used, novel_context_count, reasoning, created_at)
		 VALUES (?, ?, null, 'test', ?, 5, 3, 1, 'test reasoning', ?)`,
	).run(id, sessionKey, score, new Date().toISOString());
}

// ---------------------------------------------------------------------------
// Label computation tests
// ---------------------------------------------------------------------------

describe("computeCombinedLabel", () => {
	it("uses agent relevance as primary signal when available", () => {
		const label = computeCombinedLabel(0.9, 0.7, 2);
		// combined = 0.9 * 0.7 + min(1, 2*0.3) * 0.2 + 0.7 * 0.1
		// = 0.63 + 0.6 * 0.2 + 0.07
		// = 0.63 + 0.12 + 0.07 = 0.82
		expect(label.combined).toBeCloseTo(0.82, 2);
		expect(label.agentRelevanceScore).toBe(0.9);
		expect(label.continuityScore).toBe(0.7);
		expect(label.ftsOverlapScore).toBeCloseTo(0.6, 2);
	});

	it("falls back to continuity when agent relevance is null", () => {
		const label = computeCombinedLabel(null, 0.8, 1);
		// combined = 0.8 * 0.8 + min(1, 0.3) * 0.2
		// = 0.64 + 0.06 = 0.70
		expect(label.combined).toBeCloseTo(0.7, 2);
		expect(label.agentRelevanceScore).toBeNull();
	});

	it("handles zero FTS hits", () => {
		const label = computeCombinedLabel(0.5, null, 0);
		// combined = 0.5 * 0.7 + 0 * 0.2 + 0 * 0.1 = 0.35
		expect(label.combined).toBeCloseTo(0.35, 2);
		expect(label.ftsOverlapScore).toBe(0);
	});

	it("caps FTS adjustment at 1.0", () => {
		const label = computeCombinedLabel(null, 0.5, 10);
		// fts = min(1.0, 10*0.3) = 1.0
		// combined = 0.5 * 0.8 + 1.0 * 0.2 = 0.4 + 0.2 = 0.6
		expect(label.combined).toBeCloseTo(0.6, 2);
		expect(label.ftsOverlapScore).toBe(1.0);
	});

	it("clamps combined to [0, 1]", () => {
		const label = computeCombinedLabel(1.0, 1.0, 5);
		expect(label.combined).toBeLessThanOrEqual(1.0);
		expect(label.combined).toBeGreaterThanOrEqual(0);
	});

	it("returns zero when all signals are null/zero", () => {
		const label = computeCombinedLabel(null, null, 0);
		expect(label.combined).toBe(0);
	});

	it("clamps agent relevance to [0, 1]", () => {
		const label = computeCombinedLabel(1.5, null, 0);
		// agent clamped to 1.0, combined = 1.0 * 0.7 = 0.7
		expect(label.combined).toBeCloseTo(0.7, 2);
	});
});

// ---------------------------------------------------------------------------
// Feature extraction tests
// ---------------------------------------------------------------------------

describe("collectTrainingPairs", () => {
	it("extracts feature vectors from session memories", () => {
		const { db, accessor } = createTestDb();

		const memId = "mem-001";
		const sessionKey = "sess-001";

		// Created 5 days ago
		const fiveDaysAgo = new Date(Date.now() - 5 * 86400000).toISOString();
		insertMemory(db, memId, "Secret project detail XYZ", {
			importance: 0.7,
			accessCount: 10,
			createdAt: fiveDaysAgo,
		});
		insertSessionMemory(db, sessionKey, memId, {
			rank: 1,
			wasInjected: 1,
			relevanceScore: 0.85,
			ftsHitCount: 2,
			effectiveScore: 0.9,
		});
		insertSessionScore(db, sessionKey, 0.75);

		const pairs = collectTrainingPairs(accessor, sessionKey, "default");

		expect(pairs).toHaveLength(1);
		const pair = pairs[0];

		// Feature checks
		expect(pair.features.importance).toBe(0.7);
		expect(pair.features.accessCount).toBe(10);
		expect(pair.features.recencyDays).toBeGreaterThan(4);
		expect(pair.features.recencyDays).toBeLessThan(6);
		expect(pair.features.decayFactor).toBeGreaterThan(0);
		expect(pair.features.decayFactor).toBeLessThan(1);
		expect(pair.features.embeddingSimilarity).toBe(0.9);
		expect(pair.features.ftsHitCount).toBe(2);

		// Label checks
		expect(pair.label.agentRelevanceScore).toBe(0.85);
		expect(pair.label.continuityScore).toBe(0.75);
		expect(pair.label.combined).toBeGreaterThan(0);

		// Metadata
		expect(pair.wasInjected).toBe(true);
		expect(pair.memoryId).toBe(memId);

		accessor.close();
	});

	it("returns empty array when no session memories exist", () => {
		const { accessor } = createTestDb();
		const pairs = collectTrainingPairs(accessor, "nonexistent", "default");
		expect(pairs).toHaveLength(0);
		accessor.close();
	});

	it("handles missing memory rows gracefully", () => {
		const { db, accessor } = createTestDb();

		// Insert session memory without corresponding memory row
		insertSessionMemory(db, "sess-orphan", "mem-missing", { rank: 1 });

		const pairs = collectTrainingPairs(accessor, "sess-orphan", "default");
		expect(pairs).toHaveLength(0);
		accessor.close();
	});
});

// ---------------------------------------------------------------------------
// Privacy tests
// ---------------------------------------------------------------------------

describe("privacy", () => {
	it("training pairs contain no memory content", () => {
		const { db, accessor } = createTestDb();

		const secretContent = "API key is sk-abc123 and password is hunter2";
		insertMemory(db, "mem-secret", secretContent);
		insertSessionMemory(db, "sess-priv", "mem-secret", { rank: 1 });

		const pairs = collectTrainingPairs(accessor, "sess-priv", "default");
		expect(pairs).toHaveLength(1);

		// Serialize the pair and verify no content leaks
		const serialized = JSON.stringify(pairs[0]);
		expect(serialized).not.toContain("sk-abc123");
		expect(serialized).not.toContain("hunter2");
		expect(serialized).not.toContain("API key");
		expect(serialized).not.toContain(secretContent);

		accessor.close();
	});

	it("exported pairs contain no memory content", () => {
		const { db, accessor } = createTestDb();

		const secretContent = "My social security number is 123-45-6789";
		insertMemory(db, "mem-pii", secretContent);
		insertSessionMemory(db, "sess-pii", "mem-pii", {
			rank: 1,
			relevanceScore: 0.5,
		});

		// Save and export
		const pairs = collectTrainingPairs(accessor, "sess-pii", "default");
		saveTrainingPairs(accessor, "default", "sess-pii", pairs);
		const exported = exportTrainingPairs(accessor, "default");

		expect(exported).toHaveLength(1);
		const serialized = JSON.stringify(exported[0]);
		expect(serialized).not.toContain("123-45-6789");
		expect(serialized).not.toContain("social security");

		accessor.close();
	});
});

// ---------------------------------------------------------------------------
// Save and export tests
// ---------------------------------------------------------------------------

describe("saveTrainingPairs", () => {
	it("batch inserts pairs into the database", () => {
		const { db, accessor } = createTestDb();

		const memIds = ["mem-a", "mem-b", "mem-c"];
		for (const id of memIds) {
			insertMemory(db, id, `content for ${id}`);
			insertSessionMemory(db, "sess-batch", id, {
				rank: memIds.indexOf(id) + 1,
			});
		}

		const pairs = collectTrainingPairs(accessor, "sess-batch", "default");
		expect(pairs).toHaveLength(3);

		const saved = saveTrainingPairs(accessor, "default", "sess-batch", pairs);
		expect(saved).toBe(3);

		// Verify they're in the database
		const count = db
			.prepare(
				"SELECT COUNT(*) as n FROM predictor_training_pairs WHERE session_key = ?",
			)
			.get("sess-batch") as { n: number };
		expect(count.n).toBe(3);

		accessor.close();
	});

	it("returns 0 for empty pairs array", () => {
		const { accessor } = createTestDb();
		const saved = saveTrainingPairs(accessor, "default", "sess-empty", []);
		expect(saved).toBe(0);
		accessor.close();
	});
});

describe("exportTrainingPairs", () => {
	it("returns pairs filtered by agent_id", () => {
		const { db, accessor } = createTestDb();

		insertMemory(db, "mem-exp", "test content");
		insertSessionMemory(db, "sess-exp", "mem-exp", { rank: 1 });

		const pairs = collectTrainingPairs(accessor, "sess-exp", "default");
		saveTrainingPairs(accessor, "default", "sess-exp", pairs);

		const exported = exportTrainingPairs(accessor, "default");
		expect(exported).toHaveLength(1);
		expect(exported[0].agentId).toBe("default");
		expect(exported[0].sessionKey).toBe("sess-exp");

		// Different agent_id should return nothing
		const other = exportTrainingPairs(accessor, "other-agent");
		expect(other).toHaveLength(0);

		accessor.close();
	});

	it("supports date filtering via since parameter", () => {
		const { db, accessor } = createTestDb();

		insertMemory(db, "mem-date", "date test");
		insertSessionMemory(db, "sess-date", "mem-date", { rank: 1 });

		const pairs = collectTrainingPairs(accessor, "sess-date", "default");
		saveTrainingPairs(accessor, "default", "sess-date", pairs);

		// Query with a future date should return nothing
		const future = new Date(Date.now() + 86400000).toISOString();
		const filtered = exportTrainingPairs(accessor, "default", { since: future });
		expect(filtered).toHaveLength(0);

		// Query with a past date should return the pair
		const past = new Date(Date.now() - 86400000).toISOString();
		const all = exportTrainingPairs(accessor, "default", { since: past });
		expect(all).toHaveLength(1);

		accessor.close();
	});

	it("respects limit parameter", () => {
		const { db, accessor } = createTestDb();

		for (let i = 0; i < 5; i++) {
			const memId = `mem-lim-${i}`;
			insertMemory(db, memId, `limit test ${i}`);
			insertSessionMemory(db, `sess-lim-${i}`, memId, { rank: 1 });
			const pairs = collectTrainingPairs(accessor, `sess-lim-${i}`, "default");
			saveTrainingPairs(accessor, "default", `sess-lim-${i}`, pairs);
		}

		const limited = exportTrainingPairs(accessor, "default", { limit: 2 });
		expect(limited).toHaveLength(2);

		accessor.close();
	});

	it("produces valid NDJSON-serializable output", () => {
		const { db, accessor } = createTestDb();

		insertMemory(db, "mem-json", "json test");
		insertSessionMemory(db, "sess-json", "mem-json", {
			rank: 1,
			relevanceScore: 0.8,
			ftsHitCount: 1,
		});
		insertSessionScore(db, "sess-json", 0.6);

		const pairs = collectTrainingPairs(accessor, "sess-json", "default");
		saveTrainingPairs(accessor, "default", "sess-json", pairs);

		const exported = exportTrainingPairs(accessor, "default");
		expect(exported).toHaveLength(1);

		// Should serialize to valid JSON
		const line = JSON.stringify(exported[0]);
		const parsed = JSON.parse(line);
		expect(parsed.features).toBeDefined();
		expect(parsed.label).toBeDefined();
		expect(typeof parsed.features.recencyDays).toBe("number");
		expect(typeof parsed.label.combined).toBe("number");

		accessor.close();
	});
});

// ---------------------------------------------------------------------------
// Retention tests
// ---------------------------------------------------------------------------

describe("purgeOldTrainingPairs", () => {
	it("deletes pairs older than retention period", () => {
		const { db, accessor } = createTestDb();

		// Insert a pair with an old created_at
		const oldDate = new Date(
			Date.now() - 100 * 24 * 60 * 60 * 1000,
		).toISOString();
		db.prepare(
			`INSERT INTO predictor_training_pairs
			 (id, agent_id, session_key, memory_id,
			  recency_days, access_count, importance, decay_factor,
			  fts_hit_count, combined_label, was_injected, is_constraint,
			  created_at)
			 VALUES (?, 'default', 'old-sess', 'old-mem',
			         50, 5, 0.5, 0.3,
			         0, 0.5, 1, 0,
			         ?)`,
		).run("old-pair-id", oldDate);

		// Insert a recent pair
		db.prepare(
			`INSERT INTO predictor_training_pairs
			 (id, agent_id, session_key, memory_id,
			  recency_days, access_count, importance, decay_factor,
			  fts_hit_count, combined_label, was_injected, is_constraint,
			  created_at)
			 VALUES (?, 'default', 'new-sess', 'new-mem',
			         1, 2, 0.5, 0.9,
			         0, 0.5, 1, 0,
			         ?)`,
		).run("new-pair-id", new Date().toISOString());

		const purged = purgeOldTrainingPairs(accessor, 90);

		// The old pair (100 days) should be purged, the new one kept
		expect(purged).toBe(1);

		const remaining = db
			.prepare("SELECT COUNT(*) as n FROM predictor_training_pairs")
			.get() as { n: number };
		expect(remaining.n).toBe(1);

		accessor.close();
	});

	it("does nothing when no pairs are expired", () => {
		const { db, accessor } = createTestDb();

		db.prepare(
			`INSERT INTO predictor_training_pairs
			 (id, agent_id, session_key, memory_id,
			  recency_days, access_count, importance, decay_factor,
			  fts_hit_count, combined_label, was_injected, is_constraint,
			  created_at)
			 VALUES (?, 'default', 'fresh-sess', 'fresh-mem',
			         1, 2, 0.5, 0.9,
			         0, 0.5, 1, 0,
			         ?)`,
		).run("fresh-id", new Date().toISOString());

		const purged = purgeOldTrainingPairs(accessor, 90);
		expect(purged).toBe(0);

		accessor.close();
	});
});
