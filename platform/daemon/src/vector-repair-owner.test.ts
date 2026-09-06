import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { runMigrations } from "../../core/src/migrations";
import type { DbOwnerVectorRepairInput, DbOwnerVectorRepairResult } from "./db-owner-protocol";
import { applyVectorRepairBatch } from "./vector-repair-owner";

let db: Database;

function vectorBlob(values: readonly number[]): Buffer {
	return Buffer.from(new Float32Array(values).buffer);
}

function input(
	agentId: string,
	checkpointId: string,
	batchSize = 50,
	maxVectorBytes = 256 * 1024,
): DbOwnerVectorRepairInput {
	return {
		operation: "resync",
		agentId,
		checkpointId,
		batchSize,
		maxVectorBytes,
		audit: {
			action: "resyncVectorIndex",
			actor: "test-operator",
			reason: "vector repair owner test",
			actorType: "operator",
			requestId: "vector-repair-owner-test",
		},
	};
}

function runBatch(request: DbOwnerVectorRepairInput): DbOwnerVectorRepairResult {
	db.exec("BEGIN IMMEDIATE");
	try {
		const result = applyVectorRepairBatch(db as never, request);
		db.exec("COMMIT");
		return result;
	} catch (error) {
		db.exec("ROLLBACK");
		throw error;
	}
}

function insertMemory(id: string, agentId: string): void {
	const now = new Date().toISOString();
	db.prepare(
		`INSERT INTO memories (id, content, content_hash, agent_id, type, created_at, updated_at, updated_by)
		 VALUES (?, ?, ?, ?, 'fact', ?, ?, 'test')`,
	).run(id, `memory ${id}`, `hash-${id}`, agentId, now, now);
}

function insertEmbedding(id: string, memoryId: string, agentId: string, vector: readonly number[]): void {
	const now = new Date().toISOString();
	db.prepare(
		`INSERT INTO embeddings (id, content_hash, vector, dimensions, source_type, source_id, chunk_text, created_at, agent_id)
		 VALUES (?, ?, ?, ?, 'memory', ?, ?, ?, ?)`,
	).run(id, `hash-${memoryId}`, vectorBlob(vector), vector.length, memoryId, `chunk ${memoryId}`, now, agentId);
}

beforeEach(() => {
	db = new Database(":memory:");
	runMigrations(db as never);
	db.exec("DROP TABLE IF EXISTS vec_embeddings");
	db.exec("CREATE TABLE vec_embeddings (id TEXT PRIMARY KEY, embedding BLOB NOT NULL)");
});

afterEach(() => db.close());

describe("bounded vector repair owner", () => {
	it("commits one keyset page at a time and resumes to completion", () => {
		for (let index = 0; index < 5; index += 1) {
			insertMemory(`memory-${index}`, "agent-a");
			insertEmbedding(`embedding-${index}`, `memory-${index}`, "agent-a", [index, index + 1, index + 2]);
		}
		db.prepare("INSERT INTO vec_embeddings (id, embedding) VALUES (?, ?)").run("orphan", vectorBlob([9, 9, 9]));

		const request = input("agent-a", "checkpoint-resume", 1, 12);
		const operationIds = new Set<string>();
		let result = runBatch(request);
		let batches = 1;
		while (result.status !== "complete") {
			expect(result.batchRows).toBeLessThanOrEqual(1);
			expect(result.batchBytes).toBeLessThanOrEqual(12);
			operationIds.add(result.operationId);
			result = runBatch(request);
			batches += 1;
			if (batches > 20) throw new Error("vector repair did not converge");
		}
		operationIds.add(result.operationId);

		expect(batches).toBeGreaterThan(2);
		expect(result.remaining).toBe(0);
		expect(result.processed).toBe(6);
		expect(result.affected).toBe(6);
		expect(operationIds).toEqual(
			new Set(["repair.vector-resync.orphan-vectors", "repair.vector-resync.missing-vectors"]),
		);
		expect(db.prepare("SELECT COUNT(*) AS n FROM vec_embeddings").get()).toEqual({ n: 5 });
		expect(
			db
				.prepare(
					"SELECT status, cursor, remaining FROM vector_repair_checkpoints WHERE operation = 'resync' AND agent_id = ?",
				)
				.get("agent-a"),
		).toMatchObject({ status: "complete", cursor: null, remaining: 0 });
	});

	it("keeps reconciliation agent-scoped and skips malformed payloads", () => {
		insertMemory("memory-a", "agent-a");
		insertEmbedding("embedding-a", "memory-a", "agent-a", [1, 2, 3]);
		insertMemory("memory-b", "agent-b");
		insertEmbedding("embedding-b", "memory-b", "agent-b", [4, 5, 6]);
		const now = new Date().toISOString();
		db.prepare(
			`INSERT INTO embeddings (id, content_hash, vector, dimensions, source_type, source_id, chunk_text, created_at, agent_id)
			 VALUES ('embedding-bad', 'hash-bad', ?, 0, 'memory', 'missing', 'bad', ?, 'agent-a')`,
		).run(Buffer.from([1, 2]), now);

		const request = input("agent-a", "checkpoint-scope", 50, 12);
		let result = runBatch(request);
		while (result.status !== "complete") {
			result = runBatch(request);
		}

		expect(result.skipped).toBe(1);
		expect(db.prepare("SELECT id FROM vec_embeddings ORDER BY id").all()).toEqual([{ id: "embedding-a" }]);
	});
});
