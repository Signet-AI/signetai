import { afterAll, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
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
let getDbAccessor: typeof import("../db-accessor").getDbAccessor;
let closeDbAccessor: typeof import("../db-accessor").closeDbAccessor;
let presence: typeof import("../cross-agent");
let tracker: typeof import("../session-tracker");
let transcripts: typeof import("../session-transcripts");
let state: typeof import("./state.js");

function writeAuthConfig(mode: "local" | "team" | "hybrid"): void {
	writeFileSync(
		join(agentsDir, "agent.yaml"),
		`embedding:\n  provider: none\nmemory:\n  pipelineV2:\n    reranker:\n      enabled: false\nauth:\n  mode: ${mode}\n  rateLimits:\n    forget:\n      windowMs: 60000\n      max: 30\n    modify:\n      windowMs: 60000\n      max: 60\n    batchForget:\n      windowMs: 60000\n      max: 5\n    admin:\n      windowMs: 60000\n      max: 10\n    recallLlm:\n      windowMs: 60000\n      max: 60\n`,
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

function sessionFixture(sessionKey: string): {
	readonly agentId: string;
	readonly harness: string;
	readonly project: string;
	readonly sessionKey: string;
} {
	return { agentId: "agent-a", harness: "codex", project: "proj-a", sessionKey };
}

function seed(key: string, content: string, capturedAt?: string): Promise<boolean> {
	return transcripts.upsertSessionTranscriptAsync(key, content, "codex", "proj-a", "agent-a", capturedAt);
}

function removeTranscript(key: string): Promise<Response> {
	return Promise.resolve(
		teamApp().request(`http://localhost/api/sessions/${encodeURIComponent(key)}/transcript?agent_id=agent-a`, {
			method: "DELETE",
			headers: bearer("agent"),
		}),
	);
}

function hook(app: Hono, name: string, body: unknown, headers: Record<string, string>): Promise<Response> {
	return Promise.resolve(
		app.request(`http://localhost/api/hooks/${name}`, { method: "POST", headers, body: JSON.stringify(body) }),
	);
}

function readOne(sql: string, ...params: readonly unknown[]): Promise<Record<string, unknown> | null> {
	return getDbAccessor().withReadDbAsync((db) => db.prepare(sql).get(...params) ?? null);
}

function readAll(sql: string, ...params: readonly unknown[]): Promise<readonly Record<string, unknown>[]> {
	return getDbAccessor().withReadDbAsync((db) => db.prepare(sql).all(...params));
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
	({ initDbAccessor, closeDbAccessor, getDbAccessor } = await import("../db-accessor"));
	presence = await import("../cross-agent");
	tracker = await import("../session-tracker");
	transcripts = await import("../session-transcripts");
	state = await import("./state.js");
	initDbAccessor(join(agentsDir, "memory", "memories.db"));
	writeAuthConfig("team");
	state.reloadAuthState(agentsDir);
});

beforeEach(() => {
	state.authForgetLimiter.reset();
	state.authAdminLimiter.reset();
	presence.clearAllPresence();
	tracker.unbypassSession("sess-a", "agent-a");
	tracker.releaseSession("sess-a", "agent-a");
	tracker.releaseSession("sess-b", "agent-b");
	presence.upsertAgentPresence({ ...sessionFixture("sess-a"), runtimePath: "plugin", provider: "codex" });
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
	it("forgets only attributable memories and retains mixed and pinned evidence", async () => {
		await seed("delete-lineage", "User: lineage");
		await getDbAccessor().withWriteTxAsync((db) => {
			for (const [id, pinned] of [
				["delete-single", 0],
				["delete-mixed", 0],
				["delete-pinned", 1],
				["delete-pinned-descendant", 1],
				["delete-descendant", 0],
			] as const) {
				db.prepare(
					"INSERT INTO memories (id, content, type, agent_id, pinned, created_at, updated_at) VALUES (?, ?, 'fact', 'agent-a', ?, datetime('now'), datetime('now'))",
				).run(id, id, pinned);
				db.prepare(
					"INSERT INTO derived_memory_sources (derived_memory_id, source_kind, source_id, agent_id, created_at) VALUES (?, ?, ?, 'agent-a', datetime('now'))",
				).run(
					id,
					id.endsWith("descendant") ? "memory" : "transcript",
					id.endsWith("descendant") ? "delete-single" : "delete-lineage",
				);
			}
			db.prepare(
				"UPDATE memories SET source_type = 'transcript', source_id = 'delete-lineage' WHERE id = 'delete-mixed'",
			).run();
			db.prepare(
				"INSERT INTO derived_memory_sources (derived_memory_id, source_kind, source_id, agent_id, created_at) VALUES ('delete-mixed', 'transcript', 'unrelated-session', 'agent-a', datetime('now'))",
			).run();
		});
		const res = await removeTranscript("delete-lineage");
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({
			status: "complete",
			retainedPinned: 2,
			counts: { memories: 2, retainedMixed: 1 },
		});
		const rows = await readAll("SELECT id,is_deleted,stale_at FROM memories WHERE id LIKE 'delete-%' ORDER BY id");
		expect(rows).toEqual([
			{ id: "delete-descendant", is_deleted: 1, stale_at: expect.anything() },
			{ id: "delete-mixed", is_deleted: 0, stale_at: expect.any(String) },
			{ id: "delete-pinned", is_deleted: 0, stale_at: null },
			{ id: "delete-pinned-descendant", is_deleted: 0, stale_at: null },
			{ id: "delete-single", is_deleted: 1, stale_at: null },
		]);
		const edges = await readAll(
			"SELECT source_id FROM derived_memory_sources WHERE derived_memory_id = 'delete-mixed'",
		);
		expect(edges).toEqual([{ source_id: "unrelated-session" }]);
		expect(await readOne("SELECT source_type,source_id FROM memories WHERE id = 'delete-mixed'")).toEqual({
			source_type: null,
			source_id: null,
		});
		const review = await getDbAccessor().withReadDbAsync((db) =>
			db
				.prepare(
					"SELECT kind FROM dreaming_attention WHERE agent_id = 'agent-a' AND subject_ref = 'memory:delete-mixed' AND resolved_at IS NULL",
				)
				.get(),
		);
		expect(review).toEqual({ kind: "evidence_requeue" });
		const { hybridRecall } = await import("../memory-search");
		const { loadMemoryConfig } = await import("../memory-config");
		const cfg = loadMemoryConfig(agentsDir);
		const recalled = await hybridRecall(
			{ query: "delete-pinned", agentId: "agent-a", pinned: true, limit: 10 },
			{ ...cfg, search: { ...cfg.search, min_score: 0 } },
			async () => null,
		);
		expect(recalled.results.map((row) => row.id).sort()).toEqual(["delete-pinned", "delete-pinned-descendant"]);
		expect(
			await getDbAccessor().withReadDbAsync((db) =>
				db
					.prepare(
						"SELECT subject_ref FROM dreaming_attention WHERE subject_ref IN ('memory:delete-pinned','memory:delete-pinned-descendant')",
					)
					.all(),
			),
		).toEqual([]);
	});

	it("retains a memory whose explicit non-session source shares the deleted key", async () => {
		await seed("source-collision", "User: session");
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

	it("indexes new-generation end snapshots and artifacts without replaying deleted evidence", async () => {
		const { updateTranscriptLifecycle } = await import("../session-transcript-lifecycle");
		const { writeCanonicalTranscriptFromSnapshot } = await import("../transcript-capture");
		const { enqueueTranscriptCaptureJob, runTranscriptCaptureOnce } = await import("../transcript-capture-worker");
		const { writeSummaryArtifact, writeCompactionArtifact } = await import("../memory-lineage");
		const { hybridRecall } = await import("../memory-search");
		const { loadMemoryConfig } = await import("../memory-config");
		const identity = { ...sessionFixture("snapshot-reuse"), basePath: agentsDir, sessionId: "snapshot-reuse" };
		const before = new Date().toISOString();
		await seed(identity.sessionKey, "User: deleted quokka", before);
		const deleted = await removeTranscript("snapshot-reuse");
		expect(await deleted.json()).toMatchObject({ status: "complete", generation: 1 });
		await Bun.sleep(2);
		expect(await updateTranscriptLifecycle({ ...identity, action: "start" })).toMatchObject({ generation: 2 });
		const capturedAt = new Date().toISOString();
		const job = await enqueueTranscriptCaptureJob(getDbAccessor(), {
			...identity,
			transcript: "User: quokka telescope new evidence",
			capturedAt,
			endedAt: capturedAt,
		});
		expect(job).not.toBeNull();
		await updateTranscriptLifecycle({ ...identity, action: "end" });
		expect(await runTranscriptCaptureOnce(getDbAccessor(), agentsDir)).toBe(true);
		const summary = await writeSummaryArtifact({
			...identity,
			capturedAt,
			startedAt: capturedAt,
			endedAt: capturedAt,
			summary: "quokka telescope summary",
		});
		await writeCompactionArtifact({
			...identity,
			capturedAt,
			startedAt: capturedAt,
			endedAt: capturedAt,
			summary: "quokka telescope compaction",
		});
		const kinds = await getDbAccessor().withReadDbAsync((db) =>
			db
				.prepare(
					"SELECT source_kind FROM memory_artifacts WHERE agent_id = 'agent-a' AND session_key = 'snapshot-reuse' ORDER BY source_kind",
				)
				.all(),
		);
		expect(kinds).toEqual(["compaction", "manifest", "summary", "transcript"].map((source_kind) => ({ source_kind })));
		expect(await transcripts.getStoredSessionTranscriptInfoAsync(identity.sessionKey, identity.agentId)).toMatchObject({
			content: "User: quokka telescope new evidence",
		});
		const cfg = loadMemoryConfig(agentsDir);
		const recalled = await hybridRecall(
			{ query: "quokka telescope", agentId: identity.agentId, limit: 20 },
			{ ...cfg, search: { ...cfg.search, min_score: 0 } },
			async () => null,
		);
		expect(recalled.results.some((row) => row.content.includes("quokka telescope"))).toBe(true);
		expect(
			await writeCanonicalTranscriptFromSnapshot({
				...identity,
				rawTranscript: "User: undated replay",
				transcript: "User: undated replay",
			}),
		).toBeNull();
		expect(
			await writeCanonicalTranscriptFromSnapshot({
				...identity,
				rawTranscript: "User: deleted quokka",
				transcript: "User: deleted quokka",
				capturedAt: before,
			}),
		).toBeNull();
		expect(await seed(identity.sessionKey, "User: deleted quokka", before)).toBe(false);
		const { readFileSync } = await import("node:fs");
		const { reindexMemoryArtifacts } = await import("../memory-lineage");
		const path = join(agentsDir, summary.summaryPath);
		writeFileSync(path, readFileSync(path, "utf8").replace(/^captured_at:[^\n]*\n/m, ""));
		await getDbAccessor().withWriteTxAsync((db) =>
			db
				.prepare("DELETE FROM memory_artifacts WHERE source_path = ? AND agent_id = 'agent-a'")
				.run(summary.summaryPath),
		);
		await reindexMemoryArtifacts("agent-a");
		expect(
			await getDbAccessor().withReadDbAsync((db) =>
				db
					.prepare("SELECT source_path FROM memory_artifacts WHERE source_path = ? AND agent_id = 'agent-a'")
					.get(summary.summaryPath),
			),
		).toBeNull();
	});

	it("deletes prefixed compaction evidence only in the owning agent", async () => {
		const { writeCompactionArtifact } = await import("../memory-lineage");
		const key = "prefixed-compaction";
		await seed(key, "User: compaction evidence");
		for (const agentId of ["agent-a", "agent-b"])
			await writeCompactionArtifact({
				agentId,
				sessionId: `session:${key}`,
				sessionKey: `session:${key}`,
				project: "proj-a",
				harness: "codex",
				capturedAt: new Date().toISOString(),
				startedAt: null,
				endedAt: null,
				summary: "prefixed summary evidence",
			});
		const url = `http://localhost/api/sessions/${key}/transcript?agent_id=agent-a`;
		await teamApp().request(url, { method: "DELETE", headers: bearer("agent") });
		const res = await teamApp().request(url, { method: "DELETE", headers: bearer("agent") });
		expect(await res.json()).toMatchObject({ status: "complete", counts: { artifacts: 2 } });
		expect(
			await getDbAccessor().withReadDbAsync((db) =>
				db
					.prepare("SELECT agent_id,source_kind FROM memory_artifacts WHERE session_key IN (?,?) ORDER BY source_kind")
					.all(key, `session:${key}`),
			),
		).toEqual([
			{ agent_id: "agent-b", source_kind: "compaction" },
			{ agent_id: "agent-b", source_kind: "manifest" },
		]);
	});

	it("does not restore a deleted transcript from a delayed Dreaming finalization", async () => {
		const { finalizeDreamingPassInDb } = await import("../pipeline/dreaming");
		const key = "late-dreaming";
		const capturedAt = new Date().toISOString();
		await seed(key, "User: delayed source", capturedAt);
		await removeTranscript(key);
		await getDbAccessor().withWriteTxAsync((db) => {
			db.prepare(
				"INSERT INTO dreaming_passes (id,agent_id,mode,status) VALUES ('late-pass','agent-a','full','running')",
			).run();
			finalizeDreamingPassInDb(db, {
				passId: "late-pass",
				agentId: "agent-a",
				mode: "full",
				scopes: ["agent-a"],
				transcriptManifestEntries: [
					{
						scope: "agent-a",
						content: "User: delayed source",
						source: { id: key, completed: true, project: "proj-a", harness: "codex", capturedAt },
					},
				],
				tokensConsumed: 0,
				inputTokens: null,
				outputTokens: null,
				cacheReadTokens: null,
				cacheCreationTokens: null,
				peakContextTokens: null,
				totalCost: null,
				applied: 0,
				failed: 0,
				summary: "fixture",
				rejectedEvidence: [],
				memoryHeadCommitInput: null,
				hasBacklogByScope: [],
				nextWatermarkByScope: [],
			});
		});
		expect(
			await readAll("SELECT id FROM session_summaries WHERE session_key = ? AND agent_id = 'agent-a'", key),
		).toEqual([]);
	});

	it.each([false, true])("keeps start and end hooks advisory on owner timeout (deleted: %s)", async (deleted) => {
		const runtime = await import("../db-owner-runtime");
		const { DbOwnerDeadlineError } = await import("../db-owner-client");
		const { appendCanonicalLiveTranscriptTurns } = await import("../transcript-capture");
		const key = `advisory-hook-${deleted}`;
		await seed(key, "User: deleted evidence");
		if (deleted) await removeTranscript(key);
		const original = runtime.dbOwnerTranscriptOperation;
		const unavailable = spyOn(runtime, "dbOwnerTranscriptOperation").mockImplementation(
			async <Result>(...args: Parameters<typeof original>): Promise<Result> => {
				if (args[1].kind === "session_transcript_lifecycle") throw new DbOwnerDeadlineError("advisory-test");
				return await original<Result>(...args);
			},
		);
		try {
			const headers = bearer("agent");
			const app = teamApp();
			const body = { ...sessionFixture(key), runtimePath: "plugin", claimOnly: true };
			const start = await hook(app, "session-start", body, headers);
			expect(start.status).toBe(200);
			expect(
				await appendCanonicalLiveTranscriptTurns({ basePath: agentsDir, ...body, userMessage: "must stay private" }),
			).toBe(!deleted);
			const end = await hook(
				app,
				"session-end",
				{
					...body,
					claimOnly: undefined,
					reason: "session_shutdown",
					transcript: "User: must stay private",
				},
				headers,
			);
			expect(end.status).toBe(200);
			expect(Boolean(await transcripts.getStoredSessionTranscriptInfoAsync(key, "agent-a"))).toBe(!deleted);
		} finally {
			unavailable.mockRestore();
		}
	});

	it("rejects stale generation DELETE retries without touching the reused key", async () => {
		const { updateTranscriptLifecycle } = await import("../session-transcript-lifecycle");
		const path = "http://localhost/api/sessions/generation-retry/transcript?agent_id=agent-a";
		const app = teamApp();
		const headers = bearer("agent");
		await seed("generation-retry", "User: old generation");
		const first = await app.request(`${path}&generation=1`, { method: "DELETE", headers });
		expect(await first.json()).toMatchObject({ status: "complete", generation: 1 });
		await new Promise((resolve) => setTimeout(resolve, 2));
		await updateTranscriptLifecycle({ agentId: "agent-a", sessionKey: "generation-retry", action: "start" });
		await transcripts.appendSessionTranscriptAsync({
			...sessionFixture("generation-retry"),
			transcript: "User: current generation",
		});
		const before = await readOne("SELECT * FROM session_transcript_deletions WHERE session_key = 'generation-retry'");
		const stale = await app.request(`${path}&generation=1`, { method: "DELETE", headers });
		expect(stale.status).toBe(409);
		expect(await stale.json()).toMatchObject({ generation: 2 });
		expect(await transcripts.getStoredSessionTranscriptInfoAsync("generation-retry", "agent-a")).toMatchObject({
			content: "User: current generation",
		});
		expect(await readOne("SELECT * FROM session_transcript_deletions WHERE session_key = 'generation-retry'")).toEqual(
			before,
		);
		for (const generation of ["", "0", "-1", "1.5", "2junk", "9007199254740992"]) {
			expect((await app.request(`${path}&generation=${generation}`, { method: "DELETE", headers })).status).toBe(400);
		}
		const current = await app.request(path, { method: "DELETE", headers });
		expect(await current.json()).toMatchObject({ status: "complete", generation: 2 });
		expect(await transcripts.getStoredSessionTranscriptInfoAsync("generation-retry", "agent-a")).toBeUndefined();
	});

	it("reopens a deleted live key after canonical TTL finalization", async () => {
		const { createTtlEvictionHandler } = await import("../session-ttl-finalizer");
		const { updateTranscriptLifecycle } = await import("../session-transcript-lifecycle");
		await seed("ttl-delete", "User: expired evidence");
		presence.upsertAgentPresence({ ...sessionFixture("ttl-delete"), runtimePath: "plugin", provider: "codex" });
		const res = await removeTranscript("ttl-delete");
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
			lifecycleIntentSeq: expect.any(Number),
		});
	});

	it("keeps a live session unbypassed when its project does not match", async () => {
		const key = "rejected-live";
		await seed(key, "User: project evidence");
		presence.upsertAgentPresence({ ...sessionFixture(key), runtimePath: "plugin", provider: "codex" });
		const res = await teamApp().request(
			`http://localhost/api/sessions/${key}/transcript?agent_id=agent-a&project=proj-b`,
			{ method: "DELETE", headers: bearer("agent") },
		);
		expect(res.status).toBe(404);
		expect(tracker.isSessionBypassed(key, "agent-a")).toBe(false);
		expect(await readOne("SELECT 1 FROM session_transcript_deletions WHERE session_key = ?", key)).toBeNull();
		expect(await transcripts.getStoredSessionTranscriptInfoAsync(key, "agent-a")).toMatchObject({
			content: "User: project evidence",
		});
	});

	it("tracks already-forgotten summary-only memories before removing their summary", async () => {
		const key = "summary-only-delete";
		await seed(key, "User: summary evidence");
		await getDbAccessor().withWriteTxAsync((db) => {
			db.prepare(
				"INSERT INTO session_summaries (id,kind,session_key,agent_id,content,earliest_at,latest_at,created_at) VALUES ('only-summary','session',?,'agent-a','private summary',datetime('now'),datetime('now'),datetime('now'))",
			).run(key);
			db.prepare(
				"INSERT INTO memories (id,content,agent_id,is_deleted,created_at,updated_at) VALUES ('already-forgotten','private memory','agent-a',1,datetime('now'),datetime('now'))",
			).run();
			db.prepare(
				"INSERT INTO derived_memory_sources (derived_memory_id,source_kind,source_id,agent_id,created_at) VALUES ('already-forgotten','summary','only-summary','agent-a',datetime('now'))",
			).run();
		});
		const url = `http://localhost/api/sessions/${key}/transcript?agent_id=agent-a`;
		expect(await (await teamApp().request(url, { method: "DELETE", headers: bearer("agent") })).json()).toMatchObject({
			status: "complete",
			counts: { memories: 1, summaries: 1 },
		});
		expect(
			await getDbAccessor().withReadDbAsync((db) =>
				db
					.prepare(
						"SELECT outcome FROM session_transcript_deleted_sources WHERE kind = 'memory' AND id = 'already-forgotten'",
					)
					.get(),
			),
		).toEqual({ outcome: "deleted" });
		expect(
			await (await teamApp().request(`${url}&purge=hard`, { method: "DELETE", headers: bearer("admin") })).json(),
		).toMatchObject({ status: "complete" });
		expect(await readOne("SELECT 1 FROM memories WHERE id = 'already-forgotten'")).toBeNull();
	});

	it("keeps deletion admission fail closed without revealing another scope", async () => {
		await seed("scope-delete", "User: protected");
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
		expect(await readOne("SELECT 1 FROM session_transcript_deletions WHERE session_key = 'scope-delete'")).toBeNull();
	});

	it.each(["team", "hybrid"] as const)("honors explicit delete and hard-purge permissions in %s mode", async (mode) => {
		writeAuthConfig(mode);
		state.reloadAuthState(agentsDir);
		try {
			const app = teamApp();
			for (const [index, permissions, hard, status] of [
				[0, ["admin"], false, 403],
				[1, ["admin"], true, 200],
				[2, ["forget"], false, 200],
				[3, ["forget"], true, 403],
				[4, ["forget", "admin"], true, 200],
			] as const) {
				const key = `explicit-${mode}-${index}`;
				await seed(key, "User: permission evidence");
				const res = await app.request(
					`http://localhost/api/sessions/${key}/transcript?agent_id=agent-a${hard ? "&purge=hard" : ""}`,
					{ method: "DELETE", headers: bearer("admin", { permissions }) },
				);
				expect({ permissions, hard, status: res.status }).toEqual({ permissions, hard, status });
				expect(Boolean(await transcripts.getStoredSessionTranscriptInfoAsync(key, "agent-a"))).toBe(status !== 200);
			}
		} finally {
			writeAuthConfig("team");
			state.reloadAuthState(agentsDir);
		}
	});

	it("requires explicit identity and an admin hard-purge credential in hybrid mode", async () => {
		await seed("hybrid-delete", "User: hybrid evidence");
		writeAuthConfig("hybrid");
		state.reloadAuthState(agentsDir);
		try {
			const app = teamApp();
			const url = "http://localhost/api/sessions/hybrid-delete/transcript";
			const local = { incoming: { socket: { remoteAddress: "127.0.0.1" } } };
			expect((await app.request(url, { method: "DELETE" }, local)).status).toBe(400);
			expect((await app.request(`${url}?agent_id=agent-a&purge=hard`, { method: "DELETE" }, local)).status).toBe(403);
			expect((await app.request(`${url}?agent_id=agent-a`, { method: "DELETE" })).status).toBe(401);
			expect(
				(await app.request(`${url}?agent_id=agent-a&purge=hard`, { method: "DELETE", headers: bearer("agent") }, local))
					.status,
			).toBe(403);
			expect(
				(await app.request(`${url}?agent_id=agent-b`, { method: "DELETE", headers: bearer("agent") }, local)).status,
			).toBe(404);
			expect(await transcripts.getStoredSessionTranscriptInfoAsync("hybrid-delete", "agent-a")).toMatchObject({
				content: "User: hybrid evidence",
			});
			const allowed = await app.request(
				`${url}?agent_id=agent-a&purge=hard`,
				{ method: "DELETE", headers: bearer("admin") },
				local,
			);
			expect(allowed.status).toBe(200);
			expect(await allowed.json()).toMatchObject({ status: "complete", counts: { transcripts: 1 } });
		} finally {
			writeAuthConfig("team");
			state.reloadAuthState(agentsDir);
		}
	});

	it("upgrades soft deletion to an admin purge against the migrated schema without deleting pinned memories", async () => {
		await seed("purge-delete", "User: purge");
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

	it.skipIf(process.platform === "win32")(
		"returns pending for a FIFO cleanup target without blocking the owner",
		async () => {
			const { canonicalTranscriptPath } = await import("../transcript-jsonl");
			const { constants, openSync, closeSync, unlinkSync } = await import("node:fs");
			const path = canonicalTranscriptPath(agentsDir, "fifo-harness");
			mkdirSync(join(path, ".."), { recursive: true });
			expect(Bun.spawnSync(["mkfifo", path]).exitCode).toBe(0);
			await transcripts.upsertSessionTranscriptAsync(
				"fifo-delete",
				"User: FIFO evidence",
				"fifo-harness",
				"proj-a",
				"agent-a",
			);
			let settled = false;
			const request = Promise.resolve(removeTranscript("fifo-delete")).then((res) => {
				settled = true;
				return res;
			});
			try {
				await new Promise((resolve) => setTimeout(resolve, 800));
				expect(settled).toBe(true);
				expect(await (await request).json()).toMatchObject({
					status: "pending",
					pendingReason: expect.stringContaining("regular file"),
				});
			} finally {
				const fd = openSync(path, constants.O_RDWR | constants.O_NONBLOCK);
				await request;
				closeSync(fd);
				unlinkSync(path);
			}
		},
	);

	it("releases the database owner promptly when capture contends on a transcript lock", async () => {
		const { appendCanonicalLiveTranscriptTurns } = await import("../transcript-capture");
		const { withTranscriptFileLock, canonicalTranscriptPath } = await import("../transcript-jsonl");
		const identity = {
			basePath: agentsDir,
			agentId: "agent-a",
			sessionKey: "capture-lock",
			harness: "capture-lock",
			project: "proj-a",
			userMessage: "retry this new turn",
		};
		await transcripts.upsertSessionTranscriptAsync(
			identity.sessionKey,
			"User: before lock",
			identity.harness,
			identity.project,
			identity.agentId,
		);
		let release = (): void => {};
		let acquired = (): void => {};
		const ready = new Promise<void>((resolve) => {
			acquired = resolve;
		});
		const held = withTranscriptFileLock(canonicalTranscriptPath(agentsDir, identity.harness), async () => {
			acquired();
			await new Promise<void>((resolve) => {
				release = resolve;
			});
		});
		await ready;
		let settled = false;
		const capture = appendCanonicalLiveTranscriptTurns(identity).then(
			() => {
				settled = true;
				return "written";
			},
			(error: unknown) => {
				settled = true;
				return error;
			},
		);
		try {
			await new Promise((resolve) => setTimeout(resolve, 800));
			expect(settled).toBe(true);
			expect(await capture).toMatchObject({
				name: "TranscriptCapturePendingError",
				status: "pending",
				message: "Timed out waiting for transcript lock",
			});
			expect(await readOne("SELECT 1 AS ready")).toEqual({
				ready: 1,
			});
		} finally {
			release();
			await held;
			await capture;
		}
		expect(await appendCanonicalLiveTranscriptTurns(identity)).toBe(true);
	});

	it("resumes bounded deletion and returns the same receipt after completion", async () => {
		await seed("batch-delete", "User: batch");
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
		const request = () => removeTranscript("batch-delete");
		const first = await request();
		expect(await first.json()).toMatchObject({ status: "pending", counts: { memories: 64 } });
		expect(await (await request()).json()).toMatchObject({ status: "pending", counts: { memories: 128 } });
		const complete = await (await request()).json();
		expect(complete).toMatchObject({ status: "complete", counts: { memories: 130 } });
		expect(await (await request()).json()).toEqual(complete);
	});

	it("rejects completed transcript reimports in the owner after deletion and key reuse", async () => {
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
		const deleted = await removeTranscript(commit.canonicalKey);
		expect(deleted.status).toBe(200);
		const retry = await getDbAccessor().withWriteTxAsync((db) =>
			commitCompletedTranscriptBatchInTx(db, [{ ...commit, sourceRecordId: "retry-record" }]),
		);
		expect(retry[0]?.outcome).toBe("session_transcript_deleted");
		const start = await hook(
			teamApp(),
			"session-start",
			{ ...sessionFixture(commit.canonicalKey), runtimePath: "plugin", claimOnly: true },
			bearer("agent"),
		);
		expect(start.status).toBe(200);
		const reused = await getDbAccessor().withWriteTxAsync((db) =>
			commitCompletedTranscriptBatchInTx(db, [{ ...commit, sourceRecordId: "third-record" }]),
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
		const { appendCanonicalTranscriptTurns, canonicalTranscriptPath } = await import("../transcript-jsonl");
		const { readFile } = await import("node:fs/promises");
		await seed("alias-delete", "User: private alias");
		await appendCanonicalTranscriptTurns({
			basePath: agentsDir,
			agentId: "agent-a",
			harness: "codex",
			sessionKey: "session:alias-delete",
			sessionId: "session:alias-delete",
			sourceFormat: "live",
			turns: [{ role: "user", content: "private canonical alias" }],
		});
		const deleted = await removeTranscript("alias-delete");
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
		const { createHash } = await import("node:crypto");
		const removed = `${JSON.stringify({ session_key: "raw-delete", messages: ["private raw evidence"] })}\n`;
		const kept = `${JSON.stringify({ session_key: "raw-keep", messages: ["retained raw evidence"] })}\n`;
		const bytes = Buffer.from(removed + kept);
		await seed("raw-delete", "User: private raw evidence");
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
		const request = () => removeTranscript("raw-delete");
		expect(await (await request()).json()).toMatchObject({
			status: "pending",
			counts: { uploadedBytes: Buffer.byteLength(removed) },
		});
		expect(await (await request()).json()).toMatchObject({ status: "complete" });
		const chunk = await readOne("SELECT content,checksum FROM source_import_chunks WHERE file_id = 'raw-file'");
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
		const request = () => removeTranscript("bytes-delete");
		const [first] = await Promise.all([
			request(),
			appendCanonicalTranscriptTurns({
				basePath: agentsDir,
				agentId: "agent-a",
				harness,
				sessionKey: "bytes-keep",
				sourceFormat: "live",
				turns: [{ role: "assistant", content: "concurrent append" }],
			}),
		]);
		expect(await first.json()).toMatchObject({ status: "pending" });
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
		expect(content).toContain("concurrent append");
		expect(content.trim().split("\n").length).toBe(rows.filter((row) => row.session_key === "bytes-keep").length + 2);
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

	it("limits prompt recall to the credential's project", async () => {
		const now = new Date().toISOString();
		await getDbAccessor().withWriteTxAsync((db) => {
			db.prepare(
				`INSERT INTO entities (id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at)
				 VALUES ('entity-heron', 'Heron', 'heron', 'project', 'agent-a', 10, ?, ?)`,
			).run(now, now);
			const memory = db.prepare(
				`INSERT INTO memories (id, content, type, agent_id, project, updated_by, created_at, updated_at)
				 VALUES (?, ?, 'fact', 'agent-a', ?, 'test', ?, ?)`,
			);
			memory.run("heron-a", "Heron deploys through the alpha pipeline.", "proj-a", now, now);
			memory.run("heron-b", "Heron deploys through the beta pipeline.", "proj-b", now, now);
			db.prepare("DELETE FROM embedding_index_state").run();
		});
		writeFileSync(
			join(agentsDir, "agent.yaml"),
			"embedding:\n  provider: none\n  promptSubmitTimeoutMs: 10000\nhooks:\n  userPromptSubmit:\n    minScore: 0\nmemory:\n  pipelineV2:\n    reranker:\n      enabled: false\nauth:\n  mode: team\n",
		);
		presence.upsertAgentPresence({ ...sessionFixture("sess-scope"), runtimePath: "plugin", provider: "codex" });
		try {
			const res = await hook(
				teamApp(),
				"user-prompt-submit",
				{
					harness: "codex",
					sessionKey: "sess-scope",
					agentId: "agent-a",
					project: "proj-a",
					runtimePath: "plugin",
					userPrompt: "How does Heron deploy its pipeline?",
				},
				bearer("agent", { scope: { agent: "agent-a", project: "proj-a" } }),
			);
			expect(res.status).toBe(200);
			const body = (await res.json()) as { readonly inject: string; readonly engine?: string };
			expect(body.engine).toBe("entity-recall");
			expect(body.inject).toContain("alpha pipeline");
			expect(body.inject).not.toContain("beta pipeline");
		} finally {
			writeAuthConfig("team");
		}
	}, 20_000);

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
		await seed("recorded", "user: hi");
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
		await seed("expired", "user: hi");
		const res = await hook(
			teamApp(),
			"session-start",
			{
				harness: "codex",
				sessionKey: "expired",
				agentId: "agent-a",
				runtimePath: "plugin",
				claimOnly: true,
				project: "proj-b",
			},
			bearer("agent", { scope: { agent: "agent-a", project: "proj-b" } }),
		);
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
