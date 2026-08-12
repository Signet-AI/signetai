import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { runMigrations } from "../../../core/src/migrations";
import { createConcurrencyAdmission } from "../concurrency-admission";
import type { DbAccessor, ReadDb, WriteDb } from "../db-accessor";
import type { EmbeddingConfig, PipelineV2Config } from "../memory-config";
import { DEFAULT_PIPELINE_V2 } from "../memory-config";
import { startDocumentWorker } from "./document-worker";

function freshDb(): Database {
	const db = new Database(":memory:");
	runMigrations(db as unknown as Parameters<typeof runMigrations>[0]);
	return db;
}

function asAccessor(db: Database): DbAccessor {
	return {
		withWriteTx<T>(fn: (wdb: WriteDb) => T): T {
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
		withReadDb<T>(fn: (rdb: ReadDb) => T): T {
			return fn(db as unknown as ReadDb);
		},
		close(): void {
			db.close();
		},
	};
}

const embeddingCfg: EmbeddingConfig = {
	provider: "none",
	model: "test",
	dimensions: 1,
	base_url: "",
};

function workerConfig(): PipelineV2Config {
	return {
		...DEFAULT_PIPELINE_V2,
		documents: {
			...DEFAULT_PIPELINE_V2.documents,
			workerIntervalMs: 1,
			chunkSize: 1_000,
			chunkOverlap: 0,
		},
	};
}

function insertDocumentJob(db: Database, id: string, agentId: string, content: string): void {
	const now = new Date().toISOString();
	db.prepare(
		`INSERT INTO agents (id, name, read_policy, created_at, updated_at)
		 VALUES (?, ?, 'isolated', ?, ?)`,
	).run(agentId, agentId, now, now);
	db.prepare(
		`INSERT INTO documents
		 (id, source_type, content_type, content_hash, title, raw_content, status,
		  chunk_count, memory_count, agent_id, project, created_at, updated_at)
		 VALUES (?, 'text', 'text/plain', ?, ?, ?, 'queued', 0, 0, ?, NULL, ?, ?)`,
	).run(id, `${id}-hash`, id, content, agentId, now, now);
	db.prepare(
		`INSERT INTO memory_jobs
		 (id, memory_id, document_id, job_type, status, attempts, max_attempts, created_at, updated_at)
		 VALUES (?, NULL, ?, 'document_ingest', 'pending', 0, 3, ?, ?)`,
	).run(`${id}-job`, id, now, now);
}

async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (condition()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error("timed out waiting for document worker");
}

function jobStatus(db: Database, id: string): string {
	return (db.prepare("SELECT status FROM memory_jobs WHERE id = ?").get(id) as { status: string }).status;
}

describe("document worker admission", () => {
	it("shares the cap across worker instances before leasing another job", async () => {
		const db = freshDb();
		const accessor = asAccessor(db);
		insertDocumentJob(db, "doc-a", "agent-a", "slow");
		insertDocumentJob(db, "doc-b", "agent-b", "other");
		const admission = createConcurrencyAdmission(1);
		const started: string[] = [];
		let unblock = (): void => {};
		const blocked = new Promise<number[] | null>((resolve) => {
			unblock = () => resolve(null);
		});
		const config = workerConfig();
		const makeDeps = () => ({
			accessor,
			admission,
			embeddingCfg,
			fetchEmbedding: async (content: string): Promise<number[] | null> => {
				started.push(content);
				if (content === "slow") return blocked;
				return null;
			},
			pipelineCfg: config,
		});
		const workerA = startDocumentWorker(makeDeps());
		const workerB = startDocumentWorker(makeDeps());
		try {
			await waitFor(() => started.length === 1);
			await new Promise((resolve) => setTimeout(resolve, 25));
			expect(started).toEqual(["slow"]);
			expect(admission.inFlight()).toBe(1);
			expect(workerA.inFlight).toBe(1);
			expect(workerB.inFlight).toBe(1);
			expect(workerA.maxInFlight).toBe(1);
			expect(jobStatus(db, "doc-a-job")).toBe("leased");
			expect(jobStatus(db, "doc-b-job")).toBe("pending");

			unblock();
			await waitFor(() => jobStatus(db, "doc-a-job") === "completed" && jobStatus(db, "doc-b-job") === "completed");
		} finally {
			unblock();
			await Promise.all([workerA.stop(), workerB.stop()]);
			db.close();
		}
	});

	it("releases admission after failure so another agent's job is not starved", async () => {
		const db = freshDb();
		const accessor = asAccessor(db);
		insertDocumentJob(db, "doc-fail", "agent-a", "fail");
		insertDocumentJob(db, "doc-ok", "agent-b", "ok");
		const started: string[] = [];
		const worker = startDocumentWorker({
			accessor,
			admission: createConcurrencyAdmission(1),
			embeddingCfg,
			fetchEmbedding: async (content: string): Promise<number[] | null> => {
				started.push(content);
				if (content === "fail") throw new Error("provider unavailable");
				return null;
			},
			pipelineCfg: workerConfig(),
		});
		try {
			await waitFor(() => jobStatus(db, "doc-ok-job") === "completed");
			expect(started).toContain("ok");
			expect(jobStatus(db, "doc-fail-job")).not.toBe("leased");
		} finally {
			await worker.stop();
			db.close();
		}
	});
});
