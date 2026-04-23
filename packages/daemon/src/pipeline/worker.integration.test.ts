/**
 * Full pipeline integration test — exercises the entire extraction flow:
 *
 *   remember → enqueue → lease → extract (LLM) → escalate → decide (LLM)
 *   → Phase C writes → graph persistence → structural pass 1
 *   → hints enqueue → hints generation (LLM) → FTS5 search verification
 *
 * Uses a real in-memory SQLite database with full migrations and scripted
 * mock providers (no live LLM required). Each mock response is crafted to
 * exercise a specific stage of the pipeline.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../../../core/src/migrations";
import type { LlmProvider, PipelineV2Config } from "@signet/core";
import type { DbAccessor, WriteDb, ReadDb } from "../db-accessor";
import type { DecisionConfig } from "./decision";
import { enqueueExtractionJob, startWorker } from "./worker";
import { startHintsWorker } from "./prospective-index";
import { normalizeAndHashContent } from "../content-normalization";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAccessor(db: Database): DbAccessor {
	return {
		withWriteTx<T>(fn: (db: WriteDb) => T): T {
			db.exec("BEGIN IMMEDIATE");
			try {
				const result = fn(db as unknown as WriteDb);
				db.exec("COMMIT");
				return result;
			} catch (err) {
				db.exec("ROLLBACK");
				throw err;
			}
		},
		withReadDb<T>(fn: (db: ReadDb) => T): T {
			return fn(db as unknown as ReadDb);
		},
		close() {
			db.close();
		},
	};
}

function padExtractionInput(content: string): string {
	if (content.trim().length >= 80) return content;
	return `${content} This integration-test input includes durable context so extraction runs fully.`;
}

function longFact(content: string): string {
	if (content.trim().length >= 80) return content;
	return `${content}. This durable memory should remain useful across future coding sessions and related work.`;
}

function insertMemory(db: Database, id: string, content: string): void {
	const now = new Date().toISOString();
	db.prepare(
		`INSERT INTO memories
		 (id, type, content, confidence, importance, created_at, updated_at,
		  updated_by, vector_clock, is_deleted, extraction_status)
		 VALUES (?, 'fact', ?, 1.0, 0.5, ?, ?, 'test', '{}', 0, 'none')`,
	).run(id, padExtractionInput(content), now, now);
}

// ---------------------------------------------------------------------------
// Scripted mock provider
// ---------------------------------------------------------------------------

/**
 * Returns a provider that serves responses in order. Each call to
 * generate() returns the next response from the queue. After exhaustion,
 * returns the last response forever (safe default for extra calls).
 */
function scriptedProvider(outputs: readonly string[]): LlmProvider {
	let cursor = 0;
	return {
		name: "mock-scripted",
		async generate() {
			const output = outputs[Math.min(cursor, outputs.length - 1)] ?? "";
			cursor++;
			return output;
		},
		async available() {
			return true;
		},
	};
}

// ---------------------------------------------------------------------------
// Mock LLM responses
// ---------------------------------------------------------------------------

const EXTRACTION_RESPONSE = JSON.stringify({
	facts: [
		{
			content: "Nicholai relocated from Portland to Seattle in 2019 for a new position at a tech startup",
			type: "fact",
			confidence: 0.9,
		},
		{
			content: longFact("Nicholai prefers living in walkable neighborhoods with good coffee shops nearby"),
			type: "preference",
			confidence: 0.85,
		},
	],
	entities: [
		{
			source: "Nicholai",
			source_type: "person",
			relationship: "relocated_to",
			target: "Seattle",
			target_type: "concept",
			confidence: 0.9,
		},
		{
			source: "Nicholai",
			source_type: "person",
			relationship: "relocated_from",
			target: "Portland",
			target_type: "concept",
			confidence: 0.85,
		},
	],
});

const DECISION_ADD_RESPONSE = JSON.stringify({
	action: "add",
	targetId: null,
	confidence: 0.9,
	reason: "No existing memory matches this fact about relocation",
});

