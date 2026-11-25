import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveThreadKey, deriveThreadLabel, summarizeThreadContent, upsertThreadHead } from "./thread-heads";

const dirs: string[] = [];

function makeDb(): Database {
	const dir = mkdtempSync(join(tmpdir(), "signet-thread-heads-"));
	dirs.push(dir);
	const db = new Database(join(dir, "memories.db"));
	db.exec(`
		CREATE TABLE IF NOT EXISTS memory_thread_heads (
			agent_id TEXT NOT NULL DEFAULT 'default',
			thread_key TEXT NOT NULL,
			label TEXT NOT NULL,
			project TEXT,
			session_key TEXT,
			source_type TEXT NOT NULL DEFAULT 'summary',
			source_ref TEXT,
			harness TEXT,
			node_id TEXT NOT NULL,
			latest_at TEXT NOT NULL,
			sample TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			PRIMARY KEY (agent_id, thread_key)
		)
	`);
	return db;
}

afterEach(() => {
	for (const dir of dirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("thread-heads", () => {
	it("uses project+source scope when source_ref equals session_key", () => {
		const key = deriveThreadKey({
			project: "/tmp/proj",
			sourceRef: "sess-1",
			sessionKey: "sess-1",
			harness: "test",
		});
		expect(key).toBe("project:/tmp/proj|source:sess-1|harness:test");
	});

	it("keeps full project path in labels to avoid basename collisions", () => {
		const label = deriveThreadLabel({
			project: "/mnt/work/client/proj",
			sourceRef: "sess-1",
			sessionKey: "sess-1",
			harness: "test",
		});
		expect(label).toBe("project:/mnt/work/client/proj#source:sess-1#harness:test");
	});

	it("upserts newer thread head state and ignores older writes", () => {
		const db = makeDb();
		upsertThreadHead(db, {
			agentId: "default",
			nodeId: "node-1",
			content: "first sample",
			latestAt: "2026-03-25T10:00:00.000Z",
			project: "/tmp/proj",
			sessionKey: "sess-1",
			sourceType: "summary",
			sourceRef: "lane-a",
			harness: "test",
		});
		upsertThreadHead(db, {
			agentId: "default",
			nodeId: "node-old",
			content: "old sample",
			latestAt: "2026-03-25T09:00:00.000Z",
			project: "/tmp/proj",
			sessionKey: "sess-1",
			sourceType: "summary",
			sourceRef: "lane-a",
			harness: "test",
		});
		upsertThreadHead(db, {
			agentId: "default",
			nodeId: "node-2",
			content: "new sample that should win",
			latestAt: "2026-03-25T11:00:00.000Z",
			project: "/tmp/proj",
			sessionKey: "sess-2",
			sourceType: "compaction",
			sourceRef: "lane-a",
			harness: "test",
		});

		const row = db
			.prepare(
				`SELECT node_id, latest_at, sample, source_type
				 FROM memory_thread_heads
				 WHERE agent_id = ? AND thread_key = ?`,
			)
			.get("default", "project:/tmp/proj|source:lane-a|harness:test") as
			| {
					node_id: string;
					latest_at: string;
					sample: string;
					source_type: string;
			  }
			| undefined;
		db.close();

		expect(row?.node_id).toBe("node-2");
		expect(row?.latest_at).toBe("2026-03-25T11:00:00.000Z");
		expect(row?.source_type).toBe("compaction");
		expect(row?.sample).toContain("new sample");
	});

	it("summarizes long content deterministically", () => {
		const sample = summarizeThreadContent("a".repeat(400), 40);
		expect(sample.length).toBe(40);
		expect(sample.endsWith("...")).toBe(true);
	});
});
