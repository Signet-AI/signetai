import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { Hono } from "hono";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "./db-accessor";

let app: Hono;
let dir = "";
let prev: string | undefined;

function jsonHeader(): HeadersInit {
	return { "Content-Type": "application/json" };
}

function seedKnowledge(): void {
	const now = new Date().toISOString();
	getDbAccessor().withWriteTx((db) => {
		db.prepare(
			`INSERT INTO entities (
				id, name, canonical_name, entity_type, agent_id, pinned, pinned_at, mentions, created_at, updated_at
			) VALUES (?, ?, ?, 'person', 'default', 1, ?, 50, ?, ?)`,
		).run("ent-nicholai", "Nicholai", "nicholai", now, now, now);

		db.prepare(
			`INSERT INTO entities (
				id, name, canonical_name, entity_type, agent_id, pinned, pinned_at, mentions, created_at, updated_at
			) VALUES (?, ?, ?, 'project', 'default', 0, NULL, 10, ?, ?)`,
		).run("ent-signet", "Signet", "signet", now, now);

		db.prepare(
			`INSERT INTO entity_aspects (
				id, entity_id, agent_id, name, canonical_name, weight, created_at, updated_at
			) VALUES (?, ?, 'default', 'overview', 'overview', 0.9, ?, ?)`,
		).run("asp-signet", "ent-signet", now, now);

		db.prepare(
			`INSERT INTO entity_attributes (
				id, aspect_id, agent_id, memory_id, kind, content, normalized_content, confidence, importance, status, created_at, updated_at
			) VALUES (?, 'asp-signet', 'default', NULL, 'attribute', ?, ?, 1, 0.9, 'active', ?, ?)`,
		).run("attr-signet", "portable memory system", "portable memory system", now, now);

		db.prepare(
			`INSERT INTO session_summaries (
				id, project, depth, kind, content, token_count,
				earliest_at, latest_at, session_key, harness,
				agent_id, source_type, source_ref, meta_json, created_at
			) VALUES (?, ?, 0, 'session', ?, 12, ?, ?, ?, 'codex', 'default', 'summary', ?, NULL, ?)`,
		).run(
			"sum-signet",
			"/mnt/work/dev/signet/signetai5",
			"Reviewed Signet daemon dogfood regressions",
			now,
			now,
			"sess-signet",
			"sess-signet",
			now,
		);
	});
}

describe("knowledge expand API", () => {
	beforeAll(async () => {
		prev = process.env.SIGNET_PATH;
		dir = mkdtempSync(join(tmpdir(), "signet-knowledge-expand-"));
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
		seedKnowledge();
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

	it("resolves direct entity expansion by exact name instead of pinned prominence", async () => {
		const res = await app.request("http://localhost/api/knowledge/expand", {
			method: "POST",
			headers: jsonHeader(),
			body: JSON.stringify({ entity: "Signet" }),
		});
		const json = (await res.json()) as { entity?: { name?: string } };

		expect(res.status).toBe(200);
		expect(json.entity?.name).toBe("Signet");
	});

	it("falls back to summary text and project matching for session expansion", async () => {
		const res = await app.request("http://localhost/api/knowledge/expand/session", {
			method: "POST",
			headers: jsonHeader(),
			body: JSON.stringify({ entityName: "Signet", maxResults: 5 }),
		});
		const json = (await res.json()) as {
			entityName?: string;
			total?: number;
			summaries?: Array<{ id: string }>;
		};

		expect(res.status).toBe(200);
		expect(json.entityName).toBe("Signet");
		expect(json.total).toBe(1);
		expect(json.summaries?.[0]?.id).toBe("sum-signet");
	});
});