const HINTS_RESPONSE = [
	"Where does Nicholai live now?",
	"When did Nicholai move to Seattle?",
	"Tell me about Nicholai's relocation from Portland",
	"What kind of neighborhood does Nicholai prefer?",
	"Did Nicholai leave Portland?",
].join("\n");

// ---------------------------------------------------------------------------
// Pipeline config — everything enabled, fast polling
// ---------------------------------------------------------------------------

function testPipelineCfg(): PipelineV2Config {
	return {
		enabled: true,
		paused: false,
		shadowMode: false,
		nativeShadowEnabled: false,
		mutationsFrozen: false,
		semanticContradictionEnabled: false,
		semanticContradictionTimeoutMs: 5000,
		telemetryEnabled: false,
		extraction: {
			provider: "ollama",
			model: "mock-test",
			strength: "low",
			endpoint: undefined,
			timeout: 5000,
			minConfidence: 0.7,
			escalation: {
				maxNewEntitiesPerChunk: 10,
				maxNewAttributesPerEntity: 20,
				level2MaxEntities: 5,
			},
		},
		worker: { pollMs: 10, maxRetries: 3, leaseTimeoutMs: 300000, maxLoadPerCpu: 2, overloadBackoffMs: 5000 },
		graph: { enabled: true, boostWeight: 0.15, boostTimeoutMs: 500 },
		traversal: {
			enabled: false,
			primary: false,
			maxAspectsPerEntity: 10,
			maxAttributesPerAspect: 20,
			maxDependencyHops: 10,
			minDependencyStrength: 0.3,
			maxBranching: 4,
			maxTraversalPaths: 50,
			minConfidence: 0.5,
			timeoutMs: 500,
			boostWeight: 0.2,
			constraintBudgetChars: 1000,
		},
		reranker: { enabled: false, model: "", useExtractionModel: false, topN: 20, timeoutMs: 2000 },
		autonomous: {
			enabled: true,
			frozen: false,
			allowUpdateDelete: false,
			maintenanceIntervalMs: 0,
			maintenanceMode: "observe",
		},
		repair: {
			reembedCooldownMs: 0,
			reembedHourlyBudget: 0,
			requeueCooldownMs: 0,
			requeueHourlyBudget: 0,
			dedupCooldownMs: 0,
			dedupHourlyBudget: 0,
			dedupSemanticThreshold: 0.92,
			dedupBatchSize: 100,
		},
		documents: {
			workerIntervalMs: 10000,
			chunkSize: 2000,
			chunkOverlap: 200,
			maxContentBytes: 10_000_000,
		},
		guardrails: {
			maxContentChars: 800,
			chunkTargetChars: 600,
			recallTruncateChars: 500,
			contextBudgetChars: 4000,
		},
		continuity: {
			enabled: false,
			promptInterval: 10,
			timeIntervalMs: 900_000,
			maxCheckpointsPerSession: 50,
			retentionDays: 7,
			recoveryBudgetChars: 2000,
		},
		telemetry: {
			posthogHost: "",
			posthogApiKey: "",
			flushIntervalMs: 60000,
			flushBatchSize: 50,
			retentionDays: 90,
		},
		embeddingTracker: { enabled: false, pollMs: 5000, batchSize: 8 },
		synthesis: {
			enabled: false,
			provider: "ollama",
			model: "mock",
			endpoint: undefined,
			timeout: 5000,
			maxTokens: 1024,
			idleGapMinutes: 15,
		},
		procedural: {
			enabled: false,
			decayRate: 0.99,
			minImportance: 0.3,
			importanceOnInstall: 0.7,
			enrichOnInstall: false,
			enrichMinDescription: 30,
			reconcileIntervalMs: 60000,
		},
		structural: {
			enabled: true,
			classifyBatchSize: 8,
			dependencyBatchSize: 5,
			pollIntervalMs: 10000,
			synthesisEnabled: false,
			synthesisIntervalMs: 60_000,
			synthesisTopEntities: 20,
			synthesisMaxFacts: 10,
			synthesisMaxStallMs: 1_800_000,
			supersessionEnabled: false,
			supersessionSweepEnabled: false,
			supersessionSemanticFallback: false,
			supersessionMinConfidence: 0.7,
		},
		feedback: {
			enabled: false,
			ftsWeightDelta: 0.02,
			maxAspectWeight: 1.0,
			minAspectWeight: 0.1,
			decayEnabled: false,
			decayRate: 0.005,
			staleDays: 14,
			decayIntervalSessions: 10,
		},
		significance: {
			enabled: false, // disable for test — we want extraction to always run
			minTurns: 5,
			minEntityOverlap: 1,
			noveltyThreshold: 0.15,
		},
		predictorPipeline: { agentFeedback: false, trainingTelemetry: false },
		modelRegistry: { enabled: false, refreshIntervalMs: 3600_000 },
		hints: {
			enabled: true,
			max: 5,
			timeout: 5000,
			maxTokens: 256,
			poll: 10, // fast for tests
		},
	};
}

