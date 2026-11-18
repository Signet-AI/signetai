import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import type { Permission, TokenRole, TokenScope } from "../auth";

const previousSignetPath = process.env.SIGNET_PATH;
let agentsDir: string;
let appFactory: typeof import("hono").Hono;
let createAuthMiddleware: typeof import("../auth").createAuthMiddleware;
let createToken: typeof import("../auth").createToken;
let registerSessionRoutes: typeof import("./session-routes").registerSessionRoutes;
let registerHooksRoutes: typeof import("./hooks-routes").registerHooksRoutes;
let initDbAccessor: typeof import("../db-accessor").initDbAccessor;
let closeDbAccessor: typeof import("../db-accessor").closeDbAccessor;
let presence: typeof import("../cross-agent");
let tracker: typeof import("../session-tracker");
let transcripts: typeof import("../session-transcripts");
let state: typeof import("./state.js");

function writeAuthConfig(mode: "local" | "team"): void {
	writeFileSync(
		join(agentsDir, "agent.yaml"),
		`auth:\n  mode: ${mode}\n  rateLimits:\n    forget:\n      windowMs: 60000\n      max: 30\n    modify:\n      windowMs: 60000\n      max: 60\n    batchForget:\n      windowMs: 60000\n      max: 5\n    admin:\n      windowMs: 60000\n      max: 10\n    recallLlm:\n      windowMs: 60000\n      max: 60\n`,
	);
}

function teamApp(): Hono {
	if (!state.authSecret) throw new Error("expected auth secret in team mode");
	const app = new appFactory();
	app.use("*", createAuthMiddleware(state.authConfig, state.authSecret));
	registerSessionRoutes(app, {
		gitConfig: {
			enabled: false,
			autoCommit: false,
			autoSync: false,
			syncInterval: 300,
			remote: "origin",
			branch: "main",
		},
		stopGitSyncTimer: async () => {},
		startGitSyncTimer: () => {},
		getGitStatus: async () => ({}),
		gitPull: async () => ({}),
		gitPush: async () => ({}),
		gitSync: async () => ({}),
	});
	registerHooksRoutes(app);
	return app;
}

function bearer(
	role: TokenRole,
	options: { readonly scope?: TokenScope; readonly permissions?: readonly Permission[] } = {},
): Record<string, string> {
	if (!state.authSecret) throw new Error("expected auth secret");
	const token = createToken(
		state.authSecret,
		{
			sub: `session-control-${role}`,
			role,
			scope: options.scope ?? { agent: "agent-a" },
			...(options.permissions ? { permissions: options.permissions } : {}),
		},
		60,
	);
	return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}

beforeAll(async () => {
	agentsDir = mkdtempSync(join(tmpdir(), "signet-session-control-"));
	mkdirSync(join(agentsDir, "memory"), { recursive: true });
	mkdirSync(join(agentsDir, ".daemon"), { recursive: true });
	writeFileSync(join(agentsDir, ".daemon", "auth-secret"), "test-secret-key-32-bytes-min!!!!");
	process.env.SIGNET_PATH = agentsDir;
	appFactory = (await import("hono")).Hono;
	({ createAuthMiddleware, createToken } = await import("../auth"));
	({ registerSessionRoutes } = await import("./session-routes"));
	({ registerHooksRoutes } = await import("./hooks-routes"));
	({ initDbAccessor, closeDbAccessor } = await import("../db-accessor"));
	presence = await import("../cross-agent");
	tracker = await import("../session-tracker");
	transcripts = await import("../session-transcripts");
	state = await import("./state.js");
	initDbAccessor(join(agentsDir, "memory", "memories.db"));
	writeAuthConfig("team");
	state.reloadAuthState(agentsDir);
});

beforeEach(() => {
	presence.clearAllPresence();
	tracker.unbypassSession("sess-a", "agent-a");
	tracker.releaseSession("sess-a", "agent-a");
	tracker.releaseSession("sess-b", "agent-b");
	presence.upsertAgentPresence({
		sessionKey: "sess-a",
		agentId: "agent-a",
		harness: "codex",
		project: "proj-a",
		runtimePath: "plugin",
		provider: "codex",
	});
});

afterAll(async () => {
	presence.clearAllPresence();
	tracker.unbypassSession("sess-a", "agent-a");
	writeAuthConfig("local");
	state.reloadAuthState(agentsDir);
	await closeDbAccessor();
	if (previousSignetPath === undefined) Reflect.deleteProperty(process.env, "SIGNET_PATH");
	else process.env.SIGNET_PATH = previousSignetPath;
	rmSync(agentsDir, { recursive: true, force: true });
});

