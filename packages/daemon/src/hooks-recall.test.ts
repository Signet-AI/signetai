import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";

let app: Hono;
let dir = "";
let prev: string | undefined;
let closeDbAccessor: (() => void) | undefined;
let getDbAccessor: (() => import("./db-accessor").DbAccessor) | undefined;
let bypassSession: ((sessionKey: string, opts?: { readonly allowUnknown?: boolean }) => boolean) | undefined;
let releaseSession: ((sessionKey: string) => void) | undefined;
let getSessionPath: ((sessionKey: string) => "plugin" | "legacy" | undefined) | undefined;
let getEndedSession: ((sessionKey: string) => { readonly runtimePath?: "plugin" | "legacy" } | undefined) | undefined;

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
		releaseSession = tracker.releaseSession;
		getSessionPath = tracker.getSessionPath;
		getEndedSession = tracker.getEndedSession;

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
		expect(body.message).toBe("No matching memories found.");
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
			message: "No matching memories found.",
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
			message: "No matching memories found.",
			bypassed: true,
		});
	});

	it("skips duplicate user-prompt-submit calls from a conflicting runtime path", async () => {
		const sessionKey = "duplicate-runtime-session";
		try {
			const first = await app.request("/api/hooks/user-prompt-submit", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"x-signet-runtime-path": "plugin",
				},
				body: JSON.stringify({
					harness: "opencode",
					userMessage: "deploy checklist",
					sessionKey,
				}),
			});

			expect(first.status).toBe(200);
			const firstBody = await first.json();
			expect(firstBody.duplicateRuntimePath).not.toBe(true);

			const duplicate = await app.request("/api/hooks/user-prompt-submit", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"x-signet-runtime-path": "legacy",
				},
				body: JSON.stringify({
					harness: "claude-code",
					userMessage: "deploy checklist",
					sessionKey,
				}),
			});

			expect(duplicate.status).toBe(200);
			const duplicateBody = await duplicate.json();
			expect(duplicateBody).toMatchObject({
				inject: "",
				memoryCount: 0,
				skipped: true,
				duplicateRuntimePath: true,
				claimedBy: "plugin",
				sessionKnown: true,
			});
		} finally {
			releaseSession?.(sessionKey);
		}
	});

	it("does not let a duplicate session-end release the owning runtime claim", async () => {
		const sessionKey = "duplicate-session-end";
		try {
			const first = await app.request("/api/hooks/user-prompt-submit", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"x-signet-runtime-path": "plugin",
				},
				body: JSON.stringify({
					harness: "opencode",
					userMessage: "deploy checklist",
					sessionKey,
				}),
			});

			expect(first.status).toBe(200);
			expect(getSessionPath?.(sessionKey)).toBe("plugin");

			const duplicateEnd = await app.request("/api/hooks/session-end", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"x-signet-runtime-path": "legacy",
				},
				body: JSON.stringify({
					harness: "claude-code",
					sessionKey,
					transcript: "user: deploy checklist",
				}),
			});

			expect(duplicateEnd.status).toBe(200);
			expect(await duplicateEnd.json()).toMatchObject({
				memoriesSaved: 0,
				skipped: true,
				duplicateRuntimePath: true,
				claimedBy: "plugin",
			});
			expect(getSessionPath?.(sessionKey)).toBe("plugin");
		} finally {
			releaseSession?.(sessionKey);
		}
	});

	it("skips conflicting automatic lifecycle hooks without surfacing harness errors", async () => {
		const sessionKey = "duplicate-lifecycle-hook";
		try {
			const first = await app.request("/api/hooks/user-prompt-submit", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"x-signet-runtime-path": "plugin",
				},
				body: JSON.stringify({
					harness: "opencode",
					userMessage: "deploy checklist",
					sessionKey,
				}),
			});
			expect(first.status).toBe(200);

			const duplicate = await app.request("/api/hooks/pre-compaction", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"x-signet-runtime-path": "legacy",
				},
				body: JSON.stringify({
					harness: "claude-code",
					sessionKey,
				}),
			});

			expect(duplicate.status).toBe(200);
			expect(await duplicate.json()).toMatchObject({
				guidelines: "",
				instructions: "",
				summaryPrompt: "",
				skipped: true,
				duplicateRuntimePath: true,
				claimedBy: "plugin",
			});
		} finally {
			releaseSession?.(sessionKey);
		}
	});

	it("keeps unmarked session-end calls compatible after a marked runtime ended", async () => {
		const sessionKey = "unmarked-session-end-after-owner";
		try {
			const first = await app.request("/api/hooks/user-prompt-submit", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"x-signet-runtime-path": "plugin",
				},
				body: JSON.stringify({
					harness: "opencode",
					userMessage: "deploy checklist",
					sessionKey,
				}),
			});
			expect(first.status).toBe(200);

			const ownerEnd = await app.request("/api/hooks/session-end", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"x-signet-runtime-path": "plugin",
				},
				body: JSON.stringify({
					harness: "opencode",
					sessionKey,
					transcript: "user: deploy checklist",
				}),
			});
			expect(ownerEnd.status).toBe(200);
			expect(getEndedSession?.(sessionKey)?.runtimePath).toBe("plugin");

			const unmarkedEnd = await app.request("/api/hooks/session-end", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					harness: "unknown-client",
					sessionKey,
					transcript: "user: deploy checklist",
				}),
			});

			expect(unmarkedEnd.status).toBe(200);
			expect(await unmarkedEnd.json()).toMatchObject({
				memoriesSaved: 0,
			});
			expect(getEndedSession?.(sessionKey)?.runtimePath).toBeUndefined();
		} finally {
			releaseSession?.(sessionKey);
		}
	});

	it("skips duplicate session-end calls after the owning runtime already ended", async () => {
		const sessionKey = "duplicate-session-end-after-owner";
		try {
			const first = await app.request("/api/hooks/user-prompt-submit", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"x-signet-runtime-path": "plugin",
				},
				body: JSON.stringify({
					harness: "opencode",
					userMessage: "deploy checklist",
					sessionKey,
				}),
			});
			expect(first.status).toBe(200);

			const ownerEnd = await app.request("/api/hooks/session-end", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"x-signet-runtime-path": "plugin",
				},
				body: JSON.stringify({
					harness: "opencode",
					sessionKey,
					transcript: "user: deploy checklist",
				}),
			});
			expect(ownerEnd.status).toBe(200);
			expect(getSessionPath?.(sessionKey)).toBeUndefined();
			expect(getEndedSession?.(sessionKey)?.runtimePath).toBe("plugin");

			const duplicateEnd = await app.request("/api/hooks/session-end", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"x-signet-runtime-path": "legacy",
				},
				body: JSON.stringify({
					harness: "claude-code",
					sessionKey,
					transcript: "user: deploy checklist",
				}),
			});

			expect(duplicateEnd.status).toBe(200);
			expect(await duplicateEnd.json()).toMatchObject({
				memoriesSaved: 0,
				skipped: true,
				duplicateSessionEnd: true,
				endedBy: "plugin",
			});
		} finally {
			releaseSession?.(sessionKey);
		}
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
