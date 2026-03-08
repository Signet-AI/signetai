import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { runMigrations } from "../../core/src/migrations";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEST_DIR = join(tmpdir(), `signet-structural-features-${Date.now()}`);
process.env.SIGNET_PATH = TEST_DIR;

const { closeDbAccessor, getDbAccessor, initDbAccessor } = await import("./db-accessor");
const { buildCandidateFeatures, getStructuralFeatures } = await import("./structural-features");

function ensureDir(path: string): void {
	mkdirSync(path, { recursive: true });
}

function setupDb(): Database {
	const dbPath = join(TEST_DIR, "memory", "memories.db");
	ensureDir(join(TEST_DIR, "memory"));
	if (existsSync(dbPath)) rmSync(dbPath);

	const db = new Database(dbPath);
	runMigrations(db as Parameters<typeof runMigrations>[0]);

	const now = new Date().toISOString();
	db.prepare(
		`INSERT INTO entities
		 (id, name, entity_type, canonical_name, mentions, created_at, updated_at, agent_id)
		 VALUES (?, ?, 'project', ?, 1, ?, ?, 'default')`,
	).run("entity-1", "Signet", "signet", now, now);

	db.prepare(
		`INSERT INTO entity_aspects
		 (id, entity_id, agent_id, name, canonical_name, weight, created_at, updated_at)
		 VALUES (?, ?, 'default', ?, ?, 0.8, ?, ?)`,
	).run("aspect-1", "entity-1", "Auth", "auth", now, now);

	db.prepare(
		`INSERT INTO memories
		 (id, type, content, confidence, importance, created_at, updated_at,
		  updated_by, vector_clock, is_deleted, access_count)
		 VALUES (?, 'fact', ?, 1.0, ?, ?, ?, 'test', '{}', 0, ?)`,
	).run("mem-1", "Auth uses WorkOS", 0.9, now, now, 3);
	db.prepare(
		`INSERT INTO memories
		 (id, type, content, confidence, importance, created_at, updated_at,
		  updated_by, vector_clock, is_deleted, access_count)
		 VALUES (?, 'fact', ?, 1.0, ?, ?, ?, 'test', '{}', 0, ?)`,
	).run("mem-2", "Constraints matter", 0.7, now, now, 1);
	db.prepare(
		`INSERT INTO memories
		 (id, type, content, confidence, importance, created_at, updated_at,
		  updated_by, vector_clock, is_deleted, access_count)
		 VALUES (?, 'fact', ?, 1.0, ?, ?, ?, 'test', '{}', 0, ?)`,
	).run("mem-3", "Unassigned memory", 0.5, now, now, 0);

	db.prepare(
		`INSERT INTO entity_attributes
		 (id, aspect_id, agent_id, memory_id, kind, content, normalized_content,
		  confidence, importance, status, created_at, updated_at)
		 VALUES (?, ?, 'default', ?, 'attribute', ?, ?, 1.0, 0.9, 'active', ?, ?)`,
	).run("attr-1", "aspect-1", "mem-1", "Auth uses WorkOS", "auth uses workos", now, now);
	db.prepare(
		`INSERT INTO entity_attributes
		 (id, aspect_id, agent_id, memory_id, kind, content, normalized_content,
		  confidence, importance, status, created_at, updated_at)
		 VALUES (?, ?, 'default', ?, 'constraint', ?, ?, 1.0, 0.8, 'active', ?, ?)`,
	).run("attr-2", "aspect-1", "mem-2", "Never bypass auth review", "never bypass auth review", now, now);

	db.prepare(
		`INSERT INTO embeddings
		 (id, content_hash, vector, dimensions, source_type, source_id, chunk_text, created_at)
		 VALUES (?, ?, ?, 3, 'memory', ?, ?, ?)`,
	).run("emb-1", "hash-mem-1", new Uint8Array(12), "mem-1", "Auth uses WorkOS", now);

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

describe("getStructuralFeatures", () => {
	it("returns structural slots and density for assigned memories", () => {
		const features = getStructuralFeatures(
			getDbAccessor(),
			["mem-1", "mem-2"],
			"default",
			new Map([
				["mem-1", "ka_traversal"],
				["mem-2", "effective"],
			]),
		);

		const attrFeatures = features.get("mem-1");
		const constraintFeatures = features.get("mem-2");
		expect(attrFeatures).not.toBeNull();
		expect(constraintFeatures).not.toBeNull();
		expect(attrFeatures?.entitySlot).toBe(constraintFeatures?.entitySlot);
		expect(attrFeatures?.aspectSlot).toBe(constraintFeatures?.aspectSlot);
		expect(attrFeatures?.structuralDensity).toBe(2);
		expect(constraintFeatures?.isConstraint).toBe(1);
		expect(attrFeatures?.candidateSource).toBe("ka_traversal");
		expect(constraintFeatures?.candidateSource).toBe("effective");
	});

	it("returns null for unassigned memories", () => {
		const features = getStructuralFeatures(getDbAccessor(), ["mem-3"], "default");
		expect(features.get("mem-3")).toBeNull();
	});
});

describe("buildCandidateFeatures", () => {
	it("builds 17-element feature vectors with structural signals", () => {
		const now = new Date().toISOString();
		const vectors = buildCandidateFeatures(
			getDbAccessor(),
			[
				{
					id: "mem-1",
					importance: 0.9,
					createdAt: now,
					accessCount: 3,
					lastAccessed: null,
					pinned: false,
					isSuperseded: false,
					source: "ka_traversal",
				},
				{
					id: "mem-3",
					importance: 0.5,
					createdAt: now,
					accessCount: 0,
					lastAccessed: null,
					pinned: false,
					isSuperseded: false,
					source: "effective",
				},
			],
			"default",
			{
				projectSlot: 0,
				timeOfDay: 12,
				dayOfWeek: 3,
				monthOfYear: 2,
				sessionGapDays: 4,
			},
		);

		expect(vectors).toHaveLength(2);
		expect(vectors[0]).toHaveLength(17);
		expect(vectors[0][10]).toBe(1);
		expect(vectors[0][14]).toBe(0);
		expect(vectors[0][16]).toBe(1);
		expect(vectors[1][12]).toBe(0);
		expect(vectors[1][13]).toBe(0);
		expect(vectors[1][15]).toBe(0);
	});

	it("clamps negative session gap days before log transform", () => {
		const now = new Date().toISOString();
		const [vector] = buildCandidateFeatures(
			getDbAccessor(),
			[
				{
					id: "mem-1",
					importance: 0.9,
					createdAt: now,
					accessCount: 3,
					lastAccessed: null,
					pinned: false,
					isSuperseded: false,
					source: "effective",
				},
			],
			"default",
			{
				projectSlot: 0,
				timeOfDay: 12,
				dayOfWeek: 3,
				monthOfYear: 2,
				sessionGapDays: -3,
			},
		);

		expect(vector[9]).toBe(0);
	});
});
