import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { runMigrations } from "@signet/core";
import type { WriteDb } from "./db-accessor";
import {
	txApplyDecision,
	txForgetMemory,
	txIngestEnvelope,
	txModifyMemory,
	txRecoverMemory,
} from "./transactions";

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

		const oldVector = Buffer.from(
			new Float32Array([0.01, 0.02]).buffer.slice(0),
		);
		db.prepare(
			`INSERT INTO embeddings
			 (id, content_hash, vector, dimensions, source_type, source_id, chunk_text, created_at)
			 VALUES (?, ?, ?, ?, 'memory', ?, ?, ?)`,
		).run(
			"emb-old",
			"hash-old-1",
			oldVector,
			2,
			"mem-1",
			"User prefers light theme",
			new Date().toISOString(),
		);

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

		const oldEmbedding = db
			.prepare("SELECT id FROM embeddings WHERE content_hash = ?")
			.get("hash-old-1");
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

		const memB = db
			.prepare("SELECT content, content_hash FROM memories WHERE id = ?")
			.get("mem-b") as { content: string; content_hash: string };
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

		const rowAfterBlocked = db
			.prepare("SELECT is_deleted FROM memories WHERE id = ?")
			.get("mem-pinned") as { is_deleted: number };
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

		const oldDeletedAt = new Date(
			Date.now() - 31 * 24 * 60 * 60 * 1000,
		).toISOString();
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

		const row = db
			.prepare("SELECT is_deleted FROM memories WHERE id = ?")
			.get("mem-expired") as { is_deleted: number };
		expect(row.is_deleted).toBe(1);
	});
});

describe("transactions: txApplyDecision soft-delete behavior", () => {
	let db: Database;

	beforeEach(() => {
		db = new Database(":memory:");
		runMigrations(db as unknown as Parameters<typeof runMigrations>[0]);
	});

	afterEach(() => {
		db.close();
	});

	it("soft-deletes instead of hard-deleting for delete action", () => {
		insertMemory(db, {
			id: "mem-del",
			content: "Delete me",
			contentHash: "hash-del",
		});

		const now = new Date().toISOString();
		txApplyDecision(asWriteDb(db), {
			action: "delete",
			memoryId: "mem-del",
			updatedBy: "pipeline-v2",
			updatedAt: now,
		});

		const row = db
			.prepare(
				`SELECT is_deleted, deleted_at, version
				 FROM memories WHERE id = ?`,
			)
			.get("mem-del") as {
			is_deleted: number;
			deleted_at: string | null;
			version: number;
		};
		// Row still exists (soft-delete, not hard-delete)
		expect(row).toBeTruthy();
		expect(row.is_deleted).toBe(1);
		expect(row.deleted_at).toBeTruthy();
		expect(row.version).toBe(2);

		// History event was recorded
		const history = db
			.prepare(
				`SELECT event, changed_by
				 FROM memory_history
				 WHERE memory_id = ? AND event = 'deleted'`,
			)
			.get("mem-del") as { event: string; changed_by: string };
		expect(history.event).toBe("deleted");
		expect(history.changed_by).toBe("pipeline-v2");
	});

	it("skips delete for pinned memories (spec 27.2)", () => {
		insertMemory(db, {
			id: "mem-pinned-del",
			content: "Pinned content",
			contentHash: "hash-pinned-del",
			pinned: 1,
		});

		const now = new Date().toISOString();
		txApplyDecision(asWriteDb(db), {
			action: "delete",
			memoryId: "mem-pinned-del",
			updatedBy: "pipeline-v2",
			updatedAt: now,
		});

		const row = db
			.prepare("SELECT is_deleted FROM memories WHERE id = ?")
			.get("mem-pinned-del") as { is_deleted: number };
		expect(row.is_deleted).toBe(0);
	});

	it("soft-deletes merge source and updates merge target", () => {
		insertMemory(db, {
			id: "mem-merge-src",
			content: "Source content",
			contentHash: "hash-merge-src",
		});
		insertMemory(db, {
			id: "mem-merge-tgt",
			content: "Target content",
			contentHash: "hash-merge-tgt",
		});

		const now = new Date().toISOString();
		txApplyDecision(asWriteDb(db), {
			action: "merge",
			memoryId: "mem-merge-src",
			mergeTargetId: "mem-merge-tgt",
			content: "Merged content",
			updatedBy: "pipeline-v2",
			updatedAt: now,
		});

		// Source is soft-deleted
		const source = db
			.prepare(
				`SELECT is_deleted, deleted_at, version
				 FROM memories WHERE id = ?`,
			)
			.get("mem-merge-src") as {
			is_deleted: number;
			deleted_at: string | null;
			version: number;
		};
		expect(source.is_deleted).toBe(1);
		expect(source.deleted_at).toBeTruthy();

		// Target has merged content
		const target = db
			.prepare("SELECT content, version FROM memories WHERE id = ?")
			.get("mem-merge-tgt") as { content: string; version: number };
		expect(target.content).toBe("Merged content");
		expect(target.version).toBe(2);

		// History events recorded for both
		const sourceHistory = db
			.prepare(
				`SELECT event FROM memory_history
				 WHERE memory_id = 'mem-merge-src' AND event = 'deleted'`,
			)
			.get() as { event: string } | undefined;
		expect(sourceHistory?.event).toBe("deleted");

		const targetHistory = db
			.prepare(
				`SELECT event FROM memory_history
				 WHERE memory_id = 'mem-merge-tgt' AND event = 'merged'`,
			)
			.get() as { event: string } | undefined;
		expect(targetHistory?.event).toBe("merged");
	});

	it("records history events with version bump for update action", () => {
		insertMemory(db, {
			id: "mem-upd",
			content: "Old content",
			contentHash: "hash-upd",
		});

		const now = new Date().toISOString();
		txApplyDecision(asWriteDb(db), {
			action: "update",
			memoryId: "mem-upd",
			content: "New content",
			importance: 0.9,
			updatedBy: "pipeline-v2",
			updatedAt: now,
		});

		const row = db
			.prepare("SELECT content, importance, version FROM memories WHERE id = ?")
			.get("mem-upd") as {
			content: string;
			importance: number;
			version: number;
		};
		expect(row.content).toBe("New content");
		expect(row.importance).toBe(0.9);
		expect(row.version).toBe(2);

		const history = db
			.prepare(
				`SELECT event, changed_by
				 FROM memory_history
				 WHERE memory_id = ? AND event = 'updated'`,
			)
			.get("mem-upd") as { event: string; changed_by: string };
		expect(history.event).toBe("updated");
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

		const row = db
			.prepare("SELECT is_deleted FROM memories WHERE id = ?")
			.get("mem-policy") as { is_deleted: number };
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

		const row = db
			.prepare("SELECT is_deleted FROM memories WHERE id = ?")
			.get("mem-operator") as { is_deleted: number };
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