function testDecisionCfg(): DecisionConfig {
	return {
		embedding: {
			provider: "none",
			model: "mock",
			dimensions: 768,
			base_url: "",
		},
		search: {
			alpha: 0.7,
			top_k: 20,
			min_score: 0.3,
			rehearsal_enabled: false,
			rehearsal_weight: 0.1,
			rehearsal_half_life_days: 7,
		},
		async fetchEmbedding() {
			return null; // no embeddings in integration test
		},
	};
}

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

function getJob(db: Database, memoryId: string, jobType: string) {
	return db
		.prepare(
			`SELECT id, status, attempts, result, error
			 FROM memory_jobs
			 WHERE memory_id = ? AND job_type = ?
			 ORDER BY created_at DESC LIMIT 1`,
		)
		.get(memoryId, jobType) as
		| { id: string; status: string; attempts: number; result: string | null; error: string | null }
		| undefined;
}

function getWrittenFacts(db: Database, sourceId: string) {
	return db
		.prepare(
			`SELECT id, type, content, extraction_status, source_type, source_id
			 FROM memories
			 WHERE source_type = 'pipeline-v2' AND source_id = ?
			 ORDER BY created_at`,
		)
		.all(sourceId) as Array<{
		id: string;
		type: string;
		content: string;
		extraction_status: string;
		source_type: string;
		source_id: string;
	}>;
}

function getEntities(db: Database, name: string) {
	const canonical = name.trim().toLowerCase();
	return db
		.prepare(
			`SELECT id, name, entity_type, mentions
			 FROM entities WHERE canonical_name = ?`,
		)
		.get(canonical) as { id: string; name: string; entity_type: string; mentions: number } | undefined;
}

function getRelations(db: Database, sourceEntityId: string) {
	return db
		.prepare(
			`SELECT id, target_entity_id, relation_type, mentions, confidence
			 FROM relations WHERE source_entity_id = ?`,
		)
		.all(sourceEntityId) as Array<{
		id: string;
		target_entity_id: string;
		relation_type: string;
		mentions: number;
		confidence: number;
	}>;
}

function getMentions(db: Database, memoryId: string) {
	return db.prepare(`SELECT entity_id FROM memory_entity_mentions WHERE memory_id = ?`).all(memoryId) as Array<{
		entity_id: string;
	}>;
}

function getHistory(db: Database, memoryId: string) {
	return db
		.prepare(
			`SELECT event, changed_by, reason, metadata
			 FROM memory_history WHERE memory_id = ?
			 ORDER BY created_at`,
		)
		.all(memoryId) as Array<{
		event: string;
		changed_by: string;
		reason: string;
		metadata: string;
	}>;
}

function getHints(db: Database, memoryId: string) {
	return db.prepare(`SELECT hint FROM memory_hints WHERE memory_id = ? ORDER BY hint`).all(memoryId) as Array<{
		hint: string;
	}>;
}

