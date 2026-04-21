import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { Hono } from "hono";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "./db-accessor";

let app: Hono;
let agentsDir = "";
const dbFiles = ["memories.db", "memories.db-shm", "memories.db-wal"];
let originalSignetPath: string | undefined;

function resetDbFiles(): void {
	for (const file of dbFiles) {
		rmSync(join(agentsDir, "memory", file), { force: true });
	}
}

function seedSessionMemory(args: { id: string; sessionKey: string; memoryId: string }): void {
	const now = new Date().toISOString();
	getDbAccessor().withWriteTx((db) => {
		db.prepare(
			`INSERT INTO session_memories
			 (id, session_key, memory_id, source, effective_score, final_score, rank, was_injected, fts_hit_count, created_at, path_json)
			 VALUES (?, ?, ?, 'ka_traversal', 0.8, 0.8, 0, 1, 0, ?, NULL)`,
		).run(args.id, args.sessionKey, args.memoryId, now);
	});
}

describe("memory feedback API", () => {
	beforeAll(async () => {
		originalSignetPath = process.env.SIGNET_PATH;
		agentsDir = mkdtempSync(join(tmpdir(), "signet-daemon-feedback-api-"));
		mkdirSync(join(agentsDir, "memory"), { recursive: true });
		writeFileSync(
			join(agentsDir, "agent.yaml"),
			`memory:
  pipelineV2:
    enabled: false
    shadowMode: false
    allowUpdateDelete: true
`,
		);
		process.env.SIGNET_PATH = agentsDir;

		const daemon = await import("./daemon");
		app = daemon.app;
	});

	beforeEach(() => {
		closeDbAccessor();
		resetDbFiles();
		initDbAccessor(join(agentsDir, "memory", "memories.db"));
	});

	afterEach(() => {
		closeDbAccessor();
	});

	afterAll(() => {
		closeDbAccessor();
		if (originalSignetPath === undefined) {
			process.env.SIGNET_PATH = undefined;
		} else {
			process.env.SIGNET_PATH = originalSignetPath;
		}
		rmSync(agentsDir, { recursive: true, force: true });
	});

	it("returns recorded total and accepted subset for mixed feedback ids", async () => {
		seedSessionMemory({
			id: "sm-feedback-1",
			sessionKey: "sess-feedback",
			memoryId: "mem-feedback-1",
		});

		const res = await app.request("http://localhost/api/memory/feedback", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				sessionKey: "sess-feedback",
				feedback: {
					"mem-feedback-1": 1,
					"mem-feedback-missing": -1,
				},
				paths: {
					"mem-feedback-1": {
						entity_ids: ["ent-a"],
					},
					"mem-feedback-missing": {
						entity_ids: ["ent-b"],
					},
				},
			}),
		});
		const json = (await res.json()) as {
			ok?: boolean;
			recorded?: number;
			accepted?: number;
			rejected?: number;
			propagated?: number;
			fallback?: boolean;
			acceptanceRule?: string;
		};

		expect(res.status).toBe(200);
		expect(json.ok).toBe(true);
		expect(json.recorded).toBe(2);
		expect(json.accepted).toBe(1);
		expect(json.rejected).toBe(1);
		expect(json.propagated).toBe(1);
		expect(json.acceptanceRule).toContain("recorded for this session");
		expect(json.fallback).toBeUndefined();
	});
});
