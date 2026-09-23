import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { runMigrations } from "../../core/src/migrations";
import type { WriteDb } from "./db-accessor";
import { beginEmbeddingIndexBuild, ensureEmbeddingIndexState } from "./embedding-index-state";
import { txForgetMemory, txIngestEnvelope, txModifyMemory, txRecoverMemory } from "./transactions";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

function asWriteDb(db: Database): WriteDb {
	return db as unknown as WriteDb;
}

function insertMemory(
	db: Database,
	input: {
		id: string;
		content: string;
		contentHash: string;
		type?: string;
		pinned?: number;
	},
): void {
	const now = new Date().toISOString();
	txIngestEnvelope(asWriteDb(db), {
		id: input.id,
		content: input.content,
		normalizedContent: input.content.toLowerCase(),
		contentHash: input.contentHash,
		who: "test",
		why: "test",
		project: "unit-test",
		importance: 0.6,
		type: input.type ?? "fact",
		tags: "alpha,beta",
		pinned: input.pinned ?? 0,
		isDeleted: 0,
		extractionStatus: "none",
		embeddingModel: null,
		extractionModel: null,
		updatedBy: "test",
		sourceType: "unit-test",
		sourceId: input.id,
		createdAt: now,
	});
}

describe("transactions: txModifyMemory + txForgetMemory + txRecoverMemory", () => {
	let db: Database;

	beforeEach(() => {
		db = new Database(":memory:");
		runMigrations(db as unknown as Parameters<typeof runMigrations>[0]);
	});

	afterEach(() => {
		db.close();
	});

	it("updates content + embedding and writes history in one transaction closure", () => {
		insertMemory(db, {
			id: "mem-1",
			content: "User prefers light theme",
			contentHash: "hash-old-1",
		});

		const oldVector = Buffer.from(new Float32Array([0.01, 0.02]).buffer.slice(0));
		db.prepare(
			`INSERT INTO embeddings
			 (id, content_hash, vector, dimensions, source_type, source_id, chunk_text, created_at)
			 VALUES (?, ?, ?, ?, 'memory', ?, ?, ?)`,
		).run("emb-old", "hash-old-1", oldVector, 2, "mem-1", "User prefers light theme", new Date().toISOString());

		const changedAt = new Date().toISOString();
		const result = txModifyMemory(asWriteDb(db), {
			memoryId: "mem-1",
			patch: {
				content: "User prefers dark theme",
				normalizedContent: "user prefers dark theme",
				contentHash: "hash-new-1",
				tags: "theme,dark",
			},
			reason: "manual correction",
			changedBy: "operator",
			changedAt,
			embeddingVector: [0.9, 0.8, 0.7],
			embeddingModelOnContentChange: "nomic-embed-text",
			extractionStatusOnContentChange: "none",
			extractionModelOnContentChange: null,
		});

		expect(result.status).toBe("updated");
		expect(result.contentChanged).toBe(true);
		expect(result.newVersion).toBe(2);

		const updated = db
			.prepare(
				`SELECT content, content_hash, embedding_model, update_count, version
				 FROM memories WHERE id = ?`,
			)
			.get("mem-1") as
			| {
					content: string;
					content_hash: string;
					embedding_model: string | null;
					update_count: number;
					version: number;
			  }
			| undefined;
		expect(updated?.content).toBe("User prefers dark theme");
		expect(updated?.content_hash).toBe("hash-new-1");
		expect(updated?.embedding_model).toBe("nomic-embed-text");
		expect(updated?.update_count).toBe(1);
		expect(updated?.version).toBe(2);

		const ftsRow = db
			.prepare(
				`SELECT content
				 FROM memories_fts
				 WHERE rowid = (SELECT rowid FROM memories WHERE id = ?)`,
			)
			.get("mem-1") as { content: string } | undefined;
		expect(ftsRow?.content).toBe("User prefers dark theme");

		const embeddings = db
			.prepare(
				`SELECT content_hash, dimensions, source_id
				 FROM embeddings
				 WHERE source_type = 'memory' AND source_id = ?`,
			)
			.all("mem-1") as Array<{
			content_hash: string;
			dimensions: number;
			source_id: string;
		}>;
		expect(embeddings).toHaveLength(1);
		expect(embeddings[0]?.content_hash).toBe("hash-new-1");
		expect(embeddings[0]?.dimensions).toBe(3);
		expect(embeddings[0]?.source_id).toBe("mem-1");

		const oldEmbedding = db.prepare("SELECT id FROM embeddings WHERE content_hash = ?").get("hash-old-1");
		expect(oldEmbedding).toBeNull();

		const history = db
			.prepare(
				`SELECT event, changed_by, reason
				 FROM memory_history
				 WHERE memory_id = ?`,
			)
			.get("mem-1") as { event: string; changed_by: string; reason: string };
		expect(history.event).toBe("updated");
		expect(history.changed_by).toBe("operator");
		expect(history.reason).toBe("manual correction");
	});

	it("rolls back an ingest before memory commit without losing existing durable state", () => {
		insertMemory(db, {
			id: "mem-existing",
			content: "Existing durable memory",
			contentHash: "hash-existing",
		});

		db.exec("BEGIN IMMEDIATE");
		try {
			insertMemory(db, {
				id: "mem-aborted",
				content: "Should not commit",
				contentHash: "hash-aborted",
			});
			throw new Error("simulated failure before memory commit");
		} catch (error) {
			db.exec("ROLLBACK");
			expect(error).toEqual(new Error("simulated failure before memory commit"));
		}

		expect(db.prepare("SELECT id FROM memories WHERE id = ?").get("mem-existing")).toBeTruthy();
		expect(db.prepare("SELECT id FROM memories WHERE id = ?").get("mem-aborted")).toBeNull();
		expect(db.prepare("SELECT id FROM memory_history WHERE memory_id = ?").get("mem-aborted")).toBeNull();
	});

	it("keeps a materialized semantic claim on the ontology write path", () => {
		insertMemory(db, {
			id: "semantic-claim",
			content: "Signet is a memory system.",
			contentHash: "semantic-claim-hash",
			type: "semantic",
		});
		db.prepare("UPDATE memories SET memory_kind = 'derived', source_type = 'dreaming' WHERE id = ?").run(
			"semantic-claim",
		);
		db.prepare(
			`INSERT INTO entity_attributes
			 (id, memory_id, agent_id, kind, content, normalized_content, confidence, importance, status)
			 VALUES ('semantic-claim', 'semantic-claim', 'default', 'fact', ?, ?, 0.9, 0.9, 'active')`,
		).run("Signet is a memory system.", "signet is a memory system.");

		const result = txModifyMemory(asWriteDb(db), {
			memoryId: "semantic-claim",
			patch: {
				content: "Signet is a search engine.",
				normalizedContent: "signet is a search engine.",
				contentHash: "semantic-claim-rewrite",
			},
			reason: "manual correction",
			changedBy: "operator",
			changedAt: new Date().toISOString(),
		});
		expect(result.status).toBe("semantic_projection_content_immutable");
		expect(db.prepare("SELECT content FROM memories WHERE id = ?").get("semantic-claim")).toEqual({
			content: "Signet is a memory system.",
		});
	});

	it("returns duplicate_content_hash when another active memory already has the hash", () => {
		insertMemory(db, {
			id: "mem-a",
			content: "Fact A",
			contentHash: "hash-a",
		});
		insertMemory(db, {
			id: "mem-b",
			content: "Fact B",
			contentHash: "hash-b",
		});

		const result = txModifyMemory(asWriteDb(db), {
			memoryId: "mem-b",
			patch: {
				content: "Fact A duplicate",
				normalizedContent: "fact a duplicate",
				contentHash: "hash-a",
			},
			reason: "attempted duplicate",
			changedBy: "operator",
			changedAt: new Date().toISOString(),
		});

		expect(result.status).toBe("duplicate_content_hash");
		expect(result.duplicateMemoryId).toBe("mem-a");

		const memB = db.prepare("SELECT content, content_hash FROM memories WHERE id = ?").get("mem-b") as {
			content: string;
			content_hash: string;
		};
		expect(memB.content).toBe("Fact B");
		expect(memB.content_hash).toBe("hash-b");
	});

	it("returns version_conflict on stale modify", () => {
		insertMemory(db, {
			id: "mem-version",
			content: "Original",
			contentHash: "hash-version",
		});

		const result = txModifyMemory(asWriteDb(db), {
			memoryId: "mem-version",
			patch: { tags: "new-tags" },
			reason: "stale write",
			changedBy: "operator",
			changedAt: new Date().toISOString(),
			ifVersion: 2,
		});

		expect(result.status).toBe("version_conflict");
		expect(result.currentVersion).toBe(1);
	});

	it("returns no_changes when the patch does not modify any field", () => {
		insertMemory(db, {
			id: "mem-nochange",
			content: "No change content",
			contentHash: "hash-nochange",
		});

		const result = txModifyMemory(asWriteDb(db), {
			memoryId: "mem-nochange",
			patch: {},
			reason: "noop",
			changedBy: "operator",
			changedAt: new Date().toISOString(),
		});

		expect(result.status).toBe("no_changes");
		expect(result.currentVersion).toBe(1);
	});

	it("blocks pinned forget unless force is true", () => {
		insertMemory(db, {
			id: "mem-pinned",
			content: "Pinned content",
			contentHash: "hash-pinned",
			pinned: 1,
		});

		const blocked = txForgetMemory(asWriteDb(db), {
			memoryId: "mem-pinned",
			reason: "cleanup",
			changedBy: "operator",
			changedAt: new Date().toISOString(),
			force: false,
		});
		expect(blocked.status).toBe("pinned_requires_force");

		const rowAfterBlocked = db.prepare("SELECT is_deleted FROM memories WHERE id = ?").get("mem-pinned") as {
			is_deleted: number;
		};
		expect(rowAfterBlocked.is_deleted).toBe(0);

		const allowed = txForgetMemory(asWriteDb(db), {
			memoryId: "mem-pinned",
			reason: "cleanup with force",
			changedBy: "operator",
			changedAt: new Date().toISOString(),
			force: true,
		});
		expect(allowed.status).toBe("deleted");
		expect(allowed.newVersion).toBe(2);

		const rowAfterAllowed = db
			.prepare(
				`SELECT is_deleted, deleted_at, version
				 FROM memories WHERE id = ?`,
			)
			.get("mem-pinned") as {
			is_deleted: number;
			deleted_at: string | null;
			version: number;
		};
		expect(rowAfterAllowed.is_deleted).toBe(1);
		expect(typeof rowAfterAllowed.deleted_at).toBe("string");
		expect(rowAfterAllowed.version).toBe(2);

		const history = db
			.prepare(
				`SELECT event, reason
				 FROM memory_history
				 WHERE memory_id = ?
				 ORDER BY created_at DESC
				 LIMIT 1`,
			)
			.get("mem-pinned") as { event: string; reason: string };
		expect(history.event).toBe("deleted");
		expect(history.reason).toBe("cleanup with force");
	});

	it("dead-letters pending and leased jobs for a forgotten memory without touching other jobs", () => {
		insertMemory(db, {
			id: "mem-forget-jobs",
			content: "Forget jobs source",
			contentHash: "hash-forget-jobs",
		});
		insertMemory(db, {
			id: "mem-keep-jobs",
			content: "Keep jobs source",
			contentHash: "hash-keep-jobs",
		});

		const createdAt = "2026-07-09T10:00:00.000Z";
		const insertJob = db.prepare(
			`INSERT INTO memory_jobs
			 (id, memory_id, job_type, status, attempts, max_attempts, created_at, updated_at)
			 VALUES (?, ?, 'extract', ?, 0, 3, ?, ?)`,
		);
		insertJob.run("job-forget-pending", "mem-forget-jobs", "pending", createdAt, createdAt);
		insertJob.run("job-forget-leased", "mem-forget-jobs", "leased", createdAt, createdAt);
		insertJob.run("job-forget-completed", "mem-forget-jobs", "completed", createdAt, createdAt);
		insertJob.run("job-keep-leased", "mem-keep-jobs", "leased", createdAt, createdAt);

		const changedAt = "2026-07-09T10:05:00.000Z";
		const result = txForgetMemory(asWriteDb(db), {
			memoryId: "mem-forget-jobs",
			reason: "privacy request",
			changedBy: "operator",
			changedAt,
			force: false,
		});

		expect(result.status).toBe("deleted");
		const cancelled = db
			.prepare(
				`SELECT id, status, result, error, failed_at, updated_at
				 FROM memory_jobs
				 WHERE id IN ('job-forget-pending', 'job-forget-leased')
				 ORDER BY id`,
			)
			.all() as Array<{
			id: string;
			status: string;
			result: string | null;
			error: string | null;
			failed_at: string | null;
			updated_at: string;
		}>;
		expect(cancelled).toHaveLength(2);
		for (const job of cancelled) {
			expect(job.status).toBe("dead");
			expect(JSON.parse(job.result ?? "{}")).toEqual({ cancelled: "memory_forgotten" });
			expect(job.error).toBe("Source memory forgotten");
			expect(job.failed_at).toBe(changedAt);
			expect(job.updated_at).toBe(changedAt);
		}

		const untouched = db
			.prepare(
				`SELECT id, status, result, error, failed_at, updated_at
				 FROM memory_jobs
				 WHERE id IN ('job-forget-completed', 'job-keep-leased')
				 ORDER BY id`,
			)
			.all();
		expect(untouched).toEqual([
			{
				id: "job-forget-completed",
				status: "completed",
				result: null,
				error: null,
				failed_at: null,
				updated_at: createdAt,
			},
			{
				id: "job-keep-leased",
				status: "leased",
				result: null,
				error: null,
				failed_at: null,
				updated_at: createdAt,
			},
		]);
	});

	it("stales dependents while retaining source lineage when a memory is forgotten", () => {
		insertMemory(db, {
			id: "mem-aggregate",
			content: "Aggregate content",
			contentHash: "hash-aggregate",
		});
		insertMemory(db, {
			id: "mem-source",
			content: "Source content",
			contentHash: "hash-source",
		});
		insertMemory(db, {
			id: "mem-other-aggregate",
			content: "Other aggregate content",
			contentHash: "hash-other-aggregate",
		});
		insertMemory(db, {
			id: "mem-other-source",
			content: "Other source content",
			contentHash: "hash-other-source",
		});

		const now = new Date().toISOString();
		const link = db.prepare(
			`INSERT INTO derived_memory_sources (
				derived_memory_id, source_kind, source_id, source_path, agent_id, created_at
			) VALUES (?, 'memory', ?, NULL, 'default', ?)`,
		);
		link.run("mem-aggregate", "mem-source", now);
		link.run("mem-other-aggregate", "mem-aggregate", now);
		link.run("mem-other-aggregate", "mem-other-source", now);

		const result = txForgetMemory(asWriteDb(db), {
			memoryId: "mem-aggregate",
			reason: "cleanup",
			changedBy: "operator",
			changedAt: now,
			force: false,
		});

		expect(result.status).toBe("deleted");
		const linkedRows = db
			.prepare(
				`SELECT derived_memory_id, source_id
				 FROM derived_memory_sources
				 WHERE derived_memory_id = ? OR source_id = ?
				 ORDER BY derived_memory_id, source_id`,
			)
			.all("mem-aggregate", "mem-aggregate");
		expect(linkedRows).toEqual([
			{ derived_memory_id: "mem-aggregate", source_id: "mem-source" },
			{ derived_memory_id: "mem-other-aggregate", source_id: "mem-aggregate" },
		]);
		expect(db.prepare("SELECT stale_at FROM memories WHERE id = ?").get("mem-other-aggregate")).toMatchObject({
			stale_at: now,
		});
	});

	it("recovers a soft-deleted memory within retention window", () => {
		insertMemory(db, {
			id: "mem-recoverable",
			content: "Recover me",
			contentHash: "hash-recoverable",
		});

		const deletedAt = new Date().toISOString();
		const deleted = txForgetMemory(asWriteDb(db), {
			memoryId: "mem-recoverable",
			reason: "cleanup",
			changedBy: "operator",
			changedAt: deletedAt,
			force: false,
		});
		expect(deleted.status).toBe("deleted");

		const recovered = txRecoverMemory(asWriteDb(db), {
			memoryId: "mem-recoverable",
			reason: "mistake rollback",
			changedBy: "operator",
			changedAt: new Date(Date.now() + 60_000).toISOString(),
			retentionWindowMs: THIRTY_DAYS_MS,
		});
		expect(recovered.status).toBe("recovered");
		expect(recovered.newVersion).toBe(3);

		const row = db
			.prepare(
				`SELECT is_deleted, deleted_at, version
				 FROM memories WHERE id = ?`,
			)
			.get("mem-recoverable") as {
			is_deleted: number;
			deleted_at: string | null;
			version: number;
		};
		expect(row.is_deleted).toBe(0);
		expect(row.deleted_at).toBeNull();
		expect(row.version).toBe(3);

		const event = db
			.prepare(
				`SELECT event, reason
				 FROM memory_history
				 WHERE memory_id = ?
				 ORDER BY created_at DESC
				 LIMIT 1`,
			)
			.get("mem-recoverable") as { event: string; reason: string };
		expect(event.event).toBe("recovered");
		expect(event.reason).toBe("mistake rollback");
	});

	it("returns retention_expired when recovering after retention window", () => {
		insertMemory(db, {
			id: "mem-expired",
			content: "Expired delete",
			contentHash: "hash-expired",
		});

		const oldDeletedAt = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
		db.prepare(
			`UPDATE memories
			 SET is_deleted = 1, deleted_at = ?, version = version + 1
			 WHERE id = ?`,
		).run(oldDeletedAt, "mem-expired");

		const recovered = txRecoverMemory(asWriteDb(db), {
			memoryId: "mem-expired",
			reason: "too late",
			changedBy: "operator",
			changedAt: new Date().toISOString(),
			retentionWindowMs: THIRTY_DAYS_MS,
		});
		expect(recovered.status).toBe("retention_expired");

		const row = db.prepare("SELECT is_deleted FROM memories WHERE id = ?").get("mem-expired") as { is_deleted: number };
		expect(row.is_deleted).toBe(1);
	});

	it("writes the embedding even when the caller's resolved config raced a building->ready promotion", () => {
		// Regression: txModifyMemory re-resolves the active embedding config inside
		// the transaction. Previously it checked the caller-supplied (already
		// resolved) config, so a startup building->ready promotion between the
		// caller's resolve and this write skipped the insert and silently dropped
		// the vector (the API still reported embedded=true).
		const embeddingConfig = {
			provider: "native" as const,
			model: "nomic-embed-text-v1.5",
			dimensions: 768,
			base_url: "",
		};
		ensureEmbeddingIndexState(asWriteDb(db), embeddingConfig);
		db.exec(
			"CREATE TABLE IF NOT EXISTS embeddings_staging (id TEXT PRIMARY KEY, content_hash TEXT UNIQUE, vector BLOB, dimensions INTEGER, source_type TEXT, source_id TEXT, chunk_text TEXT, created_at TEXT, agent_id TEXT)",
		);
		beginEmbeddingIndexBuild(asWriteDb(db), embeddingConfig);
		// Promote staging -> active, simulating the startup build completing so
		// the active profile becomes the recommended nomic profile.
		db.prepare(
			"UPDATE embedding_index_state SET active_profile_json = staging_profile_json, staging_profile_json = NULL, state = 'ready' WHERE id = 1",
		).run();

		insertMemory(db, { id: "mem-race", content: "original content", contentHash: "hash-race-old" });

		const result = txModifyMemory(asWriteDb(db), {
			memoryId: "mem-race",
			patch: {
				content: "updated content",
				normalizedContent: "updated content",
				contentHash: "hash-race-new",
			},
			reason: "race regression",
			changedBy: "test",
			changedAt: new Date().toISOString(),
			embeddingVector: new Array(768).fill(0.1),
			embeddingModelOnContentChange: "nomic-embed-text-v1.5",
			extractionStatusOnContentChange: "none",
			extractionModelOnContentChange: null,
			// Stale: caller resolved this during building (no profile -> identity),
			// but active is now the promoted nomic profile. Without the in-tx
			// re-resolve this write would be skipped.
			embeddingConfig: { ...embeddingConfig, profile: undefined },
		});

		expect(result.status).toBe("updated");
		expect(result.contentChanged).toBe(true);
		const row = db
			.prepare("SELECT dimensions FROM embeddings WHERE source_type = 'memory' AND source_id = ?")
			.get("mem-race") as { dimensions?: number } | undefined;
		expect(row?.dimensions).toBe(768);
	});
});

