import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let app: {
	request: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
};
let dir = "";
let prev: string | undefined;
let closeDbAccessor: (() => void) | undefined;
let getDbAccessor:
	| (() => {
			withWriteTx: (fn: (db: import("bun:sqlite").Database) => void) => void;
	  })
	| undefined;
let bypassSession: ((sessionKey: string, opts?: { readonly allowUnknown?: boolean }) => boolean) | undefined;

describe("/api/hooks/recall", () => {
	beforeAll(async () => {
		prev = process.env.SIGNET_PATH;
		dir = mkdtempSync(join(tmpdir(), "signet-hooks-recall-"));
		mkdirSync(join(dir, "memory"), { recursive: true });
		writeFileSync(
			join(dir, "agent.yaml"),
			`memory:
  pipelineV2:
    enabled: false
`,
		);
		process.env.SIGNET_PATH = dir;

		const dbAccessor = await import("./db-accessor");
		dbAccessor.initDbAccessor(join(dir, "memory", "memories.db"));
		closeDbAccessor = dbAccessor.closeDbAccessor;
		getDbAccessor = () => dbAccessor.getDbAccessor();
		const tracker = await import("./session-tracker");
		bypassSession = tracker.bypassSession;

		const daemon = await import("./daemon");
		app = daemon.app;
	});

	afterAll(() => {
		if (prev === undefined) {
			Reflect.deleteProperty(process.env as Record<string, string | undefined>, "SIGNET_PATH");
		} else {
			process.env.SIGNET_PATH = prev;
		}
		closeDbAccessor?.();
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			// cleanup best-effort
		}
	});

	it("returns 200 on valid recall request", async () => {
		const resp = await app.request("/api/hooks/recall", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				harness: "openclaw",
				query: "test query",
				limit: 5,
			}),
		});

		// The route should resolve without crashing (no cfg ReferenceError),
		// even if the DB isn't fully initialized — the key contract is no 500.
		expect(resp.status).toBe(200);
		const body = await resp.json();
		expect(body.error).not.toBe("Hook execution failed");
		expect(body.meta?.noHits).toBeTrue();
		expect(body.memories).toEqual(body.results);
		expect(body.count).toBe(body.results.length);
	});

	it("rejects requests missing harness", async () => {
		const resp = await app.request("/api/hooks/recall", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ query: "test" }),
		});

		expect(resp.status).toBe(400);
	});

	it("rejects requests missing query", async () => {
		const resp = await app.request("/api/hooks/recall", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ harness: "openclaw" }),
		});

		expect(resp.status).toBe(400);
	});

	it("returns the normalized no-op shape for internal calls", async () => {
		const resp = await app.request("/api/hooks/recall", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"x-signet-no-hooks": "1",
			},
			body: JSON.stringify({
				harness: "openclaw",
				query: "test query",
			}),
		});

		expect(resp.status).toBe(200);
		const body = await resp.json();
		expect(body).toMatchObject({
			results: [],
			memories: [],
			count: 0,
			query: "",
			method: "hybrid",
			meta: {
				totalReturned: 0,
				hasSupplementary: false,
				noHits: true,
			},
			internal: true,
		});
	});

	it("returns the normalized no-op shape for bypassed sessions", async () => {
		bypassSession?.("session-bypass", { allowUnknown: true });

		const resp = await app.request("/api/hooks/recall", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				harness: "openclaw",
				query: "test query",
				sessionKey: "session-bypass",
			}),
		});

		expect(resp.status).toBe(200);
		const body = await resp.json();
		expect(body).toMatchObject({
			results: [],
			memories: [],
			count: 0,
			query: "test query",
			method: "hybrid",
			meta: {
				totalReturned: 0,
				hasSupplementary: false,
				noHits: true,
			},
			bypassed: true,
		});
	});

	it("treats project as project filtering instead of scope filtering", async () => {
		const now = new Date().toISOString();
		getDbAccessor?.().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO memories (
					id, content, type, source_id, agent_id, project, created_at, updated_at, updated_by
				) VALUES (?, ?, 'fact', ?, ?, ?, ?, ?, 'test')`,
			).run("mem-proj-a", "deploy checklist for alpha", "sess-a", "default", "proj-a", now, now);
			db.prepare(
				`INSERT INTO memories (
					id, content, type, source_id, agent_id, project, created_at, updated_at, updated_by
				) VALUES (?, ?, 'fact', ?, ?, ?, ?, ?, 'test')`,
			).run("mem-proj-b", "deploy checklist for beta", "sess-b", "default", "proj-b", now, now);
		});

		const resp = await app.request("/api/hooks/recall", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				harness: "openclaw",
				query: "deploy checklist",
				project: "proj-a",
				limit: 5,
			}),
		});

		expect(resp.status).toBe(200);
		const body = await resp.json();
		expect(Array.isArray(body.results)).toBeTrue();
		expect(body.results.map((row: { id: string }) => row.id)).toContain("mem-proj-a");
		expect(body.results.map((row: { id: string }) => row.id)).not.toContain("mem-proj-b");
		expect(body.memories).toEqual(body.results);
		expect(body.count).toBe(body.results.length);
		expect(body.query).toBe("deploy checklist");
		expect(body.meta?.noHits).toBeFalse();
	});

	it("forwards type filtering through to hybrid recall", async () => {
		const now = new Date().toISOString();
		getDbAccessor?.().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO memories (
					id, content, type, source_id, agent_id, project, created_at, updated_at, updated_by
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'test')`,
			).run("mem-type-fact", "deploy release checklist", "fact", "sess-type-a", "default", "proj-type", now, now);
			db.prepare(
				`INSERT INTO memories (
					id, content, type, source_id, agent_id, project, created_at, updated_at, updated_by
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'test')`,
			).run(
				"mem-type-decision",
				"deploy release checklist",
				"decision",
				"sess-type-b",
				"default",
				"proj-type",
				now,
				now,
			);
		});

		const resp = await app.request("/api/hooks/recall", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				harness: "openclaw",
				query: "deploy release checklist",
				project: "proj-type",
				type: "decision",
				limit: 5,
			}),
		});

		expect(resp.status).toBe(200);
		const body = await resp.json();
		expect(Array.isArray(body.results)).toBeTrue();
		expect(body.results.map((row: { id: string }) => row.id)).toContain("mem-type-decision");
		expect(body.results.map((row: { id: string }) => row.id)).not.toContain("mem-type-fact");
		expect(body.memories).toEqual(body.results);
		expect(body.count).toBe(body.results.length);
	});
});