describe("session control permissions in team mode", () => {
	it("deletes the owning agent transcript without creating a summary", async () => {
		await transcripts.upsertSessionTranscriptAsync("delete-owned", "User: wrong store", "codex", "proj-a", "agent-a");
		const res = await teamApp().request("http://localhost/api/sessions/delete-owned/transcript?agent_id=agent-a", {
			method: "DELETE",
			headers: bearer("agent"),
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({
			status: "complete",
			generation: 1,
			retainedPinned: 0,
			counts: { transcripts: 1 },
		});
		expect(await transcripts.getStoredSessionTranscriptInfoAsync("delete-owned", "agent-a")).toBeUndefined();
	});
	it("forgets only attributable memories and retains mixed and pinned evidence", async () => {
		const { getDbAccessor } = await import("../db-accessor");
		await transcripts.upsertSessionTranscriptAsync("delete-lineage", "User: lineage", "codex", "proj-a", "agent-a");
		await getDbAccessor().withWriteTxAsync((db) => {
			for (const [id, pinned] of [
				["delete-single", 0],
				["delete-mixed", 0],
				["delete-pinned", 1],
				["delete-descendant", 0],
			] as const) {
				db.prepare(
					"INSERT INTO memories (id, content, type, agent_id, pinned, created_at, updated_at) VALUES (?, ?, 'fact', 'agent-a', ?, datetime('now'), datetime('now'))",
				).run(id, id, pinned);
				db.prepare(
					"INSERT INTO derived_memory_sources (derived_memory_id, source_kind, source_id, agent_id, created_at) VALUES (?, ?, ?, 'agent-a', datetime('now'))",
				).run(
					id,
					id === "delete-descendant" ? "memory" : "transcript",
					id === "delete-descendant" ? "delete-single" : "delete-lineage",
				);
			}
			db.prepare(
				"UPDATE memories SET source_type = 'transcript', source_id = 'delete-lineage' WHERE id = 'delete-mixed'",
			).run();
			db.prepare(
				"INSERT INTO derived_memory_sources (derived_memory_id, source_kind, source_id, agent_id, created_at) VALUES ('delete-mixed', 'transcript', 'unrelated-session', 'agent-a', datetime('now'))",
			).run();
		});
		const res = await teamApp().request("http://localhost/api/sessions/delete-lineage/transcript?agent_id=agent-a", {
			method: "DELETE",
			headers: bearer("agent"),
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({
			status: "complete",
			retainedPinned: 1,
			counts: { memories: 2, retainedMixed: 1 },
		});
		const rows = await getDbAccessor().withReadDbAsync((db) =>
			db.prepare("SELECT id,is_deleted,stale_at FROM memories WHERE id LIKE 'delete-%' ORDER BY id").all(),
		);
		expect(rows).toEqual([
			{ id: "delete-descendant", is_deleted: 1, stale_at: expect.anything() },
			{ id: "delete-mixed", is_deleted: 0, stale_at: expect.any(String) },
			{ id: "delete-pinned", is_deleted: 0, stale_at: expect.any(String) },
			{ id: "delete-single", is_deleted: 1, stale_at: null },
		]);
		const edges = await getDbAccessor().withReadDbAsync((db) =>
			db.prepare("SELECT source_id FROM derived_memory_sources WHERE derived_memory_id = 'delete-mixed'").all(),
		);
		expect(edges).toEqual([{ source_id: "unrelated-session" }]);
		expect(
			await getDbAccessor().withReadDbAsync((db) =>
				db.prepare("SELECT source_type,source_id FROM memories WHERE id = 'delete-mixed'").get(),
			),
		).toEqual({ source_type: null, source_id: null });
		const review = await getDbAccessor().withReadDbAsync((db) =>
			db
				.prepare(
					"SELECT kind FROM dreaming_attention WHERE agent_id = 'agent-a' AND subject_ref = 'memory:delete-mixed' AND resolved_at IS NULL",
				)
				.get(),
		);
		expect(review).toEqual({ kind: "evidence_requeue" });
	});

	it("retains a memory whose explicit non-session source shares the deleted key", async () => {
		const { getDbAccessor } = await import("../db-accessor");
		await transcripts.upsertSessionTranscriptAsync("source-collision", "User: session", "codex", "proj-a", "agent-a");
		await getDbAccessor().withWriteTxAsync((db) => {
			db.prepare(
				"INSERT INTO memories (id,content,type,source_type,source_id,agent_id,created_at,updated_at) VALUES ('collision-memory','document-backed','fact','document','source-collision','agent-a',datetime('now'),datetime('now'))",
			).run();
			db.prepare(
				"INSERT INTO derived_memory_sources (derived_memory_id,source_kind,source_id,agent_id,created_at) VALUES ('collision-memory','transcript','source-collision','agent-a',datetime('now'))",
			).run();
		});
		const res = await teamApp().request(
			"http://localhost/api/sessions/source-collision/transcript?agent_id=agent-a&purge=hard",
			{ method: "DELETE", headers: bearer("admin") },
		);
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ status: "complete", counts: { retainedMixed: 1 } });
		expect(
			await getDbAccessor().withReadDbAsync((db) =>
				db
					.prepare("SELECT is_deleted,stale_at,source_type,source_id FROM memories WHERE id = 'collision-memory'")
					.get(),
			),
		).toEqual({ is_deleted: 0, stale_at: expect.any(String), source_type: "document", source_id: "source-collision" });
	});

	it("removes only its canonical records while another session appends", async () => {
		const { appendCanonicalTranscriptTurns, canonicalTranscriptPath } = await import("../transcript-jsonl");
		const { readFile } = await import("node:fs/promises");
		await transcripts.upsertSessionTranscriptAsync("delete-file", "User: private", "codex", "proj-a", "agent-a");
		const identity = {
			basePath: agentsDir,
			agentId: "agent-a",
			harness: "codex",
			project: "proj-a",
			sourceFormat: "live" as const,
		};
		await appendCanonicalTranscriptTurns({
			...identity,
			sessionKey: "delete-file",
			turns: [{ role: "user", content: "private evidence" }],
		});
		await appendCanonicalTranscriptTurns({
			...identity,
			sessionKey: "keep-file",
			turns: [{ role: "user", content: "other evidence" }],
		});
		const [res] = await Promise.all([
			teamApp().request("http://localhost/api/sessions/delete-file/transcript?agent_id=agent-a", {
				method: "DELETE",
				headers: bearer("agent"),
			}),
			appendCanonicalTranscriptTurns({
				...identity,
				sessionKey: "keep-file",
				turns: [{ role: "assistant", content: "concurrent evidence" }],
			}),
		]);
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ status: "complete", counts: { records: 1 } });
		const content = await readFile(canonicalTranscriptPath(agentsDir, "codex"), "utf8");
		expect(content).not.toContain("private evidence");
		expect(content).toContain("other evidence");
		expect(content).toContain("concurrent evidence");
	});

	it("fences live capture and reopens only new turns after an explicit end and start", async () => {
		const { appendCanonicalLiveTranscriptTurns, writeCanonicalTranscriptFromSnapshot } = await import(
			"../transcript-capture"
		);
		const { enqueueTranscriptCaptureJob, runTranscriptCaptureOnce } = await import("../transcript-capture-worker");
		const { getDbAccessor } = await import("../db-accessor");
		const { canonicalTranscriptPath } = await import("../transcript-jsonl");
		const { readFile } = await import("node:fs/promises");
		const app = teamApp();
		const headers = bearer("agent");
		const body = {
			harness: "codex",
			sessionKey: "reuse-delete",
			agentId: "agent-a",
			runtimePath: "plugin",
			project: "proj-a",
			claimOnly: true,
		};
		expect(
			(
				await app.request("http://localhost/api/hooks/session-start", {
					method: "POST",
					headers,
					body: JSON.stringify(body),
				})
			).status,
		).toBe(200);
		const before = new Date().toISOString();
		await transcripts.upsertSessionTranscriptAsync(
			body.sessionKey,
			"User: old private turn",
			body.harness,
			body.project,
			body.agentId,
			before,
		);
		const { getDbAccessor: persistedClaims } = await import("../db-accessor");
		await persistedClaims().withWriteTxAsync((db) =>
			db
				.prepare(
					"INSERT INTO session_claims (session_key,agent_id,runtime_path,harness,claimed_at,expires_at,state) VALUES (?,'agent-a','plugin','codex',?,?,'active')",
				)
				.run(body.sessionKey, before, new Date(Date.now() + 60_000).toISOString()),
		);
		presence.removeAgentPresence(body.sessionKey);
		const deleted = await app.request(`http://localhost/api/sessions/${body.sessionKey}/transcript?agent_id=agent-a`, {
			method: "DELETE",
			headers,
		});
		expect(deleted.status).toBe(200);
		expect(await deleted.json()).toMatchObject({ status: "complete", bypassed: true });
		const unbypass = await app.request(`http://localhost/api/sessions/${body.sessionKey}/bypass?agent_id=agent-a`, {
			method: "POST",
			headers,
			body: JSON.stringify({ enabled: false }),
		});
		expect(unbypass.status).toBe(409);
		expect(tracker.isSessionBypassed(body.sessionKey, "agent-a")).toBe(true);
		const identity = {
			basePath: agentsDir,
			agentId: "agent-a",
			harness: "codex",
			sessionKey: body.sessionKey,
			project: "proj-a",
		};
		expect(await appendCanonicalLiveTranscriptTurns({ ...identity, userMessage: "still private" })).toBe(false);
		expect(
			await transcripts.upsertSessionTranscriptAsync(
				body.sessionKey,
				"User: old private turn",
				"codex",
				"proj-a",
				"agent-a",
				before,
			),
		).toBe(false);
		const job = await enqueueTranscriptCaptureJob(getDbAccessor(), {
			...identity,
			sessionId: body.sessionKey,
			transcript: "User: old private turn",
			capturedAt: before,
			endedAt: before,
		});
		if (job) await runTranscriptCaptureOnce(getDbAccessor(), agentsDir);
		expect(await transcripts.getStoredSessionTranscriptInfoAsync(body.sessionKey, "agent-a")).toBeUndefined();
		const end = await app.request("http://localhost/api/hooks/session-end", {
			method: "POST",
			headers,
			body: JSON.stringify({ ...body, claimOnly: undefined }),
		});
		expect(end.status).toBe(200);
		await new Promise((resolve) => setTimeout(resolve, 2));
		expect(
			(
				await app.request("http://localhost/api/hooks/session-start", {
					method: "POST",
					headers,
					body: JSON.stringify(body),
				})
			).status,
		).toBe(200);
		expect(await appendCanonicalLiveTranscriptTurns({ ...identity, userMessage: "new public turn" })).toBe(true);
		expect(
			await writeCanonicalTranscriptFromSnapshot({
				...identity,
				rawTranscript: "User: old private turn\nUser: new public turn",
				transcript: "User: old private turn\nUser: new public turn",
				capturedAt: before,
			}),
		).toBeNull();
		const canonical = await readFile(canonicalTranscriptPath(agentsDir, "codex"), "utf8");
		expect(canonical).toContain("new public turn");
		expect(canonical).not.toContain("old private turn");
		expect(canonical).not.toContain("still private");
	});

	it("counts each resumed session generation and fences late turns after its end", async () => {
		const { updateTranscriptLifecycle } = await import("../session-transcript-lifecycle");
		const { appendCanonicalLiveTranscriptTurns } = await import("../transcript-capture");
		const identity = {
			basePath: agentsDir,
			agentId: "agent-a",
			sessionKey: "successive-reuse",
			harness: "codex",
			project: "proj-a",
		};
		await transcripts.upsertSessionTranscriptAsync(identity.sessionKey, "User: deleted", "codex", "proj-a", "agent-a");
		const deleted = await teamApp().request(
			"http://localhost/api/sessions/successive-reuse/transcript?agent_id=agent-a",
			{ method: "DELETE", headers: bearer("agent") },
		);
		expect(deleted.status).toBe(200);
		expect(await updateTranscriptLifecycle({ ...identity, action: "start" })).toEqual({
			generation: 2,
			bypassed: false,
		});
		expect(await appendCanonicalLiveTranscriptTurns({ ...identity, userMessage: "new generation" })).toBe(true);
		await updateTranscriptLifecycle({ ...identity, action: "end" });
		expect(await appendCanonicalLiveTranscriptTurns({ ...identity, userMessage: "late after end" })).toBe(false);
		expect(await updateTranscriptLifecycle({ ...identity, action: "start" })).toEqual({
			generation: 3,
			bypassed: false,
		});
		expect(await appendCanonicalLiveTranscriptTurns({ ...identity, userMessage: "third generation" })).toBe(true);
	});

	it("reopens a deleted live key after canonical TTL finalization", async () => {
		const { createTtlEvictionHandler } = await import("../session-ttl-finalizer");
		const { getDbAccessor } = await import("../db-accessor");
		const { updateTranscriptLifecycle } = await import("../session-transcript-lifecycle");
		await transcripts.upsertSessionTranscriptAsync(
			"ttl-delete",
			"User: expired evidence",
			"codex",
			"proj-a",
			"agent-a",
		);
		presence.upsertAgentPresence({
			sessionKey: "ttl-delete",
			agentId: "agent-a",
			harness: "codex",
			project: "proj-a",
			runtimePath: "plugin",
			provider: "codex",
		});
		const res = await teamApp().request("http://localhost/api/sessions/ttl-delete/transcript?agent_id=agent-a", {
			method: "DELETE",
			headers: bearer("agent"),
		});
		expect(await res.json()).toMatchObject({ status: "complete", bypassed: true });
		await createTtlEvictionHandler({ accessor: getDbAccessor(), maxCheckpointsPerSession: 3 })({
			sessionKey: "ttl-delete",
			agentId: "agent-a",
			runtimePath: "plugin",
			harness: "codex",
			claimedAt: new Date().toISOString(),
		});
		expect(await updateTranscriptLifecycle({ agentId: "agent-a", sessionKey: "ttl-delete", action: "start" })).toEqual({
			generation: 2,
			bypassed: false,
		});
	});

	it("keeps deletion admission fail closed without revealing another scope", async () => {
		const { getDbAccessor } = await import("../db-accessor");
		await transcripts.upsertSessionTranscriptAsync("scope-delete", "User: protected", "codex", "proj-a", "agent-a");
		for (const [suffix, headers, status] of [
			["?agent_id=agent-b", bearer("agent"), 404],
			["?agent_id=agent-a", bearer("agent", { scope: { agent: "agent-a", project: "proj-b" } }), 404],
			["", bearer("agent", { scope: {} }), 400],
			["", bearer("agent", { scope: { agent: " " } }), 400],
			["?agent_id=%20", bearer("agent"), 400],
			["?agent_id=agent-a&agentId=agent-b", bearer("agent"), 400],
			["?agent_id=agent-a&purge=hard", bearer("agent"), 403],
			["?agent_id=agent-a", bearer("readonly"), 403],
		] as const) {
			const res = await teamApp().request(`http://localhost/api/sessions/scope-delete/transcript${suffix}`, {
				method: "DELETE",
				headers,
			});
			expect({ suffix, status: res.status }).toEqual({ suffix, status });
		}
		expect(await transcripts.getStoredSessionTranscriptInfoAsync("scope-delete", "agent-a")).toMatchObject({
			content: "User: protected",
		});
		expect(tracker.isSessionBypassed("scope-delete", "agent-a")).toBe(false);
		expect(
			await getDbAccessor().withReadDbAsync((db) =>
				db.prepare("SELECT 1 FROM session_transcript_deletions WHERE session_key = 'scope-delete'").get(),
			),
		).toBeNull();
	});

	it("upgrades soft deletion to an admin purge against the migrated schema without deleting pinned memories", async () => {
		const { getDbAccessor } = await import("../db-accessor");
		await transcripts.upsertSessionTranscriptAsync("purge-delete", "User: purge", "codex", "proj-a", "agent-a");
		await getDbAccessor().withWriteTxAsync((db) => {
			for (const [id, pinned] of [
				["purge-single", 0],
				["purge-pinned", 1],
			] as const) {
				db.prepare(
					"INSERT INTO memories (id,content,type,agent_id,pinned,created_at,updated_at) VALUES (?,?,'fact','agent-a',?,datetime('now'),datetime('now'))",
				).run(id, id, pinned);
				db.prepare(
					"INSERT INTO derived_memory_sources (derived_memory_id,source_kind,source_id,agent_id,created_at) VALUES (?,'transcript','purge-delete','agent-a',datetime('now'))",
				).run(id);
			}
			for (const table of ["embeddings", "embeddings_staging"]) {
				db.prepare(
					`INSERT INTO ${table} (id,content_hash,vector,dimensions,source_type,source_id,chunk_text,created_at,agent_id) VALUES (?,?,?,1,'memory','purge-single','private embedding',datetime('now'),'agent-a')`,
				).run(`${table}-purge`, `${table}-purge-hash`, new Uint8Array(new Float32Array([1]).buffer));
			}
			db.exec("CREATE TABLE future_memory_projection (memory_id TEXT NOT NULL REFERENCES memories(id), content TEXT)");
			db.prepare("INSERT INTO future_memory_projection VALUES ('purge-single','private future projection')").run();
		});
		const path = "http://localhost/api/sessions/purge-delete/transcript?agent_id=agent-a";
		const soft = await teamApp().request(path, { method: "DELETE", headers: bearer("agent") });
		expect(soft.status).toBe(200);
		expect(await soft.json()).toMatchObject({ status: "complete", retainedPinned: 1, counts: { memories: 1 } });
		const hard = await teamApp().request(`${path}&purge=hard`, { method: "DELETE", headers: bearer("admin") });
		expect(hard.status).toBe(200);
		expect(await hard.json()).toMatchObject({ status: "complete", retainedPinned: 1 });
		const found = await getDbAccessor().withReadDbAsync((db) => ({
			memory: db.prepare("SELECT 1 FROM memories WHERE id = 'purge-single'").get(),
			history: db.prepare("SELECT 1 FROM memory_history WHERE memory_id = 'purge-single'").get(),
			projection: db.prepare("SELECT 1 FROM future_memory_projection").get(),
			embeddings: db
				.prepare("SELECT id FROM embeddings WHERE source_type = 'memory' AND source_id = 'purge-single'")
				.all(),
			staging: db
				.prepare("SELECT id FROM embeddings_staging WHERE source_type = 'memory' AND source_id = 'purge-single'")
				.all(),
			pinned: db.prepare("SELECT pinned,is_deleted FROM memories WHERE id = 'purge-pinned'").get(),
			fts: db.prepare("SELECT content FROM memories_fts WHERE memories_fts MATCH ?").all('"purge-single"'),
		}));
		expect(found).toMatchObject({
			memory: null,
			history: null,
			projection: null,
			embeddings: [],
			staging: [],
			pinned: { pinned: 1, is_deleted: 0 },
			fts: [],
		});
	});

	it("returns pending while a live writer holds its transcript lock and resumes afterward", async () => {
		const { withTranscriptFileLock, canonicalTranscriptPath, appendCanonicalTranscriptTurns } = await import(
			"../transcript-jsonl"
		);
		await transcripts.upsertSessionTranscriptAsync(
			"locked-delete",
			"User: locked private evidence",
			"locked-harness",
			"proj-a",
			"agent-a",
		);
		await appendCanonicalTranscriptTurns({
			basePath: agentsDir,
			agentId: "agent-a",
			sessionKey: "locked-delete",
			harness: "locked-harness",
			sourceFormat: "live",
			turns: [{ role: "user", content: "locked private evidence" }],
		});
		const entered = Promise.withResolvers<void>();
		const released = Promise.withResolvers<void>();
		const held = withTranscriptFileLock(canonicalTranscriptPath(agentsDir, "locked-harness"), async () => {
			entered.resolve();
			await released.promise;
		});
		await entered.promise;
		const timer = setTimeout(() => released.resolve(), 1_000);
		const request = () =>
			teamApp().request("http://localhost/api/sessions/locked-delete/transcript?agent_id=agent-a", {
				method: "DELETE",
				headers: bearer("agent"),
			});
		try {
			const res = await request();
			expect(res.status).toBe(200);
			expect(await res.json()).toMatchObject({
				status: "pending",
				pendingReason: expect.stringContaining("transcript lock"),
			});
		} finally {
			clearTimeout(timer);
			released.resolve();
			await held;
		}
		expect(await (await request()).json()).toMatchObject({ status: "complete", counts: { records: 1 } });
	});

	it("resumes bounded deletion and returns the same receipt after completion", async () => {
		const { getDbAccessor } = await import("../db-accessor");
		await transcripts.upsertSessionTranscriptAsync("batch-delete", "User: batch", "codex", "proj-a", "agent-a");
		await getDbAccessor().withWriteTxAsync((db) => {
			for (let i = 0; i < 130; i++) {
				const id = `batch-derived-${i}`;
				db.prepare(
					"INSERT INTO memories (id,content,type,agent_id,created_at,updated_at) VALUES (?,?,'fact','agent-a',datetime('now'),datetime('now'))",
				).run(id, id);
				db.prepare(
					"INSERT INTO derived_memory_sources (derived_memory_id,source_kind,source_id,agent_id,created_at) VALUES (?,'transcript','batch-delete','agent-a',datetime('now'))",
				).run(id);
			}
		});
		const request = () =>
			teamApp().request("http://localhost/api/sessions/batch-delete/transcript?agent_id=agent-a", {
				method: "DELETE",
				headers: bearer("agent"),
			});
		const first = await request();
		expect(await first.json()).toMatchObject({ status: "pending", counts: { memories: 64 } });
		expect(await (await request()).json()).toMatchObject({ status: "pending", counts: { memories: 128 } });
		const complete = await (await request()).json();
		expect(complete).toMatchObject({ status: "complete", counts: { memories: 130 } });
		expect(await (await request()).json()).toEqual(complete);
	});

	it("rejects completed transcript reimports in the owner after deletion and key reuse", async () => {
		const { getDbAccessor } = await import("../db-accessor");
		const { signetExportV1Adapter } = await import("../transcript-import-adapter");
		const { buildCompletedTranscriptCommit, commitCompletedTranscriptBatchInTx } = await import(
			"../transcript-import-commit"
		);
		const record = signetExportV1Adapter.parse({
			source: "signet",
			id: "reimport-deleted",
			harness: "codex",
			agent_id: "agent-a",
			session_key: "deleted-reimport",
			project: "proj-a",
			timestamp: "2026-11-01T00:00:00.000Z",
			message_count: 1,
			messages: [{ role: "user", content: "private imported evidence" }],
		});
		const commit = buildCompletedTranscriptCommit(record, {
			agentId: "agent-a",
			sourceId: "import-source",
			sourceRecordId: "first-record",
		});
		const imported = await getDbAccessor().withWriteTxAsync((db) => commitCompletedTranscriptBatchInTx(db, [commit]));
		expect(imported[0]?.outcome).toBe("imported");
		const deleted = await teamApp().request(
			`http://localhost/api/sessions/${encodeURIComponent(commit.canonicalKey)}/transcript?agent_id=agent-a`,
			{ method: "DELETE", headers: bearer("agent") },
		);
		expect(deleted.status).toBe(200);
		const retry = await getDbAccessor().withWriteTxAsync((db) =>
			commitCompletedTranscriptBatchInTx(db, [{ ...commit, sourceRecordId: "retry-record" }]),
		);
		expect(retry[0]?.outcome).toBe("session_transcript_deleted");
		const start = await teamApp().request("http://localhost/api/hooks/session-start", {
			method: "POST",
			headers: bearer("agent"),
			body: JSON.stringify({
				agentId: "agent-a",
				sessionKey: commit.canonicalKey,
				harness: "codex",
				project: "proj-a",
				runtimePath: "plugin",
				claimOnly: true,
			}),
		});
		expect(start.status).toBe(200);
		const reused = await getDbAccessor().withWriteTxAsync((db) =>
			commitCompletedTranscriptBatchInTx(db, [
				{ ...commit, sourceRecordId: "third-record", capturedAt: new Date().toISOString() },
			]),
		);
		expect(reused[0]?.outcome).toBe("session_transcript_deleted");
		expect(await transcripts.getStoredSessionTranscriptInfoAsync(commit.canonicalKey, "agent-a")).toBeUndefined();
	});

	it("rejects historical snapshot and import aliases of a deleted local key", async () => {
		const { writeCanonicalTranscriptFromSnapshot } = await import("../transcript-capture");
		const { signetExportV1Adapter } = await import("../transcript-import-adapter");
		const { buildCompletedTranscriptCommit, commitCompletedTranscriptBatchInTx } = await import(
			"../transcript-import-commit"
		);
		const { getDbAccessor } = await import("../db-accessor");
		const { appendCanonicalTranscriptTurns, canonicalTranscriptPath } = await import("../transcript-jsonl");
		const { readFile } = await import("node:fs/promises");
		await transcripts.upsertSessionTranscriptAsync("alias-delete", "User: private alias", "codex", "proj-a", "agent-a");
		await appendCanonicalTranscriptTurns({
			basePath: agentsDir,
			agentId: "agent-a",
			harness: "codex",
			sessionKey: "session:alias-delete",
			sessionId: "session:alias-delete",
			sourceFormat: "live",
			turns: [{ role: "user", content: "private canonical alias" }],
		});
		const deleted = await teamApp().request("http://localhost/api/sessions/alias-delete/transcript?agent_id=agent-a", {
			method: "DELETE",
			headers: bearer("agent"),
		});
		expect(deleted.status).toBe(200);
		expect(
			await writeCanonicalTranscriptFromSnapshot({
				basePath: agentsDir,
				agentId: "agent-a",
				harness: "codex",
				sessionKey: null,
				sessionId: "session:alias-delete",
				rawTranscript: "User: private alias",
				transcript: "User: private alias",
				capturedAt: "2026-01-01T00:00:00.000Z",
			}),
		).toBeNull();
		const record = signetExportV1Adapter.parse({
			source: "signet",
			id: "alias-export",
			harness: "codex",
			agent_id: "agent-a",
			session_key: "session:alias-delete",
			project: "proj-a",
			timestamp: "2026-01-01T00:00:00.000Z",
			message_count: 1,
			messages: [{ role: "user", content: "private alias" }],
		});
		const commit = buildCompletedTranscriptCommit(record, {
			agentId: "agent-a",
			sourceId: "alias-source",
			sourceRecordId: "alias-record",
		});
		const imported = await getDbAccessor().withWriteTxAsync((db) => commitCompletedTranscriptBatchInTx(db, [commit]));
		expect(imported[0]?.outcome).toBe("session_transcript_deleted");
		expect(await transcripts.getStoredSessionTranscriptInfoAsync(commit.canonicalKey, "agent-a")).toBeUndefined();
		expect(await readFile(canonicalTranscriptPath(agentsDir, "codex"), "utf8")).not.toContain(
			"private canonical alias",
		);
	});

	it("redacts only the deleted conversation range in a shared uploaded file", async () => {
		const { getDbAccessor } = await import("../db-accessor");
		const { createHash } = await import("node:crypto");
		const removed = `${JSON.stringify({ session_key: "raw-delete", messages: ["private raw evidence"] })}\n`;
		const kept = `${JSON.stringify({ session_key: "raw-keep", messages: ["retained raw evidence"] })}\n`;
		const bytes = Buffer.from(removed + kept);
		await transcripts.upsertSessionTranscriptAsync(
			"raw-delete",
			"User: private raw evidence",
			"codex",
			"proj-a",
			"agent-a",
		);
		await getDbAccessor().withWriteTxAsync((db) => {
			db.prepare(
				"INSERT INTO source_import_jobs (id,kind,agent_id,schema_id,adapter_version,state,total,imported) VALUES ('raw-job','import','agent-a','signet-export-v1',1,'completed',2,2)",
			).run();
			db.prepare(
				"INSERT INTO source_import_files (id,job_id,source_id,agent_id,ordinal,name,managed_path,state,storage_state) VALUES ('raw-file','raw-job','raw-source','agent-a',0,'raw.jsonl','raw.jsonl','completed','sealed')",
			).run();
			for (const [id, ordinal, offset, length, key] of [
				["raw-first", 0, 0, Buffer.byteLength(removed), "raw-delete"],
				["raw-second", 1, Buffer.byteLength(removed), Buffer.byteLength(kept), "raw-keep"],
			] as const) {
				db.prepare(
					"INSERT INTO source_import_records (id,job_id,file_id,source_id,agent_id,ordinal,line_number,byte_offset,byte_length,raw_hash,status,canonical_key) VALUES (?,'raw-job','raw-file','raw-source','agent-a',?,?,?,?,?,'imported',?)",
				).run(id, ordinal, ordinal + 1, offset, length, "fixture-hash", key);
			}
			db.prepare(
				"INSERT INTO source_import_chunks (file_id,agent_id,generation,byte_offset,checksum,content) VALUES ('raw-file','agent-a',0,0,?,?)",
			).run(createHash("sha256").update(bytes).digest("hex"), bytes);
		});
		const request = () =>
			teamApp().request("http://localhost/api/sessions/raw-delete/transcript?agent_id=agent-a", {
				method: "DELETE",
				headers: bearer("agent"),
			});
		expect(await (await request()).json()).toMatchObject({
			status: "pending",
			counts: { uploadedBytes: Buffer.byteLength(removed) },
		});
		expect(await (await request()).json()).toMatchObject({ status: "complete" });
		const chunk = await getDbAccessor().withReadDbAsync((db) =>
			db.prepare("SELECT content,checksum FROM source_import_chunks WHERE file_id = 'raw-file'").get(),
		);
		if (!(chunk?.content instanceof Uint8Array)) throw new Error("Missing uploaded bytes");
		const content = Buffer.from(chunk.content);
		expect(content.toString()).not.toContain("private raw evidence");
		expect(content.toString()).toContain(kept);
		expect(content.length).toBe(bytes.length);
		expect(chunk.checksum).toBe(createHash("sha256").update(content).digest("hex"));
	});

	it("resumes canonical byte cleanup after restart and preserves an append between batches", async () => {
		const { canonicalTranscriptPath, appendCanonicalTranscriptTurns } = await import("../transcript-jsonl");
		const { writeFile, readFile, mkdir } = await import("node:fs/promises");
		const { dirname } = await import("node:path");
		const harness = "delete-batch";
		const path = canonicalTranscriptPath(agentsDir, harness);
		await mkdir(dirname(path), { recursive: true });
		const rows = Array.from({ length: 300 }, (_, index) => ({
			schema: "signet.transcript.v1",
			id: `fixture-${index}`,
			captured_at: "2026-11-17T00:00:00.000Z",
			agent_id: "agent-a",
			harness,
			session_id: index % 100 === 0 ? "bytes-delete" : "bytes-keep",
			session_key: index % 100 === 0 ? "bytes-delete" : "bytes-keep",
			project: "proj-a",
			role: "user",
			source_format: "live",
			source_sha256: "fixture",
			content: "x".repeat(65_000),
			seq: index + 1,
		}));
		await writeFile(
			path,
			rows
				.map((row) => JSON.stringify(row))
				.join("\n")
				.concat("\n"),
		);
		await transcripts.upsertSessionTranscriptAsync("bytes-delete", "User: large", harness, "proj-a", "agent-a");
		const request = () =>
			teamApp().request("http://localhost/api/sessions/bytes-delete/transcript?agent_id=agent-a", {
				method: "DELETE",
				headers: bearer("agent"),
			});
		expect(await (await request()).json()).toMatchObject({ status: "pending" });
		await closeDbAccessor();
		initDbAccessor(join(agentsDir, "memory", "memories.db"));
		await appendCanonicalTranscriptTurns({
			basePath: agentsDir,
			agentId: "agent-a",
			harness,
			sessionKey: "bytes-keep",
			sourceFormat: "live",
			turns: [{ role: "assistant", content: "appended between cleanup batches" }],
		});
		let result: unknown;
		for (let i = 0; i < 10; i++) {
			result = await (await request()).json();
			if (typeof result === "object" && result !== null && "status" in result && result.status === "complete") break;
		}
		expect(result).toMatchObject({
			status: "complete",
			counts: { records: rows.filter((row) => row.session_key === "bytes-delete").length },
		});
		const content = await readFile(path, "utf8");
		expect(content).not.toContain('"session_key":"bytes-delete"');
		expect(content).toContain("appended between cleanup batches");
		expect(content.trim().split("\n").length).toBe(rows.filter((row) => row.session_key === "bytes-keep").length + 1);
	});

	it("denies bypass and renew to read-only credentials", async () => {
		const bypass = await teamApp().request("http://localhost/api/sessions/sess-a/bypass?agent_id=agent-a", {
			method: "POST",
			headers: bearer("readonly"),
			body: JSON.stringify({ enabled: true }),
		});
		expect(bypass.status).toBe(403);
		expect(tracker.isSessionBypassed("sess-a", "agent-a")).toBe(false);

		const renew = await teamApp().request("http://localhost/api/sessions/sess-a/renew?agent_id=agent-a", {
			method: "POST",
			headers: bearer("readonly"),
		});
		expect(renew.status).toBe(403);
	});

	it("lets a write-capable credential manage its scoped session", async () => {
		const bypass = await teamApp().request("http://localhost/api/sessions/sess-a/bypass?agent_id=agent-a", {
			method: "POST",
			headers: bearer("agent"),
			body: JSON.stringify({ enabled: true }),
		});
		expect(bypass.status).toBe(200);
		expect(tracker.isSessionBypassed("sess-a", "agent-a")).toBe(true);

		const renew = await teamApp().request("http://localhost/api/sessions/sess-a/renew?agent_id=agent-a", {
			method: "POST",
			headers: bearer("agent"),
		});
		expect(renew.status).toBe(200);
	});

	it("lets a default connector key manage its scoped session", async () => {
		const connector = bearer("agent", { permissions: ["recall", "remember", "documents"] });
		const bypass = await teamApp().request("http://localhost/api/sessions/sess-a/bypass?agent_id=agent-a", {
			method: "POST",
			headers: connector,
			body: JSON.stringify({ enabled: true }),
		});
		expect(bypass.status).toBe(200);
		expect(tracker.isSessionBypassed("sess-a", "agent-a")).toBe(true);

		const renew = await teamApp().request("http://localhost/api/sessions/sess-a/renew?agent_id=agent-a", {
			method: "POST",
			headers: connector,
		});
		expect(renew.status).toBe(200);
	});

	it("denies session controls outside the credential's project", async () => {
		const otherProject = bearer("agent", { scope: { agent: "agent-a", project: "proj-b" } });
		const bypass = await teamApp().request("http://localhost/api/sessions/sess-a/bypass?agent_id=agent-a", {
			method: "POST",
			headers: otherProject,
			body: JSON.stringify({ enabled: true }),
		});
		expect(bypass.status).toBe(403);
		expect(tracker.isSessionBypassed("sess-a", "agent-a")).toBe(false);

		const renew = await teamApp().request("http://localhost/api/sessions/sess-a/renew?agent_id=agent-a", {
			method: "POST",
			headers: otherProject,
		});
		expect(renew.status).toBe(403);

		const sameProject = bearer("agent", { scope: { agent: "agent-a", project: "proj-a" } });
		const allowed = await teamApp().request("http://localhost/api/sessions/sess-a/renew?agent_id=agent-a", {
			method: "POST",
			headers: sameProject,
		});
		expect(allowed.status).toBe(200);
	});

	it("denies session lifecycle hooks to read-only credentials", async () => {
		expect(tracker.claimSession("sess-a", "plugin", "agent-a", "codex").ok).toBe(true);
		const readonly = bearer("readonly");
		const hooks = [
			["/api/hooks/session-end", { harness: "codex", sessionKey: "sess-a", agentId: "agent-a", runtimePath: "legacy" }],
			[
				"/api/hooks/session-start",
				{ harness: "codex", sessionKey: "sess-a", agentId: "agent-a", runtimePath: "legacy", claimOnly: true },
			],
			[
				"/api/hooks/user-prompt-submit",
				{ harness: "codex", sessionKey: "sess-a", agentId: "agent-a", runtimePath: "legacy", userPrompt: "hi" },
			],
			["/api/hooks/session-checkpoint-extract", { harness: "codex", sessionKey: "sess-a", runtimePath: "legacy" }],
			["/api/hooks/pre-compaction", { harness: "codex", sessionKey: "sess-a", runtimePath: "legacy" }],
			[
				"/api/hooks/compaction-complete",
				{ harness: "codex", sessionKey: "sess-a", runtimePath: "legacy", summary: "s" },
			],
		] as const;
		for (const [path, body] of hooks) {
			const res = await teamApp().request(`http://localhost${path}`, {
				method: "POST",
				headers: readonly,
				body: JSON.stringify(body),
			});
			expect({ path, status: res.status }).toEqual({ path, status: 403 });
		}
		expect(tracker.claimSession("sess-a", "plugin", "agent-a", "codex").ok).toBe(true);
	});

	it("does not let a hook claim another agent's session", async () => {
		expect(tracker.claimSession("sess-b", "plugin", "agent-b", "codex").ok).toBe(true);
		for (const [path, body] of [
			["/api/hooks/session-checkpoint-extract", { harness: "codex", sessionKey: "sess-b", agentId: "agent-b" }],
			["/api/hooks/pre-compaction", { harness: "codex", sessionKey: "sess-b", agentId: "agent-b" }],
			["/api/hooks/compaction-complete", { harness: "codex", sessionKey: "sess-b", agentId: "agent-b", summary: "s" }],
		] as const) {
			const res = await teamApp().request(`http://localhost${path}`, {
				method: "POST",
				headers: { ...bearer("agent"), "x-signet-runtime-path": "legacy" },
				body: JSON.stringify({ ...body, runtimePath: "legacy" }),
			});
			expect({ path, status: res.status }).toEqual({ path, status: 403 });
		}
		expect(tracker.claimSession("sess-b", "plugin", "agent-b", "codex").ok).toBe(true);
	});

	it("does not let a credential take over another agent's session", async () => {
		presence.upsertAgentPresence({
			sessionKey: "sess-b",
			agentId: "agent-b",
			harness: "codex",
			project: "proj-a",
			runtimePath: "plugin",
			provider: "codex",
		});
		expect(tracker.claimSession("sess-b", "plugin", "agent-b", "codex").ok).toBe(true);
		const agentA = bearer("agent");
		for (const [path, body] of [
			["/api/hooks/session-start", { claimOnly: true }],
			["/api/hooks/user-prompt-submit", { userPrompt: "hi" }],
			["/api/hooks/session-checkpoint-extract", {}],
			["/api/hooks/pre-compaction", {}],
			["/api/hooks/compaction-complete", { summary: "s" }],
			["/api/cross-agent/presence", { project: "proj-a" }],
		] as const) {
			const res = await teamApp().request(`http://localhost${path}`, {
				method: "POST",
				headers: agentA,
				body: JSON.stringify({
					harness: "codex",
					sessionKey: "sess-b",
					agentId: "agent-a",
					runtimePath: "legacy",
					...body,
				}),
			});
			expect({ path, status: res.status }).toEqual({ path, status: 403 });
		}
		expect(presence.getAgentPresenceForSession("sess-b")?.agentId).toBe("agent-b");
		expect(tracker.claimSession("sess-a", "legacy", "agent-a", "codex").ok).toBe(true);
	});

	it("does not let a credential move a session into its project", async () => {
		const otherProject = bearer("agent", { scope: { agent: "agent-a", project: "proj-b" } });
		const attempts = [
			["/api/hooks/session-start", { claimOnly: true, project: "proj-b" }],
			["/api/hooks/compaction-complete", { summary: "s", project: "proj-b" }],
			["/api/cross-agent/presence", { project: "proj-b" }],
		] as const;
		for (const [path, body] of attempts) {
			const res = await teamApp().request(`http://localhost${path}`, {
				method: "POST",
				headers: otherProject,
				body: JSON.stringify({
					harness: "codex",
					sessionKey: "sess-a",
					agentId: "agent-a",
					runtimePath: "legacy",
					...body,
				}),
			});
			expect({ path, status: res.status }).toEqual({ path, status: 403 });
		}
		expect(presence.getAgentPresenceForSession("sess-a")?.project).toBe("proj-a");
		const bypass = await teamApp().request("http://localhost/api/sessions/sess-a/bypass?agent_id=agent-a", {
			method: "POST",
			headers: otherProject,
			body: JSON.stringify({ enabled: true }),
		});
		expect(bypass.status).toBe(403);
		expect(tracker.claimSession("sess-a", "plugin", "agent-a", "codex").ok).toBe(true);
	});

	it("requires a recorded project before a project-limited credential controls a claim-only session", async () => {
		const projectB = bearer("agent", { scope: { agent: "agent-a", project: "proj-b" } });
		const projectA = bearer("agent", { scope: { agent: "agent-a", project: "proj-a" } });
		expect(tracker.claimSession("orphan", "plugin", "agent-a", "codex").ok).toBe(true);
		expect(tracker.claimSession("recorded", "plugin", "agent-a", "codex").ok).toBe(true);
		await transcripts.upsertSessionTranscriptAsync("recorded", "user: hi", "codex", "proj-a", "agent-a");
		try {
			const request = (path: string, headers: Record<string, string>, body: unknown) =>
				teamApp().request(`http://localhost${path}`, { method: "POST", headers, body: JSON.stringify(body) });

			for (const key of ["orphan", "recorded"]) {
				expect(
					(await request(`/api/sessions/${key}/bypass?agent_id=agent-a`, projectB, { enabled: true })).status,
				).toBe(403);
				expect((await request(`/api/sessions/${key}/renew?agent_id=agent-a`, projectB, {})).status).toBe(403);
				const start = await request("/api/hooks/session-start", projectB, {
					harness: "codex",
					sessionKey: key,
					agentId: "agent-a",
					runtimePath: "plugin",
					claimOnly: true,
					project: "proj-b",
				});
				expect(start.status).toBe(403);
				expect(presence.getAgentPresenceForSession(key)).toBeNull();
			}

			expect((await request("/api/sessions/recorded/renew?agent_id=agent-a", projectA, {})).status).toBe(200);
		} finally {
			tracker.releaseSession("orphan", "agent-a");
			tracker.releaseSession("recorded", "agent-a");
		}
	});

	it("keeps an expired session in its recorded project", async () => {
		await transcripts.upsertSessionTranscriptAsync("expired", "user: hi", "codex", "proj-a", "agent-a");
		const res = await teamApp().request("http://localhost/api/hooks/session-start", {
			method: "POST",
			headers: bearer("agent", { scope: { agent: "agent-a", project: "proj-b" } }),
			body: JSON.stringify({
				harness: "codex",
				sessionKey: "expired",
				agentId: "agent-a",
				runtimePath: "plugin",
				claimOnly: true,
				project: "proj-b",
			}),
		});
		expect(res.status).toBe(403);
		expect(presence.getAgentPresenceForSession("expired")).toBeNull();
		expect(tracker.hasSession("expired", "agent-a")).toBe(false);
	});

	it("lets each agent use its own claim on a shared session key", async () => {
		expect(tracker.claimSession("shared", "plugin", "agent-a", "codex").ok).toBe(true);
		expect(tracker.claimSession("shared", "plugin", "agent-b", "codex").ok).toBe(true);
		try {
			const res = await teamApp().request("http://localhost/api/sessions/shared/renew?agent_id=agent-a", {
				method: "POST",
				headers: bearer("agent"),
				body: "{}",
			});
			expect(res.status).toBe(200);
		} finally {
			tracker.releaseSession("shared", "agent-a");
			tracker.releaseSession("shared", "agent-b");
		}
	});

	it("still reads the session list with a read-only credential", async () => {
		const list = await teamApp().request("http://localhost/api/sessions?agent_id=agent-a", {
			headers: bearer("readonly"),
		});
		expect(list.status).toBe(200);
	});
});