describe("transactions: autonomous force-delete policy gate", () => {
	let db: Database;

	beforeEach(() => {
		db = new Database(":memory:");
		runMigrations(db as unknown as Parameters<typeof runMigrations>[0]);
	});

	afterEach(() => {
		db.close();
	});

	it("denies force-delete of pinned memory by pipeline actor", () => {
		insertMemory(db, {
			id: "mem-policy",
			content: "Pinned by policy",
			contentHash: "hash-policy",
			pinned: 1,
		});

		const result = txForgetMemory(asWriteDb(db), {
			memoryId: "mem-policy",
			reason: "pipeline cleanup",
			changedBy: "pipeline-v2",
			changedAt: new Date().toISOString(),
			force: true,
			ctx: { actorType: "pipeline" },
		});

		expect(result.status).toBe("autonomous_force_denied");

		const row = db.prepare("SELECT is_deleted FROM memories WHERE id = ?").get("mem-policy") as { is_deleted: number };
		expect(row.is_deleted).toBe(0);
	});

	it("allows force-delete of pinned memory by operator actor", () => {
		insertMemory(db, {
			id: "mem-operator",
			content: "Operator can delete",
			contentHash: "hash-operator",
			pinned: 1,
		});

		const result = txForgetMemory(asWriteDb(db), {
			memoryId: "mem-operator",
			reason: "operator override",
			changedBy: "nicholai",
			changedAt: new Date().toISOString(),
			force: true,
			ctx: { actorType: "operator" },
		});

		expect(result.status).toBe("deleted");

		const row = db.prepare("SELECT is_deleted FROM memories WHERE id = ?").get("mem-operator") as {
			is_deleted: number;
		};
		expect(row.is_deleted).toBe(1);
	});

	it("records actor_type in history events", () => {
		insertMemory(db, {
			id: "mem-audit",
			content: "Track actor type",
			contentHash: "hash-audit",
		});

		txForgetMemory(asWriteDb(db), {
			memoryId: "mem-audit",
			reason: "audit test",
			changedBy: "test-harness",
			changedAt: new Date().toISOString(),
			force: false,
			ctx: {
				actorType: "harness",
				sessionId: "sess-123",
				requestId: "req-456",
			},
		});

		const history = db
			.prepare(
				`SELECT actor_type, session_id, request_id
				 FROM memory_history
				 WHERE memory_id = ?`,
			)
			.get("mem-audit") as {
			actor_type: string | null;
			session_id: string | null;
			request_id: string | null;
		};
		expect(history.actor_type).toBe("harness");
		expect(history.session_id).toBe("sess-123");
		expect(history.request_id).toBe("req-456");
	});
});
