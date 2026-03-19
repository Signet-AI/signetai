import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "../db-accessor";
import { upsertAspect } from "../knowledge-graph";
import {
	detectAttributeContradiction,
	checkAndSupersedeForAttributes,
	sweepRetroactiveSupersession,
} from "./supersession";
import type { PipelineV2Config } from "../memory-config";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDbPath(): string {
	const dir = join(
		tmpdir(),
		`signet-supersession-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(dir, { recursive: true });
	return join(dir, "memories.db");
}

let dbPath = "";

afterEach(() => {
	closeDbAccessor();
	if (dbPath) {
		rmSync(dbPath, { force: true });
		rmSync(`${dbPath}-wal`, { force: true });
		rmSync(`${dbPath}-shm`, { force: true });
	}
});

function insertEntity(id: string, name: string): void {
	const now = new Date().toISOString();
	getDbAccessor().withWriteTx((db) => {
		const cols = db
			.prepare("PRAGMA table_info(entities)")
			.all() as Array<Record<string, unknown>>;
		const names = new Set(
			cols.flatMap((col) =>
				typeof col.name === "string" ? [col.name] : [],
			),
		);
		if (!names.has("pinned")) {
			db.exec("ALTER TABLE entities ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0");
		}
		if (!names.has("pinned_at")) {
			db.exec("ALTER TABLE entities ADD COLUMN pinned_at TEXT");
		}
		db.prepare(
			`INSERT INTO entities
			 (id, name, entity_type, canonical_name, mentions, agent_id, created_at, updated_at)
			 VALUES (?, ?, 'person', ?, 1, 'default', ?, ?)`,
		).run(id, name, name.toLowerCase(), now, now);
	});
}

function insertMemory(id: string, content: string): void {
	const now = new Date().toISOString();
	getDbAccessor().withWriteTx((db) => {
		db.prepare(
			`INSERT INTO memories
			 (id, content, type, updated_by, created_at, updated_at, is_deleted)
			 VALUES (?, ?, 'fact', 'test', ?, ?, 0)`,
		).run(id, content, now, now);
	});
}

function insertAttribute(
	id: string,
	aspectId: string,
	memoryId: string,
	content: string,
	opts?: { kind?: string; createdAt?: string },
): void {
	const created = opts?.createdAt ?? new Date().toISOString();
	const kind = opts?.kind ?? "attribute";
	const normalized = content.trim().toLowerCase().replace(/\s+/g, " ");
	getDbAccessor().withWriteTx((db) => {
		db.prepare(
			`INSERT INTO entity_attributes
			 (id, aspect_id, agent_id, memory_id, kind, content, normalized_content,
			  confidence, importance, status, created_at, updated_at)
			 VALUES (?, ?, 'default', ?, ?, ?, ?, 1, 0.5, 'active', ?, ?)`,
		).run(id, aspectId, memoryId, kind, content, normalized, created, created);
	});
}

function readStatus(id: string): string | undefined {
	const row = getDbAccessor().withReadDb((db) =>
		db.prepare("SELECT status FROM entity_attributes WHERE id = ?").get(id) as
			| Record<string, unknown>
			| undefined,
	);
	return row?.status as string | undefined;
}

function readSupersededBy(id: string): string | null {
	const row = getDbAccessor().withReadDb((db) =>
		db.prepare("SELECT superseded_by FROM entity_attributes WHERE id = ?").get(id) as
			| Record<string, unknown>
			| undefined,
	);
	return (row?.superseded_by as string) ?? null;
}

function readHistory(event: string): Array<Record<string, unknown>> {
	return getDbAccessor().withReadDb((db) =>
		db.prepare("SELECT * FROM memory_history WHERE event = ?").all(event) as Array<Record<string, unknown>>,
	);
}

/** Minimal config that enables supersession with heuristic-only detection. */
function testConfig(overrides?: Partial<PipelineV2Config>): PipelineV2Config {
	return {
		enabled: true,
		shadowMode: false,
		mutationsFrozen: false,
		graphEnabled: true,
		autonomousEnabled: true,
		semanticContradictionEnabled: false,
		semanticContradictionTimeoutMs: 5000,
		worker: { maxRetries: 3, retryDelayMs: 1000, pollIntervalMs: 5000 },
		extraction: { model: "test", maxFacts: 10, maxEntities: 10, systemPrompt: "", temperature: 0 },
		decision: { model: "test", temperature: 0, systemPrompt: "" },
		autonomous: { allowUpdateDelete: true, maintenanceMode: "observe" as const, maintenancePollMs: 60000 },
		retention: { enabled: false, retentionDays: 30, coldEnabled: false, purgeEnabled: false, pollIntervalMs: 60000 },
		telemetry: { enabled: false, flushIntervalMs: 60000 },
		continuity: { enabled: false, sessionSummaryEnabled: false, sessionSummaryModel: "test", significanceMinScore: 0.3 },
		embeddingTracker: { enabled: false },
		synthesis: { model: "test", temperature: 0 },
		procedural: {
			enabled: false, decayRate: 0.99, minImportance: 0.3,
			importanceOnInstall: 0.7, enrichOnInstall: false, enrichMinDescription: 30,
			reconcileIntervalMs: 60000,
		},
		structural: {
			enabled: true,
			classifyBatchSize: 8,
			dependencyBatchSize: 5,
			pollIntervalMs: 10000,
			synthesisEnabled: false,
			synthesisIntervalMs: 60000,
			synthesisTopEntities: 20,
			synthesisMaxFacts: 10,
			supersessionEnabled: true,
			supersessionSweepEnabled: true,
			supersessionSemanticFallback: false,
			supersessionMinConfidence: 0.7,
		},
		feedback: {
			enabled: false, ftsWeightDelta: 0.02, maxAspectWeight: 1, minAspectWeight: 0.1,
			decayEnabled: false, decayRate: 0.005, staleDays: 14, decayIntervalSessions: 10,
		},
		predictorPipeline: { enabled: false, sidecarUrl: "", trainIntervalMs: 300000, trainingMinSessions: 20 },
		modelRegistry: { models: {} },
		...overrides,
	} as PipelineV2Config;
}

// ---------------------------------------------------------------------------
// detectAttributeContradiction -- unit tests
// ---------------------------------------------------------------------------

describe("detectAttributeContradiction", () => {
	test("detects negation polarity conflict", () => {
		const result = detectAttributeContradiction(
			"does not like spicy food",
			"likes spicy food",
		);
		expect(result.detected).toBe(true);
		expect(result.confidence).toBeGreaterThanOrEqual(0.7);
		expect(result.reasoning).toContain("negation");
	});

	test("detects antonym pair conflict", () => {
		const result = detectAttributeContradiction(
			"nicholai and amari are together",
			"nicholai and amari are apart",
		);
		expect(result.detected).toBe(true);
		expect(result.reasoning).toContain("antonym");
	});

	test("detects value conflict with shared verb", () => {
		const result = detectAttributeContradiction(
			"nicholai lives in denver",
			"nicholai lives in boulder",
		);
		expect(result.detected).toBe(true);
		expect(result.reasoning).toContain("value conflict");
	});

	test("detects temporal supersession with time markers", () => {
		const old = "2026-03-01T00:00:00.000Z";
		const recent = "2026-03-15T00:00:00.000Z";
		// Use content without shared verbs so temporal signal fires (not value conflict)
		const result = detectAttributeContradiction(
			"currently staying at avery's place",
			"at the apartment currently",
			recent,
			old,
		);
		expect(result.detected).toBe(true);
		expect(result.reasoning).toContain("temporal");
	});

	test("does not flag complementary information as contradiction", () => {
		const result = detectAttributeContradiction(
			"uses postgresql for the database",
			"the database has three replicas",
		);
		expect(result.detected).toBe(false);
	});

	test("requires minimum token overlap", () => {
		const result = detectAttributeContradiction(
			"the sky is blue",
			"pizza is delicious",
		);
		expect(result.detected).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Integration tests -- checkAndSupersedeForAttributes
// ---------------------------------------------------------------------------

describe("checkAndSupersedeForAttributes", () => {
	test("supersedes old attribute when value conflict detected", async () => {
		dbPath = makeDbPath();
		initDbAccessor(dbPath);

		insertEntity("entity-1", "Nicholai");
		insertMemory("mem-old", "lives in NYC");
		insertMemory("mem-new", "moved to LA");

		const aspect = upsertAspect(getDbAccessor(), {
			entityId: "entity-1",
			agentId: "default",
			name: "location",
		});

		insertAttribute("attr-old", aspect.id, "mem-old", "Nicholai lives in NYC");
		insertAttribute("attr-new", aspect.id, "mem-new", "Nicholai lives in LA");

		const cfg = testConfig();
		const result = await checkAndSupersedeForAttributes(
			getDbAccessor(), ["attr-new"], "default", cfg,
		);

		expect(result.superseded).toBe(1);
		expect(readStatus("attr-old")).toBe("superseded");
		expect(readSupersededBy("attr-old")).toBe("attr-new");
		expect(readStatus("attr-new")).toBe("active");
	});

	test("constraints are never auto-superseded", async () => {
		dbPath = makeDbPath();
		initDbAccessor(dbPath);

		insertEntity("entity-1", "Project");
		insertMemory("mem-constraint", "must use HTTPS");
		insertMemory("mem-new", "does not use HTTPS");

		const aspect = upsertAspect(getDbAccessor(), {
			entityId: "entity-1",
			agentId: "default",
			name: "security",
		});

		insertAttribute("attr-constraint", aspect.id, "mem-constraint", "must use HTTPS", { kind: "constraint" });
		insertAttribute("attr-new", aspect.id, "mem-new", "does not use HTTPS");

		const cfg = testConfig();
		const result = await checkAndSupersedeForAttributes(
			getDbAccessor(), ["attr-new"], "default", cfg,
		);

		expect(result.superseded).toBe(0);
		expect(readStatus("attr-constraint")).toBe("active");
	});

	test("shadow mode records proposal without mutating status", async () => {
		dbPath = makeDbPath();
		initDbAccessor(dbPath);

		insertEntity("entity-1", "Amari");
		insertMemory("mem-old", "apartment hunting together");
		insertMemory("mem-new", "broke up and moved apart");

		const aspect = upsertAspect(getDbAccessor(), {
			entityId: "entity-1",
			agentId: "default",
			name: "relationship",
		});

		insertAttribute("attr-old", aspect.id, "mem-old", "nicholai and amari apartment hunting together");
		insertAttribute("attr-new", aspect.id, "mem-new", "nicholai and amari moved apart");

		const cfg = testConfig({ shadowMode: true });
		const result = await checkAndSupersedeForAttributes(
			getDbAccessor(), ["attr-new"], "default", cfg,
		);

		expect(result.superseded).toBe(0);
		expect(result.candidates.length).toBeGreaterThan(0);
		expect(readStatus("attr-old")).toBe("active");

		const proposals = readHistory("supersession_proposal");
		expect(proposals.length).toBeGreaterThan(0);
	});

	test("idempotent re-run produces same state", async () => {
		dbPath = makeDbPath();
		initDbAccessor(dbPath);

		insertEntity("entity-1", "User");
		insertMemory("mem-old", "prefers vim");
		insertMemory("mem-new", "prefers emacs");

		const aspect = upsertAspect(getDbAccessor(), {
			entityId: "entity-1",
			agentId: "default",
			name: "editor",
		});

		insertAttribute("attr-old", aspect.id, "mem-old", "user prefers vim");
		insertAttribute("attr-new", aspect.id, "mem-new", "user prefers emacs");

		const cfg = testConfig();

		await checkAndSupersedeForAttributes(getDbAccessor(), ["attr-new"], "default", cfg);
		expect(readStatus("attr-old")).toBe("superseded");

		// Run again -- should be a no-op (old attr already superseded, not in siblings)
		const result2 = await checkAndSupersedeForAttributes(
			getDbAccessor(), ["attr-new"], "default", cfg,
		);
		expect(result2.candidates).toHaveLength(0);
		expect(readStatus("attr-old")).toBe("superseded");
	});

	test("audit trail contains complete metadata", async () => {
		dbPath = makeDbPath();
		initDbAccessor(dbPath);

		insertEntity("entity-1", "Nicholai");
		insertMemory("mem-old", "is happy");
		insertMemory("mem-new", "is not happy");

		const aspect = upsertAspect(getDbAccessor(), {
			entityId: "entity-1",
			agentId: "default",
			name: "mood",
		});

		insertAttribute("attr-old", aspect.id, "mem-old", "nicholai is happy");
		insertAttribute("attr-new", aspect.id, "mem-new", "nicholai is not happy");

		const cfg = testConfig();
		await checkAndSupersedeForAttributes(getDbAccessor(), ["attr-new"], "default", cfg);

		const events = readHistory("attribute_superseded");
		expect(events).toHaveLength(1);

		const meta = JSON.parse(events[0].metadata as string);
		expect(meta.old_attribute_id).toBe("attr-old");
		expect(meta.new_attribute_id).toBe("attr-new");
		expect(meta.aspect_id).toBe(aspect.id);
		expect(meta.method).toBe("heuristic");
		expect(meta.confidence).toBeGreaterThan(0);
		expect(meta.reasoning).toBeTruthy();
	});
});

// ---------------------------------------------------------------------------
// Sweep tests
// ---------------------------------------------------------------------------

describe("sweepRetroactiveSupersession", () => {
	test("catches pre-existing contradictions across sessions", async () => {
		dbPath = makeDbPath();
		initDbAccessor(dbPath);

		insertEntity("entity-1", "Amari");
		insertMemory("mem-1", "dating");
		insertMemory("mem-2", "single");

		const aspect = upsertAspect(getDbAccessor(), {
			entityId: "entity-1",
			agentId: "default",
			name: "relationship-status",
		});

		// Simulate two attributes from different sessions
		insertAttribute("attr-dating", aspect.id, "mem-1", "amari is dating nicholai", {
			createdAt: "2026-03-01T00:00:00.000Z",
		});
		insertAttribute("attr-single", aspect.id, "mem-2", "amari is single now", {
			createdAt: "2026-03-15T00:00:00.000Z",
		});

		const cfg = testConfig();
		const result = await sweepRetroactiveSupersession(
			getDbAccessor(), "default", cfg,
		);

		expect(result.superseded).toBe(1);
		expect(readStatus("attr-dating")).toBe("superseded");
		expect(readSupersededBy("attr-dating")).toBe("attr-single");
		expect(readStatus("attr-single")).toBe("active");
	});

	test("skips when sweep is disabled", async () => {
		dbPath = makeDbPath();
		initDbAccessor(dbPath);

		const cfg = testConfig({
			structural: {
				...testConfig().structural,
				supersessionSweepEnabled: false,
			},
		});

		const result = await sweepRetroactiveSupersession(
			getDbAccessor(), "default", cfg,
		);
		expect(result.superseded).toBe(0);
		expect(result.candidates).toHaveLength(0);
	});
});
