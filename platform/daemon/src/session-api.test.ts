import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { Hono } from "hono";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearAllPresence, upsertAgentPresence } from "./cross-agent";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "./db-accessor";
import { isSessionBypassed, unbypassSession } from "./session-tracker";

let app: Hono;
let dir = "";
let prev: string | undefined;

function jsonHeader(): HeadersInit {
	return { "Content-Type": "application/json" };
}

describe("session API", () => {
	beforeAll(async () => {
		prev = process.env.SIGNET_PATH;
		dir = mkdtempSync(join(tmpdir(), "signet-session-api-"));
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
		clearAllPresence();
		unbypassSession("sess-live");
	});

	afterEach(() => {
		closeDbAccessor();
		clearAllPresence();
		unbypassSession("sess-live");
	});

	afterAll(() => {
		closeDbAccessor();
		clearAllPresence();
		if (prev === undefined) {
			process.env.SIGNET_PATH = undefined;
		} else {
			process.env.SIGNET_PATH = prev;
		}
		rmSync(dir, { recursive: true, force: true });
	});

	it("lists live presence sessions even when no tracker claim exists", async () => {
		upsertAgentPresence({
			sessionKey: "sess-live",
			agentId: "default",
			harness: "codex",
			project: "proj-a",
			runtimePath: "plugin",
			provider: "codex",
		});

		const res = await app.request("http://localhost/api/sessions", {
			headers: jsonHeader(),
		});
		const json = (await res.json()) as {
			sessions?: Array<{ key: string }>;
			count?: number;
		};

		expect(res.status).toBe(200);
		expect(json.count).toBe(1);
		expect(json.sessions?.[0]?.key).toBe("sess-live");
	});

	it("accepts prefixed session keys for bypass toggles", async () => {
		upsertAgentPresence({
			sessionKey: "sess-live",
			agentId: "default",
			harness: "codex",
			project: "proj-a",
			runtimePath: "plugin",
			provider: "codex",
		});

		const res = await app.request("http://localhost/api/sessions/session%3Asess-live/bypass", {
			method: "POST",
			headers: jsonHeader(),
			body: JSON.stringify({ enabled: true }),
		});
		const json = (await res.json()) as { key?: string; bypassed?: boolean };

		expect(res.status).toBe(200);
		expect(json.key).toBe("sess-live");
		expect(json.bypassed).toBe(true);
		expect(isSessionBypassed("sess-live")).toBe(true);
	});

	it("search uses configured daemon agent id fallback for exact stored session", async () => {
		const previous = process.env.SIGNET_AGENT_ID;
		process.env.SIGNET_AGENT_ID = "noam";
		try {
			const now = new Date().toISOString();
			getDbAccessor().withWriteTx((db) => {
				db.prepare(
					`INSERT INTO session_transcripts
					 (session_key, content, harness, project, agent_id, created_at, updated_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?)`,
				).run(
					"019f3a7a-218f-7000-b6a3-0dcc8801a625",
					"User: mesh PR 9147 9146 session content. Assistant: stored noam hit.",
					"oh-my-pi",
					"/repo-a",
					"noam",
					now,
					now,
				);
				db.prepare(
					`INSERT INTO session_transcripts
					 (session_key, content, harness, project, agent_id, created_at, updated_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?)`,
				).run(
					"default-agent-row",
					"User: default agent should not win exact lookup.",
					"oh-my-pi",
					"/repo-a",
					"default",
					now,
					now,
				);
			});

			const res = await app.request("http://localhost/api/sessions/search", {
				method: "POST",
				headers: jsonHeader(),
				body: JSON.stringify({ query: "019f3a7a-218f-7000-b6a3-0dcc8801a625", limit: 5 }),
			});
			const json = (await res.json()) as { hits?: Array<{ sessionKey: string }> };

			expect(res.status).toBe(200);
			expect(json.hits?.map((hit) => hit.sessionKey)).toContain("019f3a7a-218f-7000-b6a3-0dcc8801a625");
			expect(json.hits?.map((hit) => hit.sessionKey)).not.toContain("default-agent-row");
		} finally {
			if (previous === undefined) {
				process.env.SIGNET_AGENT_ID = undefined;
			} else {
				process.env.SIGNET_AGENT_ID = previous;
			}
		}
	});

	it("filters summaries by session_key", async () => {
		const now = new Date().toISOString();
		getDbAccessor().withWriteTx((db) => {
			const stmt = db.prepare(
				`INSERT INTO session_summaries
				 (id, project, depth, kind, content, token_count, earliest_at, latest_at,
				  session_key, harness, agent_id, source_type, source_ref, meta_json, created_at)
				 VALUES (?, ?, 0, 'session', ?, 10, ?, ?, ?, 'test', 'noam', 'summary_job', ?, '{}', ?)`,
			);
			stmt.run("sum-target", "/repo-a", "target summary", now, now, "target-session", "job-target", now);
			stmt.run("sum-other", "/repo-a", "other summary", now, now, "other-session", "job-other", now);
		});

		const res = await app.request("http://localhost/api/sessions/summaries?agent_id=noam&session_key=target-session");
		const json = (await res.json()) as { total?: number; summaries?: Array<{ session_key: string }> };

		expect(res.status).toBe(200);
		expect(json.total).toBe(1);
		expect(json.summaries?.map((summary) => summary.session_key)).toEqual(["target-session"]);
	});

	it("returns stored session metadata and transcript when no live session exists", async () => {
		const now = new Date().toISOString();
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO session_transcripts
				 (session_key, content, harness, project, agent_id, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			).run("stored-session", "stored transcript content", "oh-my-pi", "/repo-a", "noam", now, now);
		});

		const sessionRes = await app.request("http://localhost/api/sessions/stored-session?agent_id=noam");
		const sessionJson = (await sessionRes.json()) as { status?: string; sessionKey?: string; runtimePath?: string };
		expect(sessionRes.status).toBe(200);
		expect(sessionJson.status).toBe("stored");
		expect(sessionJson.sessionKey).toBe("stored-session");
		expect(sessionJson.runtimePath).toBe("transcript");

		const transcriptRes = await app.request("http://localhost/api/sessions/stored-session/transcript?agent_id=noam");
		const transcriptJson = (await transcriptRes.json()) as { content?: string };
		expect(transcriptRes.status).toBe(200);
		expect(transcriptJson.content).toBe("stored transcript content");
	});

});
