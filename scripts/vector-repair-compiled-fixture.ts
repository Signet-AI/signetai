import { Database } from "bun:sqlite";
import { applyVectorRepairBatch } from "../platform/daemon/src/vector-repair-owner";
import type { DbOwnerVectorRepairInput } from "../platform/daemon/src/db-owner-protocol";

const rowCount = Number.parseInt(process.argv[2] ?? "5000", 10);
const db = new Database(":memory:");
db.exec(`
	CREATE TABLE memories (
		id TEXT PRIMARY KEY,
		content TEXT NOT NULL,
		content_hash TEXT,
		agent_id TEXT,
		is_deleted INTEGER NOT NULL DEFAULT 0
	);
	CREATE TABLE embeddings (
		id TEXT PRIMARY KEY,
		content_hash TEXT NOT NULL UNIQUE,
		vector BLOB NOT NULL,
		dimensions INTEGER NOT NULL,
		source_type TEXT NOT NULL,
		source_id TEXT NOT NULL,
		chunk_text TEXT,
		created_at TEXT NOT NULL,
		agent_id TEXT
	);
	CREATE TABLE vec_embeddings (id TEXT PRIMARY KEY, embedding BLOB NOT NULL);
	CREATE TABLE vector_repair_checkpoints (
		operation TEXT NOT NULL,
		agent_id TEXT NOT NULL,
		checkpoint_id TEXT NOT NULL UNIQUE,
		phase TEXT NOT NULL,
		cursor TEXT,
		processed INTEGER NOT NULL DEFAULT 0,
		skipped INTEGER NOT NULL DEFAULT 0,
		failed INTEGER NOT NULL DEFAULT 0,
		affected INTEGER NOT NULL DEFAULT 0,
		remaining INTEGER NOT NULL DEFAULT 0,
		status TEXT NOT NULL DEFAULT 'running',
		last_error TEXT,
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL,
		PRIMARY KEY (operation, agent_id)
	);
	CREATE TABLE memory_history (
		id TEXT PRIMARY KEY,
		memory_id TEXT NOT NULL,
		event TEXT NOT NULL,
		old_content TEXT,
		new_content TEXT,
		changed_by TEXT NOT NULL,
		reason TEXT,
		metadata TEXT,
		created_at TEXT NOT NULL,
		actor_type TEXT,
		session_id TEXT,
		request_id TEXT
	);
`);

const now = new Date().toISOString();
const insertMemory = db.prepare(
	"INSERT INTO memories (id, content, content_hash, agent_id) VALUES (?, ?, ?, 'default')",
);
const insertEmbedding = db.prepare(
	"INSERT INTO embeddings (id, content_hash, vector, dimensions, source_type, source_id, chunk_text, created_at, agent_id) VALUES (?, ?, ?, 3, 'memory', ?, ?, ?, 'default')",
);
const vector = Buffer.from(new Float32Array([1, 2, 3]).buffer);
db.exec("BEGIN");
for (let index = 0; index < rowCount; index += 1) {
	const memoryId = `memory-${index}`;
	const hash = `hash-${index}`;
	insertMemory.run(memoryId, `large corpus memory ${index}`, hash);
	insertEmbedding.run(`embedding-${index}`, hash, vector, memoryId, `large corpus memory ${index}`, now);
}
db.exec("COMMIT");

const input: DbOwnerVectorRepairInput = {
	operation: "resync",
	agentId: "default",
	checkpointId: "compiled-large-corpus",
	batchSize: 50,
	maxVectorBytes: 256 * 1024,
	audit: {
		action: "resyncVectorIndex",
		actor: "compiled-regression",
		reason: "compiled large-corpus regression",
		actorType: "operator",
	},
};
let result = { status: "running", processed: 0, remaining: rowCount } as {
	status: string;
	processed: number;
	remaining: number;
};
let maxBatchRows = 0;
let maxBatchBytes = 0;
const latencies: number[] = [];
let measuring = true;
const measureLoop = async (): Promise<void> => {
	while (measuring) {
		const started = performance.now();
		await new Promise<void>((resolve) => setImmediate(resolve));
		latencies.push(performance.now() - started);
	}
};
const measuringPromise = measureLoop();
const rssBefore = process.memoryUsage().rss;
let batches = 0;
while (result.status !== "complete") {
	db.exec("BEGIN IMMEDIATE");
	try {
		const batch = applyVectorRepairBatch(db as never, input);
		db.exec("COMMIT");
		result = batch;
		maxBatchRows = Math.max(maxBatchRows, batch.batchRows);
		maxBatchBytes = Math.max(maxBatchBytes, batch.batchBytes);
		batches += 1;
		if (batches > Math.ceil(rowCount / 50) + 5) throw new Error("compiled vector repair did not converge");
	} catch (error) {
		db.exec("ROLLBACK");
		throw error;
	}
	await new Promise<void>((resolve) => setImmediate(resolve));
}
measuring = false;
await measuringPromise;
const rssAfter = process.memoryUsage().rss;
process.stdout.write(
	`${JSON.stringify({
		status: result.status,
		processed: result.processed,
		remaining: result.remaining,
		batches,
		maxBatchRows,
		maxBatchBytes,
		rssDeltaMb: Math.round((rssAfter - rssBefore) / 1024 / 1024),
		maxEventLoopLatencyMs: Math.max(...latencies, 0),
	})}\n`,
);
db.close();
