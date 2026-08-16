import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "./db-accessor";
import { markImportedSourceUnsupported } from "./imported-source-lifecycle";
import { indexExternalMemoryArtifact } from "./memory-lineage";

describe("imported source lifecycle", () => {
	let dir = "";
	let previousPath: string | undefined;
	let previousAgentId: string | undefined;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "signet-import-lifecycle-"));
		mkdirSync(join(dir, "memory"), { recursive: true });
		previousPath = process.env.SIGNET_PATH;
		previousAgentId = process.env.SIGNET_AGENT_ID;
		process.env.SIGNET_PATH = dir;
		process.env.SIGNET_AGENT_ID = "lifecycle-test-agent";
		closeDbAccessor();
		initDbAccessor(join(dir, "memory", "memories.db"));
	});

	afterEach(() => {
		closeDbAccessor();
		if (previousPath === undefined) Reflect.deleteProperty(process.env, "SIGNET_PATH");
		else process.env.SIGNET_PATH = previousPath;
		if (previousAgentId === undefined) Reflect.deleteProperty(process.env, "SIGNET_AGENT_ID");
		else process.env.SIGNET_AGENT_ID = previousAgentId;
		rmSync(dir, { recursive: true, force: true });
	});

	it("removes searchable artifacts while preserving provenance for Dreaming review", async () => {
		const sourceId = "source-import-1";
		const agentId = "lifecycle-test-agent";
		await indexExternalMemoryArtifact({
			agentId,
			sourcePath: "imports/source-import-1/notes.json",
			sourceKind: "source_import_json_projection",
			harness: "dashboard-import",
			content: "A durable imported fact",
			sourceMtimeMs: Date.now(),
			sourceId,
			sourceRoot: "notes.json",
			sourceExternalId: "hash-1",
			sourceMeta: { representation: "structured-json-projection" },
		});
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO dreaming_evidence_consumption
				 (agent_id, source_kind, source_id, source_captured_at, source_entry_id, source_revision, delivered_offset, source_length, pass_id, updated_at)
				 VALUES (?, 'artifact', 'imports/source-import-1/notes.json', '2026-08-11T00:00:00.000Z', ?, 'hash-1', 20, 20, 'pass-1', '2026-08-11T00:00:00.000Z')`,
			).run(agentId, sourceId);
			db.prepare(
				`INSERT INTO derived_memory_sources
				 (derived_memory_id, source_kind, source_id, source_path, agent_id, created_at)
				 VALUES (?, ?, ?, ?, ?, ?)`,
			).run(
				"memory-derived-1",
				"source_import_json_projection",
				sourceId,
				"notes.json",
				agentId,
				new Date().toISOString(),
			);
			db.prepare(
				`INSERT INTO memories
				 (id, content, type, agent_id, visibility, is_deleted, created_at, updated_at, updated_by)
				 VALUES (?, ?, 'fact', ?, 'global', 0, ?, ?, 'test')`,
			).run("memory-derived-1", "A derived imported fact", agentId, new Date().toISOString(), new Date().toISOString());
			db.prepare(
				`INSERT INTO entities
				 (id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at,
				  source_id, source_kind, source_path, source_root)
				 VALUES (?, 'Imported document', 'imported document', 'source_document', ?, 1, ?, ?, ?, ?, ?, ?)`,
			).run(
				"entity-source-1",
				agentId,
				new Date().toISOString(),
				new Date().toISOString(),
				sourceId,
				"source_import_json_projection",
				"notes.json",
				"notes.json",
			);
			db.prepare(
				`INSERT INTO entities
				 (id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at)
				 VALUES (?, 'Target', 'target', 'person', ?, 1, ?, ?)`,
			).run("entity-target-1", agentId, new Date().toISOString(), new Date().toISOString());
			db.prepare(
				`INSERT INTO entity_aspects
				 (id, entity_id, agent_id, name, canonical_name, weight, created_at, updated_at)
				 VALUES (?, ?, ?, 'facts', 'facts', 0.8, ?, ?)`,
			).run("aspect-source-1", "entity-source-1", agentId, new Date().toISOString(), new Date().toISOString());
			db.prepare(
				`INSERT INTO entity_attributes
				 (id, aspect_id, agent_id, memory_id, kind, content, normalized_content, confidence, importance, status,
				  created_at, updated_at, source_id, source_kind, source_path, source_root)
				 VALUES (?, ?, ?, NULL, 'claim', 'Imported claim', 'imported claim', 0.8, 0.5, 'active', ?, ?, ?, ?, ?, ?)`,
			).run(
				"attribute-source-1",
				"aspect-source-1",
				agentId,
				new Date().toISOString(),
				new Date().toISOString(),
				sourceId,
				"source_import_json_projection",
				"notes.json",
				"notes.json",
			);
			db.prepare(
				`INSERT INTO entity_dependencies
				 (id, source_entity_id, target_entity_id, agent_id, dependency_type, strength, confidence, reason,
				  created_at, updated_at, source_id, source_kind, source_path, source_root)
				 VALUES (?, ?, ?, ?, 'contains', 1, 1, 'imported evidence', ?, ?, ?, ?, ?, ?)`,
			).run(
				"dependency-source-1",
				"entity-source-1",
				"entity-target-1",
				agentId,
				new Date().toISOString(),
				new Date().toISOString(),
				sourceId,
				"source_import_json_projection",
				"notes.json",
				"notes.json",
			);
		});

		const result = markImportedSourceUnsupported({ sourceId, agentId, reason: "source removed by user" });

		expect(result.artifacts).toBeGreaterThan(0);
		expect(result.derivedMemories).toBe(1);
		expect(result.entities).toBeGreaterThan(0);
		expect(result.aspects).toBeGreaterThan(0);
		expect(result.attributes).toBeGreaterThan(0);
		expect(result.dependencies).toBeGreaterThan(0);
		expect(
			getDbAccessor().withReadDb(
				(db) =>
					db.prepare("SELECT COUNT(*) AS count FROM memory_artifacts WHERE source_id = ?").get(sourceId) as {
						count: number;
					},
			).count,
		).toBe(0);
		expect(
			getDbAccessor().withReadDb(
				(db) =>
					db
						.prepare("SELECT COUNT(*) AS count FROM dreaming_evidence_consumption WHERE source_entry_id = ?")
						.get(sourceId) as {
						count: number;
					},
			).count,
		).toBe(0);
		expect(
			getDbAccessor().withReadDb(
				(db) =>
					db.prepare("SELECT stale_at FROM memories WHERE id = ?").get("memory-derived-1") as {
						stale_at: string | null;
					},
			).stale_at,
		).toEqual(expect.any(String));
		expect(
			getDbAccessor().withReadDb(
				(db) =>
					db.prepare("SELECT status, archive_reason, source_id FROM entities WHERE id = ?").get("entity-source-1") as {
						status: string;
						archive_reason: string;
						source_id: string;
					},
			),
		).toEqual({
			status: "archived",
			archive_reason: "unsupported source: source removed by user",
			source_id: sourceId,
		});
		expect(
			getDbAccessor().withReadDb(
				(db) =>
					db.prepare("SELECT status, archive_reason FROM entity_aspects WHERE id = ?").get("aspect-source-1") as {
						status: string;
						archive_reason: string;
					},
			),
		).toEqual({ status: "archived", archive_reason: "unsupported source: source removed by user" });
		expect(
			getDbAccessor().withReadDb(
				(db) =>
					db
						.prepare("SELECT status, archive_reason, source_id FROM entity_attributes WHERE id = ?")
						.get("attribute-source-1") as { status: string; archive_reason: string; source_id: string },
			),
		).toEqual({
			status: "archived",
			archive_reason: "unsupported source: source removed by user",
			source_id: sourceId,
		});
		expect(
			getDbAccessor().withReadDb(
				(db) =>
					db
						.prepare("SELECT status, archive_reason, source_id FROM entity_dependencies WHERE id = ?")
						.get("dependency-source-1") as { status: string; archive_reason: string; source_id: string },
			),
		).toEqual({
			status: "archived",
			archive_reason: "unsupported source: source removed by user",
			source_id: sourceId,
		});

		expect(
			getDbAccessor().withReadDb(
				(db) =>
					db.prepare("SELECT source_id, source_path FROM derived_memory_sources WHERE source_id = ?").get(sourceId) as {
						source_id: string;
						source_path: string;
					},
			),
		).toEqual({ source_id: sourceId, source_path: "notes.json" });
		expect(
			getDbAccessor().withReadDb(
				(db) =>
					db.prepare("SELECT status, reason FROM imported_source_lifecycle WHERE source_id = ?").get(sourceId) as {
						status: string;
						reason: string;
					},
			),
		).toEqual({ status: "unsupported", reason: "source removed by user" });
		expect(
			getDbAccessor().withReadDb(
				(db) =>
					db
						.prepare("SELECT kind, subject_ref FROM dreaming_attention WHERE subject_ref = ?")
						.get(`source:${sourceId}`) as {
						kind: string;
						subject_ref: string;
					},
			),
		).toEqual({ kind: "hygiene", subject_ref: `source:${sourceId}` });
	});

	it("keeps imported evidence and canonical embeddings retryable when vec cleanup fails", async () => {
		const sourceId = "source-import-vec-failure";
		const agentId = "lifecycle-test-agent";
		const otherAgentId = "other-agent";
		const now = new Date().toISOString();
		await indexExternalMemoryArtifact({
			agentId,
			sourcePath: "imports/source-import-vec-failure/notes.json",
			sourceKind: "source_import_json_projection",
			harness: "dashboard-import",
			content: "Retryable imported evidence",
			sourceMtimeMs: Date.now(),
			sourceId,
			sourceRoot: "notes.json",
			sourceExternalId: "hash-vec-failure",
			sourceMeta: { representation: "structured-json-projection" },
		});
		getDbAccessor().withWriteTx((db) => {
			// Replace the migration's virtual table with a regular test double so a
			// trigger can inject a derived-index delete failure deterministically.
			db.exec("DROP TABLE vec_embeddings");
			db.exec("CREATE TABLE vec_embeddings (id TEXT PRIMARY KEY, embedding BLOB NOT NULL)");
			db.prepare(
				`INSERT INTO embeddings
				 (id, content_hash, vector, dimensions, source_type, source_id, chunk_text, created_at, agent_id)
				 VALUES (?, ?, ?, 3, 'source_chunk', ?, ?, ?, ?)`,
			).run(
				"embedding-owned",
				"hash-owned",
				Buffer.from(new Float32Array([1, 2, 3]).buffer),
				`${sourceId}:notes.json#1`,
				"owned",
				now,
				agentId,
			);
			db.prepare(
				`INSERT INTO embeddings
				 (id, content_hash, vector, dimensions, source_type, source_id, chunk_text, created_at, agent_id)
				 VALUES (?, ?, ?, 3, 'source_chunk', ?, ?, ?, ?)`,
			).run(
				"embedding-other",
				"hash-other",
				Buffer.from(new Float32Array([4, 5, 6]).buffer),
				`${sourceId}:other.json#1`,
				"other",
				now,
				otherAgentId,
			);
			db.prepare("INSERT INTO vec_embeddings (id, embedding) VALUES (?, ?)").run(
				"embedding-owned",
				Buffer.from(new Float32Array([1, 2, 3]).buffer),
			);
			db.prepare("INSERT INTO vec_embeddings (id, embedding) VALUES (?, ?)").run(
				"embedding-other",
				Buffer.from(new Float32Array([4, 5, 6]).buffer),
			);
			db.exec(
				"CREATE TRIGGER reject_vec_delete BEFORE DELETE ON vec_embeddings BEGIN SELECT RAISE(ABORT, 'injected vec delete failure'); END",
			);
		});

		expect(() => markImportedSourceUnsupported({ sourceId, agentId })).toThrow(
			"failed to reconcile vec_embeddings before imported-source cleanup",
		);

		const afterFailure = getDbAccessor().withReadDb((db) => ({
			artifact: db
				.prepare("SELECT source_id FROM memory_artifacts WHERE source_id = ? AND agent_id = ?")
				.get(sourceId, agentId),
			ownedEmbedding: db.prepare("SELECT id FROM embeddings WHERE id = ?").get("embedding-owned"),
			ownedVector: db.prepare("SELECT id FROM vec_embeddings WHERE id = ?").get("embedding-owned"),
			lifecycle: db
				.prepare("SELECT id FROM imported_source_lifecycle WHERE source_id = ? AND agent_id = ?")
				.get(sourceId, agentId),
			otherEmbedding: db
				.prepare("SELECT id FROM embeddings WHERE id = ? AND agent_id = ?")
				.get("embedding-other", otherAgentId),
			otherVector: db.prepare("SELECT id FROM vec_embeddings WHERE id = ?").get("embedding-other"),
		}));
		expect(afterFailure.artifact).toEqual({ source_id: sourceId });
		expect(afterFailure.ownedEmbedding).toEqual({ id: "embedding-owned" });
		expect(afterFailure.ownedVector).toEqual({ id: "embedding-owned" });
		expect(afterFailure.lifecycle).toBeNull();
		expect(afterFailure.otherEmbedding).toEqual({ id: "embedding-other" });
		expect(afterFailure.otherVector).toEqual({ id: "embedding-other" });
	});
});
