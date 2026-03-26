import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "./db-accessor";

let app: {
	request: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
};
let dir = "";
let prev: string | undefined;

function jsonHeader(): HeadersInit {
	return { "Content-Type": "application/json" };
}

function seedNode(id: string, agentId: string, project = "proj-a"): void {
	const now = new Date().toISOString();
	getDbAccessor().withWriteTx((db) => {
		db.prepare(
			`INSERT INTO session_summaries (
				id, project, depth, kind, content, token_count,
				earliest_at, latest_at, session_key, harness,
				agent_id, source_type, source_ref, meta_json, created_at
			) VALUES (?, ?, 0, 'session', ?, 10, ?, ?, ?, 'codex', ?, 'summary', ?, NULL, ?)`,
		).run(id, project, `${agentId} summary`, now, now, `${id}-sess`, agentId, `${id}-sess`, now);
	});
}

describe("temporal summary API auth", () => {
	beforeAll(async () => {
		prev = process.env.SIGNET_PATH;
		dir = mkdtempSync(join(tmpdir(), "signet-temporal-api-"));
		mkdirSync(join(dir, "memory"), { recursive: true });
		writeFileSync(
			join(dir, "agent.yaml"),
			`memory:
  pipelineV2:
    enabled: false
`,
		);
		process.env.SIGNET_PATH = dir;

		const daemon = await import("./daemon");
		app = daemon.app;
	});

	beforeEach(() => {
		closeDbAccessor();
		rmSync(join(dir, "memory", "memories.db"), { force: true });
		rmSync(join(dir, "memory", "memories.db-shm"), { force: true });
		rmSync(join(dir, "memory", "memories.db-wal"), { force: true });
		initDbAccessor(join(dir, "memory", "memories.db"));
		seedNode("node-a", "agent-a");
		seedNode("node-b", "agent-b");
	});

	afterEach(() => {
		closeDbAccessor();
	});

	afterAll(() => {
		closeDbAccessor();
		if (prev === undefined) {
			process.env.SIGNET_PATH = undefined;
		} else {
			process.env.SIGNET_PATH = prev;
		}
		rmSync(dir, { recursive: true, force: true });
	});

	it("serves /api/sessions/summaries without falling through the session detail route", async () => {
		const res = await app.request("http://localhost/api/sessions/summaries?agentId=agent-a", {
			headers: jsonHeader(),
		});
		const json = (await res.json()) as {
			summaries?: Array<{ id: string }>;
			total?: number;
		};

		expect(res.status).toBe(200);
		expect(json.total).toBe(1);
		expect(json.summaries?.map((row) => row.id)).toEqual(["node-a"]);
	});

	it("expands the requested temporal node", async () => {
		const res = await app.request("http://localhost/api/sessions/summaries/expand", {
			method: "POST",
			headers: jsonHeader(),
			body: JSON.stringify({
				id: "node-a",
				agentId: "agent-a",
			}),
		});
		const json = (await res.json()) as { node?: { id: string } };

		expect(res.status).toBe(200);
		expect(json.node?.id).toBe("node-a");
	});

	it("stores compaction summary tags as comma-delimited text", async () => {
		const res = await app.request("http://localhost/api/hooks/compaction-complete", {
			method: "POST",
			headers: jsonHeader(),
			body: JSON.stringify({
				harness: "codex",
				summary: "condensed summary",
				agentId: "agent-a",
			}),
		});

		expect(res.status).toBe(200);

		const row = getDbAccessor().withReadDb((db) =>
			db.prepare("SELECT tags FROM memories WHERE type = 'session_summary' ORDER BY created_at DESC LIMIT 1").get(),
		) as { tags?: string } | undefined;

		expect(row?.tags).toBe("session,summary,codex");
	});

	it("uses explicit project fallback when compaction lands before transcript persistence", async () => {
		const res = await app.request("http://localhost/api/hooks/compaction-complete", {
			method: "POST",
			headers: jsonHeader(),
			body: JSON.stringify({
				harness: "codex",
				summary: "compaction before transcript flush",
				project: "proj-fallback",
				agentId: "agent-a",
			}),
		});

		expect(res.status).toBe(200);

		const row = getDbAccessor().withReadDb((db) =>
			db.prepare("SELECT project FROM memories WHERE type = 'session_summary' ORDER BY created_at DESC LIMIT 1").get(),
		) as { project?: string } | undefined;

		expect(row?.project).toBe("proj-fallback");
	});
});
