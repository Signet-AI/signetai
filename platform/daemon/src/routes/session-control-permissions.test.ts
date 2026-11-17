import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
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
	mkdirSync(join(agentsDir, ".daemon", "logs"), { recursive: true });
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
	it("deletes an owning agent's transcript, fences capture, and supports idempotent admin hard purge", async () => {
		const { dbOwnerQuery } = await import("../db-owner-runtime");
		const jsonl = await import("../transcript-jsonl");
		const key = "delete-session";
		await transcripts.upsertSessionTranscriptAsync(key, "User: private evidence", "pi", "proj-a", "agent-a");
		await jsonl.appendCanonicalTranscriptTurns({
			basePath: agentsDir,
			sessionKey: key,
			agentId: "agent-a",
			harness: "pi",
			sourceFormat: "live",
			turns: [{ role: "user", content: "private evidence" }],
		});
		await jsonl.appendCanonicalTranscriptTurns({
			basePath: agentsDir,
			sessionKey: "keep-session",
			agentId: "agent-a",
			harness: "pi",
			sourceFormat: "live",
			turns: [{ role: "user", content: "unrelated evidence" }],
		});
		await dbOwnerQuery(
			{
				sql: "INSERT INTO memories (id,content,type,source_id,source_type,agent_id,created_at,updated_at) VALUES ('delete-summary','private derived summary','session_summary',?,'pi','agent-a',datetime('now'),datetime('now'))",
				params: [key],
				result: "run",
			},
			{ operation: "test.seed", lane: "write" },
		);
		tracker.claimSession(key, "plugin", "agent-a", "pi");
		const app = teamApp();
		const url = `http://localhost/api/sessions/${key}/transcript`;
		expect(
			(await app.request(url, { method: "DELETE", headers: bearer("agent", { scope: { agent: "agent-b" } }) })).status,
		).toBe(403);
		expect((await app.request(`${url}?purge=hard`, { method: "DELETE", headers: bearer("agent") })).status).toBe(403);
		const deleted = await app.request(url, { method: "DELETE", headers: bearer("agent") });
		expect(deleted.status).toBe(200);
		expect(await deleted.json()).toMatchObject({
			status: "deleted",
			sessionKey: key,
			agentId: "agent-a",
			pendingCleanup: [],
		});
		expect(tracker.isSessionBypassed(key, "agent-a")).toBe(true);
		tracker.unbypassSession(key, "agent-a");
		const late = await app.request("http://localhost/api/hooks/stop", {
			method: "POST",
			headers: bearer("agent"),
			body: JSON.stringify({
				harness: "pi",
				sessionKey: key,
				agentId: "agent-a",
				runtimePath: "plugin",
				lastAssistantMessage: "Late private evidence",
			}),
		});
		expect(late.status).toBe(200);
		expect(await late.json()).toMatchObject({ recorded: false, bypassed: true });
		expect(await transcripts.upsertSessionTranscriptAsync(key, "User: late upload", "pi", "proj-a", "agent-a")).toBe(
			false,
		);
		expect(
			await jsonl.appendCanonicalTranscriptTurns({
				basePath: agentsDir,
				sessionKey: key,
				agentId: "agent-a",
				harness: "pi",
				sourceFormat: "live",
				turns: [{ role: "user", content: "late upload" }],
			}),
		).toBe(false);
		const bytes = readFileSync(jsonl.canonicalTranscriptPath(agentsDir, "pi"), "utf8");
		expect(bytes).not.toContain("private evidence");
		expect(bytes).not.toContain("late upload");
		expect(bytes).toContain("unrelated evidence");
		const summary = await dbOwnerQuery(
			{ sql: "SELECT is_deleted FROM memories WHERE id = 'delete-summary'", result: "get" },
			{ operation: "test.read", lane: "read" },
		);
		expect(summary).toEqual({ is_deleted: 1 });
		expect((await app.request(url, { method: "DELETE", headers: bearer("agent") })).status).toBe(200);
		expect((await app.request(`${url}?purge=hard`, { method: "DELETE", headers: bearer("admin") })).status).toBe(200);
		expect(
			await dbOwnerQuery(
				{ sql: "SELECT id FROM memories WHERE id = 'delete-summary'", result: "get" },
				{ operation: "test.read", lane: "read" },
			),
		).toBeNull();
		expect(
			await dbOwnerQuery(
				{ sql: "SELECT id FROM memory_history WHERE memory_id = 'delete-summary'", result: "get" },
				{ operation: "test.read", lane: "read" },
			),
		).toBeNull();
		tracker.releaseSession(key, "agent-a");
	});

	it("keeps project-limited and read-only transcript deletion fail closed", async () => {
		await transcripts.upsertSessionTranscriptAsync(
			"delete-project",
			"User: project evidence",
			"pi",
			"proj-a",
			"agent-a",
		);
		const app = teamApp();
		const url = "http://localhost/api/sessions/delete-project/transcript";
		expect((await app.request(url, { method: "DELETE", headers: bearer("readonly") })).status).toBe(403);
		expect(
			(
				await app.request(url, {
					method: "DELETE",
					headers: bearer("agent", { scope: { agent: "agent-a", project: "proj-b" } }),
				})
			).status,
		).toBe(403);
		expect((await app.request(`${url}?agent_id=agent-b`, { method: "DELETE", headers: bearer("agent") })).status).toBe(
			403,
		);
		expect((await app.request(`${url}?purge=invalid`, { method: "DELETE", headers: bearer("agent") })).status).toBe(
			400,
		);
		expect(
			(
				await app.request(`${url}?agent_id=agent-a`, {
					method: "DELETE",
					headers: { ...bearer("agent"), "x-signet-agent-id": "agent-b" },
				})
			).status,
		).toBe(403);
		expect((await app.request(`${url}?agent_id=agent-a`, { headers: bearer("agent") })).status).toBe(200);
	});

	it("redacts only the deleted session's upload ranges across chunk boundaries", async () => {
		const { dbOwnerQuery } = await import("../db-owner-runtime");
		const { createJob } = await import("../transcript-import-store");
		const { uploadTranscriptStream, sealTranscriptUpload, readTranscriptBytes } = await import(
			"../transcript-import-bytes"
		);
		const scope = { agentId: "agent-a", jobId: "delete-upload", fileId: "delete-file", generation: 0 };
		await createJob({
			jobId: scope.jobId,
			agentId: scope.agentId,
			files: [{ id: scope.fileId, name: "sessions.jsonl" }],
		});
		const removed = Buffer.from(
			`${JSON.stringify({ session: "delete-upload-session", content: "private".repeat(12_000) })}\n`,
		);
		const kept = Buffer.from(
			`${JSON.stringify({ session: "keep-upload-session", content: "unrelated conversation" })}\n`,
		);
		const bytes = Buffer.concat([removed, kept]);
		await uploadTranscriptStream(
			scope,
			bytes.length,
			(async function* () {
				yield bytes;
			})(),
		);
		await sealTranscriptUpload(scope);
		await dbOwnerQuery(
			{
				sql: "INSERT INTO source_import_records (id,job_id,file_id,source_id,agent_id,ordinal,line_number,byte_offset,byte_length,raw_hash,status,canonical_key) SELECT 'delete-record',job_id,id,source_id,agent_id,0,1,0,?,'hash','imported','delete-upload-session' FROM source_import_files WHERE agent_id = ? AND id = ?",
				params: [removed.length, scope.agentId, scope.fileId],
				result: "run",
			},
			{ operation: "test.seed", lane: "write" },
		);
		await transcripts.upsertSessionTranscriptAsync("delete-upload-session", "User: private", "pi", "proj-a", "agent-a");
		const response = await teamApp().request("http://localhost/api/sessions/delete-upload-session/transcript", {
			method: "DELETE",
			headers: bearer("agent"),
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ counts: { uploadedBytes: removed.length }, pendingCleanup: [] });
		const retained = await readTranscriptBytes(scope, 0, bytes.length);
		expect(Buffer.from(retained).subarray(removed.length)).toEqual(kept);
		expect(Buffer.from(retained).toString()).not.toContain("private");
		expect(
			await dbOwnerQuery(
				{ sql: "SELECT status,rejection_code FROM source_import_records WHERE id = 'delete-record'", result: "get" },
				{ operation: "test.read", lane: "read" },
			),
		).toEqual({ status: "rejected", rejection_code: "session_transcript_deleted" });
	});

	it("purges all attributable memory batches and summary ancestors without touching other sessions", async () => {
		const { dbOwnerQuery } = await import("../db-owner-runtime");
		await transcripts.upsertSessionTranscriptAsync("delete-graph", "User: derived evidence", "pi", "proj-a", "agent-a");
		await dbOwnerQuery(
			{
				sql: "WITH RECURSIVE n(v) AS (VALUES(0) UNION ALL SELECT v+1 FROM n WHERE v<104) INSERT INTO memories (id,content,type,source_id,source_type,agent_id,created_at,updated_at) SELECT 'delete-batch-'||v,'derived evidence '||v,'session_summary','delete-graph','pi','agent-a',datetime('now'),datetime('now') FROM n",
				result: "run",
			},
			{ operation: "test.seed", lane: "write" },
		);
		await dbOwnerQuery(
			{
				sql: "INSERT INTO memories (id,content,type,agent_id,created_at,updated_at) VALUES ('delete-derived','derived semantic memory','fact','agent-a',datetime('now'),datetime('now')),('keep-derived','unrelated memory','fact','agent-a',datetime('now'),datetime('now'))",
				result: "run",
			},
			{ operation: "test.seed", lane: "write" },
		);
		await dbOwnerQuery(
			{
				sql: "INSERT INTO derived_memory_sources (derived_memory_id,source_kind,source_id,agent_id,created_at) VALUES ('delete-derived','transcript','delete-graph','agent-a',datetime('now'))",
				result: "run",
			},
			{ operation: "test.seed", lane: "write" },
		);
		await dbOwnerQuery(
			{
				sql: "INSERT INTO embeddings (id,content_hash,vector,dimensions,source_type,source_id,chunk_text,created_at,agent_id) VALUES ('delete-vector','hash',zeroblob(4),1,'memory','delete-derived','derived semantic memory',datetime('now'),'agent-a')",
				result: "run",
			},
			{ operation: "test.seed", lane: "write" },
		);
		for (const [id, key, depth] of [
			["delete-leaf", "delete-graph", 0],
			["delete-parent", "parent-session", 1],
			["keep-leaf", "keep-graph", 0],
		])
			await dbOwnerQuery(
				{
					sql: "INSERT INTO session_summaries (id,content,kind,depth,session_key,agent_id,earliest_at,latest_at,created_at) VALUES (?,'summary','session',?,?,'agent-a',datetime('now'),datetime('now'),datetime('now'))",
					params: [id, depth, key],
					result: "run",
				},
				{ operation: "test.seed", lane: "write" },
			);
		await dbOwnerQuery(
			{
				sql: "INSERT INTO session_summary_children (parent_id,child_id,ordinal) VALUES ('delete-parent','delete-leaf',0)",
				result: "run",
			},
			{ operation: "test.seed", lane: "write" },
		);
		const response = await teamApp().request("http://localhost/api/sessions/delete-graph/transcript", {
			method: "DELETE",
			headers: bearer("agent"),
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			counts: { memories: 106, summaries: 2, embeddings: 1 },
			pendingCleanup: [],
		});
		expect(
			await dbOwnerQuery(
				{
					sql: "SELECT id FROM memories WHERE id IN ('delete-derived','keep-derived') AND is_deleted = 0",
					result: "all",
				},
				{ operation: "test.read", lane: "read" },
			),
		).toEqual([{ id: "keep-derived" }]);
		expect(
			await dbOwnerQuery(
				{ sql: "SELECT id FROM embeddings WHERE id = 'delete-vector'", result: "get" },
				{ operation: "test.read", lane: "read" },
			),
		).toBeNull();
		expect(
			await dbOwnerQuery(
				{
					sql: "SELECT id FROM session_summaries WHERE id IN ('delete-leaf','delete-parent','keep-leaf')",
					result: "all",
				},
				{ operation: "test.read", lane: "read" },
			),
		).toEqual([{ id: "keep-leaf" }]);
	});

	it("removes retained capture payloads, audit previews, and legacy artifacts and fences later artifact writers", async () => {
		const { dbOwnerQuery } = await import("../db-owner-runtime");
		const { writeTranscriptAudit } = await import("../transcript-audit");
		const { writeTranscriptArtifact } = await import("../memory-lineage");
		const key = "delete-artifacts";
		await transcripts.upsertSessionTranscriptAsync(key, "User: private artifact", "pi", "proj-a", "agent-a");
		const capture = {
			agentId: "agent-a",
			sessionKey: key,
			sessionId: key,
			project: "proj-a",
			harness: "pi",
			capturedAt: "2026-11-17T00:00:00.000Z",
			startedAt: null,
			endedAt: null,
			transcript: "User: private artifact",
		};
		const artifact = await writeTranscriptArtifact(capture);
		const auditInput = {
			basePath: agentsDir,
			agentId: "agent-a",
			sessionKey: key,
			sessionId: key,
			sourceIdentity: key,
			sourcePath: null,
			sourceSha256: null,
			sourceSizeBytes: null,
			sourceFormat: null,
			preview: "private audit evidence",
		};
		const audit = await writeTranscriptAudit(auditInput);
		const legacy = join(agentsDir, "memory", "legacy--transcript.md");
		writeFileSync(
			legacy,
			`---\nkind: transcript\nagent_id: agent-a\nsession_key: ${key}\n---\nprivate legacy evidence`,
		);
		await dbOwnerQuery(
			{
				sql: "INSERT INTO transcript_capture_jobs (id,agent_id,harness,session_key,session_id,transcript,raw_transcript,captured_at,created_at,updated_at) VALUES ('delete-capture','agent-a','pi',?,?,'private payload','private raw payload',datetime('now'),datetime('now'),datetime('now'))",
				params: [key, key],
				result: "run",
			},
			{ operation: "test.seed", lane: "write" },
		);
		const response = await teamApp().request(`http://localhost/api/sessions/${key}/transcript`, {
			method: "DELETE",
			headers: bearer("agent"),
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ counts: { captureJobs: 1 }, pendingCleanup: [] });
		expect(existsSync(join(agentsDir, artifact.transcriptPath))).toBe(false);
		expect(existsSync(legacy)).toBe(false);
		expect(readFileSync(audit.latestPath, "utf8")).not.toContain("private audit evidence");
		expect(
			await dbOwnerQuery(
				{ sql: "SELECT id FROM transcript_capture_jobs WHERE id = 'delete-capture'", result: "get" },
				{ operation: "test.read", lane: "read" },
			),
		).toBeNull();
		await expect(writeTranscriptArtifact(capture)).rejects.toThrow("Session transcript deleted");
		await expect(writeTranscriptAudit(auditInput)).rejects.toThrow("Session transcript deleted");
	});

	it("reports unsafe pending cleanup without touching a symlink target and finishes on retry", async () => {
		const { writeTranscriptArtifact } = await import("../memory-lineage");
		const key = "delete-pending";
		await transcripts.upsertSessionTranscriptAsync(key, "User: pending evidence", "pi", "proj-a", "agent-a");
		const artifact = await writeTranscriptArtifact({
			agentId: "agent-a",
			sessionKey: key,
			sessionId: key,
			project: "proj-a",
			harness: "pi",
			capturedAt: "2026-11-17T00:00:00.000Z",
			startedAt: null,
			endedAt: null,
			transcript: "User: pending evidence",
		});
		const managed = join(agentsDir, artifact.transcriptPath);
		const unrelated = join(agentsDir, "unrelated.md");
		writeFileSync(unrelated, "unrelated evidence");
		unlinkSync(managed);
		symlinkSync(unrelated, managed);
		const url = `http://localhost/api/sessions/${key}/transcript`;
		const pending = await teamApp().request(url, { method: "DELETE", headers: bearer("agent") });
		expect(pending.status).toBe(202);
		expect(await pending.json()).toMatchObject({ pendingCleanup: ["transcript_bytes"] });
		expect(readFileSync(unrelated, "utf8")).toBe("unrelated evidence");
		unlinkSync(managed);
		const retry = await teamApp().request(url, { method: "DELETE", headers: bearer("agent") });
		expect(retry.status).toBe(200);
		expect(await retry.json()).toMatchObject({ pendingCleanup: [] });
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