function getHintsFts(db: Database, query: string) {
	return db
		.prepare(
			`SELECT h.memory_id
			 FROM memory_hints_fts f
			 JOIN memory_hints h ON h.rowid = f.rowid
			 WHERE memory_hints_fts MATCH ?`,
		)
		.all(query) as Array<{ memory_id: string }>;
}

function getStructuralJobs(db: Database, memoryId: string) {
	return db
		.prepare(
			`SELECT job_type, status, payload
			 FROM memory_jobs
			 WHERE memory_id = ? AND job_type LIKE 'structural_%'
			 ORDER BY job_type`,
		)
		.all(memoryId) as Array<{
		job_type: string;
		status: string;
		payload: string;
	}>;
}

function getAttributes(db: Database, memoryId: string) {
	return db
		.prepare(
			`SELECT id, aspect_id, kind, content, confidence
			 FROM entity_attributes WHERE memory_id = ?`,
		)
		.all(memoryId) as Array<{
		id: string;
		aspect_id: string | null;
		kind: string;
		content: string;
		confidence: number;
	}>;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("pipeline integration", () => {
	let db: Database;
	let accessor: DbAccessor;

	beforeEach(() => {
		db = new Database(":memory:");
		db.exec("PRAGMA journal_mode = WAL");
		db.exec("PRAGMA foreign_keys = ON");
		runMigrations(db as unknown as Parameters<typeof runMigrations>[0]);
		accessor = makeAccessor(db);
	});

	afterEach(() => {
		db.close();
	});

	it("full pipeline: extract → decide → write → graph → structural → hints → search", async () => {
		const sourceId = crypto.randomUUID();
		const content =
			"Nicholai moved from Portland to Seattle in 2019. He prefers walkable neighborhoods with good coffee.";
		insertMemory(db, sourceId, content);

		// The provider serves responses in order:
		// 1. Extraction call (2 facts, 2 entities — below escalation threshold)
		// 2. Decision for fact 1
		// 3. Decision for fact 2
		// (hints are served by a separate provider via startHintsWorker)
		const provider = scriptedProvider([EXTRACTION_RESPONSE, DECISION_ADD_RESPONSE, DECISION_ADD_RESPONSE]);

		const cfg = testPipelineCfg();

		// Enqueue extraction job
		enqueueExtractionJob(accessor, sourceId);

		const extractJob = getJob(db, sourceId, "extract");
		expect(extractJob).toBeDefined();
		expect(extractJob!.status).toBe("pending");

		// Start the extraction worker
		const worker = startWorker(accessor, provider, cfg, testDecisionCfg());

		// Give the worker time to process
		await new Promise((r) => setTimeout(r, 500));
		await worker.stop();

		// ----- Stage 1: Extraction job completed -----
		const completedJob = getJob(db, sourceId, "extract");
		expect(completedJob).toBeDefined();
		expect(completedJob!.status).toBe("completed");
		expect(completedJob!.attempts).toBe(1);
		expect(completedJob!.error).toBeNull();

		// Verify job result payload
		const result = JSON.parse(completedJob!.result!);
		expect(result.facts.length).toBe(2);
		expect(result.entities.length).toBe(2);
		expect(result.writeMode).toBe("phase-c");
		expect(result.writeStats.added).toBe(2);

		// Source memory marked as extracted
		const sourceRow = db.prepare("SELECT extraction_status FROM memories WHERE id = ?").get(sourceId) as {
			extraction_status: string;
		};
		expect(sourceRow.extraction_status).toBe("completed");

		// ----- Stage 2: Phase C writes — new fact memories created -----
		const facts = getWrittenFacts(db, sourceId);
		expect(facts.length).toBe(2);

		const relocationFact = facts.find((f) => f.content.includes("relocated"));
		const preferenceFact = facts.find((f) => f.content.includes("walkable"));
		expect(relocationFact).toBeDefined();
		expect(preferenceFact).toBeDefined();
		expect(relocationFact!.type).toBe("fact");
		expect(preferenceFact!.type).toBe("preference");
		expect(relocationFact!.extraction_status).toBe("completed");

		// ----- Stage 3: Graph entities persisted -----
		const nicholai = getEntities(db, "Nicholai");
		expect(nicholai).toBeDefined();
		expect(nicholai!.mentions).toBeGreaterThanOrEqual(1);

		const seattle = getEntities(db, "Seattle");
		expect(seattle).toBeDefined();

		const portland = getEntities(db, "Portland");
		expect(portland).toBeDefined();

		// Relations: Nicholai -> Seattle, Nicholai -> Portland
		const relations = getRelations(db, nicholai!.id);
		expect(relations.length).toBe(2);
		const seattleRelation = relations.find((r) => r.target_entity_id === seattle!.id);
		const portlandRelation = relations.find((r) => r.target_entity_id === portland!.id);
		expect(seattleRelation).toBeDefined();
		expect(portlandRelation).toBeDefined();
		expect(seattleRelation!.relation_type).toBe("relocated_to");
		expect(portlandRelation!.relation_type).toBe("relocated_from");

		// Entity mentions linked to source memory
		const mentions = getMentions(db, sourceId);
		expect(mentions.length).toBeGreaterThan(0);

		// ----- Stage 4: Decision history recorded -----
		const history = getHistory(db, sourceId);
		expect(history.length).toBeGreaterThanOrEqual(2);

		for (const entry of history) {
			const meta = JSON.parse(entry.metadata);
			expect(meta.proposedAction).toBe("add");
			expect(meta.shadow).toBe(false);
			expect(meta.extractionModel).toBe("mock-test");
		}

		// ----- Stage 5: Structural pass 1 -----
		// Written facts that mention "Nicholai" should get entity_attributes stubs
		// and structural_classify jobs
		const allStructuralJobs: Array<{ job_type: string; status: string; payload: string }> = [];
		for (const fact of facts) {
			const jobs = getStructuralJobs(db, fact.id);
			allStructuralJobs.push(...jobs);

			if (fact.content.toLowerCase().includes("nicholai")) {
				const attrs = getAttributes(db, fact.id);
				expect(attrs.length).toBeGreaterThanOrEqual(1);
				expect(attrs[0].aspect_id).toBeNull(); // stub awaiting classification
				expect(attrs[0].kind).toBe("attribute");
			}
		}

		// At least one structural_classify job should exist
		const classifyJobs = allStructuralJobs.filter((j) => j.job_type === "structural_classify");
		expect(classifyJobs.length).toBeGreaterThanOrEqual(1);

		// ----- Stage 6: Hints jobs enqueued -----
		// Each written fact gets a prospective_index job
		for (const fact of facts) {
			const hintsJob = getJob(db, fact.id, "prospective_index");
			expect(hintsJob).toBeDefined();
			expect(hintsJob!.status).toBe("pending");
		}

		// ----- Stage 7: Run hints worker to generate and index hints -----
		const hintsProvider = scriptedProvider([HINTS_RESPONSE, HINTS_RESPONSE]);
		const hintsHandle = startHintsWorker({
			accessor,
			provider: hintsProvider,
			pipelineCfg: cfg,
		});

		await new Promise((r) => setTimeout(r, 500));
		await hintsHandle.stop();

		// Verify hints were written for at least one fact
		let totalHints = 0;
		for (const fact of facts) {
			const hints = getHints(db, fact.id);
			totalHints += hints.length;

			const hintsJob = getJob(db, fact.id, "prospective_index");
			expect(hintsJob!.status).toBe("completed");
		}
		expect(totalHints).toBeGreaterThan(0);

		// ----- Stage 8: FTS5 search verification -----
		// Search for a hint query — should find the memory via hints index
		const ftsResults = getHintsFts(db, '"Nicholai" "live"');
		expect(ftsResults.length).toBeGreaterThan(0);

		// Search for relocation-related hint
		const relocationResults = getHintsFts(db, '"Nicholai" "Seattle"');
		expect(relocationResults.length).toBeGreaterThan(0);
	});

	it("shadow mode: extracts and decides but writes nothing", async () => {
		const sourceId = crypto.randomUUID();
		insertMemory(db, sourceId, "Alice works at Acme Corp as a senior engineer");

		const extractionResp = JSON.stringify({
			facts: [{ content: "Alice works at Acme Corp as a senior engineer", type: "fact", confidence: 0.9 }],
			entities: [
				{
					source: "Alice",
					source_type: "person",
					relationship: "works_at",
					target: "Acme Corp",
					target_type: "project",
					confidence: 0.9,
				},
			],
		});
		const provider = scriptedProvider([extractionResp, DECISION_ADD_RESPONSE]);

		const cfg = { ...testPipelineCfg(), shadowMode: true };

		enqueueExtractionJob(accessor, sourceId);
		const worker = startWorker(accessor, provider, cfg, testDecisionCfg());
		await new Promise((r) => setTimeout(r, 500));
		await worker.stop();

		// Job completed
		const job = getJob(db, sourceId, "extract");
		expect(job!.status).toBe("completed");

		const result = JSON.parse(job!.result!);
		expect(result.writeMode).toBe("shadow");
		expect(result.writeStats.added).toBe(0);

		// No new memories created
		const facts = getWrittenFacts(db, sourceId);
		expect(facts.length).toBe(0);

		// History records proposals as shadow
		const history = getHistory(db, sourceId);
		for (const entry of history) {
			const meta = JSON.parse(entry.metadata);
			expect(meta.shadow).toBe(true);
		}
	});

	it("low confidence facts are skipped", async () => {
		const sourceId = crypto.randomUUID();
		insertMemory(db, sourceId, "Maybe something about weather");

		const provider = scriptedProvider([
			JSON.stringify({
				facts: [{ content: longFact("It might rain tomorrow but who really knows for sure"), type: "fact", confidence: 0.4 }],
				entities: [],
			}),
			JSON.stringify({ action: "add", confidence: 0.4, reason: "Low confidence speculation" }),
		]);

		enqueueExtractionJob(accessor, sourceId);
		const cfg = testPipelineCfg();
		const worker = startWorker(accessor, provider, cfg, testDecisionCfg());
		await new Promise((r) => setTimeout(r, 500));
		await worker.stop();

		const job = getJob(db, sourceId, "extract");
		expect(job!.status).toBe("completed");

		const result = JSON.parse(job!.result!);
		expect(result.writeStats.skippedLowConfidence).toBe(1);
		expect(result.writeStats.added).toBe(0);

		const facts = getWrittenFacts(db, sourceId);
		expect(facts.length).toBe(0);
	});

	it("empty extraction produces no writes and completes cleanly", async () => {
		const sourceId = crypto.randomUUID();
		insertMemory(db, sourceId, "hi");

		const provider = scriptedProvider([
			JSON.stringify({ facts: [], entities: [] }),
			JSON.stringify({ facts: [], entities: [] }),
		]);

		enqueueExtractionJob(accessor, sourceId);
		const worker = startWorker(accessor, provider, testPipelineCfg(), testDecisionCfg());
		await new Promise((r) => setTimeout(r, 500));
		await worker.stop();

		const job = getJob(db, sourceId, "extract");
		expect(job!.status).toBe("completed");

		const result = JSON.parse(job!.result!);
		expect(result.facts.length).toBe(0);
		expect(result.proposals.length).toBe(0);
		expect(result.writeStats.added).toBe(0);
	});

	it("graph disabled: skips entity persistence", async () => {
		const sourceId = crypto.randomUUID();
		insertMemory(db, sourceId, "Bob likes pizza and eats it every Friday night for dinner with his family");

		const provider = scriptedProvider([
			JSON.stringify({
				facts: [
					{
						content: longFact("Bob likes pizza as his favorite food and eats it every Friday"),
						type: "preference",
						confidence: 0.9,
					},
				],
				entities: [
					{
						source: "Bob",
						source_type: "person",
						relationship: "likes",
						target: "pizza",
						target_type: "concept",
						confidence: 0.9,
					},
				],
			}),
			DECISION_ADD_RESPONSE,
		]);

		const cfg = { ...testPipelineCfg(), graph: { enabled: false, boostWeight: 0, boostTimeoutMs: 500 } };

		enqueueExtractionJob(accessor, sourceId);
		const worker = startWorker(accessor, provider, cfg, testDecisionCfg());
		await new Promise((r) => setTimeout(r, 500));
		await worker.stop();

		// Fact written
		const facts = getWrittenFacts(db, sourceId);
		expect(facts.length).toBe(1);

		// No entities (graph disabled)
		const bob = getEntities(db, "Bob");
		expect(bob).toBeFalsy();
	});

	it("hints disabled: no prospective_index jobs enqueued", async () => {
		const sourceId = crypto.randomUUID();
		insertMemory(db, sourceId, "Carol lives in Denver and works at a local coffee shop downtown");

		const provider = scriptedProvider([
			JSON.stringify({
				facts: [{ content: longFact("Carol lives in Denver, Colorado as her primary residence"), type: "fact", confidence: 0.9 }],
				entities: [],
			}),
			DECISION_ADD_RESPONSE,
		]);

		const cfg = {
			...testPipelineCfg(),
			graph: { enabled: false, boostWeight: 0, boostTimeoutMs: 500 },
			hints: { enabled: false, max: 5, timeout: 5000, maxTokens: 256, poll: 10 },
		};

		enqueueExtractionJob(accessor, sourceId);
		const worker = startWorker(accessor, provider, cfg, testDecisionCfg());
		await new Promise((r) => setTimeout(r, 500));
		await worker.stop();

		const facts = getWrittenFacts(db, sourceId);
		expect(facts.length).toBe(1);

		// No hints jobs
		const hintsJob = getJob(db, facts[0].id, "prospective_index");
		expect(hintsJob).toBeNull();
	});

	it("deduplication: identical content_hash skips write", async () => {
		const sourceId = crypto.randomUUID();
		insertMemory(db, sourceId, "Dave is a professional plumber who works in residential construction projects");

		const factContent = longFact("Dave is a professional plumber working in residential construction");

		// Pre-insert a memory with the same content (including content_hash) so it deduplicates
		const existingId = crypto.randomUUID();
		const normalized = normalizeAndHashContent(factContent);
		const now = new Date().toISOString();
		db.prepare(
			`INSERT INTO memories
			 (id, type, content, content_hash, normalized_content, confidence, importance,
			  created_at, updated_at, updated_by, vector_clock, is_deleted, extraction_status)
			 VALUES (?, 'fact', ?, ?, ?, 1.0, 0.5, ?, ?, 'test', '{}', 0, 'none')`,
		).run(existingId, normalized.storageContent, normalized.contentHash, normalized.normalizedContent, now, now);

		const provider = scriptedProvider([
			JSON.stringify({
				facts: [{ content: factContent, type: "fact", confidence: 0.9 }],
				entities: [],
			}),
			DECISION_ADD_RESPONSE,
		]);

		enqueueExtractionJob(accessor, sourceId);
		const cfg = { ...testPipelineCfg(), graph: { enabled: false, boostWeight: 0, boostTimeoutMs: 500 } };
		const worker = startWorker(accessor, provider, cfg, testDecisionCfg());
		await new Promise((r) => setTimeout(r, 500));
		await worker.stop();

		const job = getJob(db, sourceId, "extract");
		const result = JSON.parse(job!.result!);
		expect(result.writeStats.deduped).toBe(1);
		expect(result.writeStats.added).toBe(0);
	});
});
