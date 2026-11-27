import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import type { TokenClaims } from "../auth";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "../db-accessor";
import { getStoredSessionTranscriptInfoAsync } from "../session-transcripts";
import { MAX_TRANSCRIPT_UPLOAD_BYTES } from "@signet/core/transcript-upload";
import { withTranscriptUploadAgentLock } from "../transcript-upload-agent-lock";
import { transcriptUploadAgentDirectory } from "../transcript-upload-paths";

const previousSignetPath = process.env.SIGNET_PATH;
const suiteDir = mkdtempSync(join(tmpdir(), "signet-transcript-upload-routes-"));
process.env.SIGNET_PATH = suiteDir;
const { registerHooksRoutes } = await import("./hooks-routes");
const { registerGlobalMiddleware } = await import("../middleware");
const { AGENTS_DIR, authConfig } = await import("./state");
process.env.SIGNET_PATH = AGENTS_DIR;

const agent = `noam-${randomUUID()}`;
let dir = "";
let app: Hono;

function scopedApp(sub: string, scope: TokenClaims["scope"]): Hono {
	const claims: TokenClaims = {
		sub,
		scope,
		role: "agent",
		iat: Math.floor(Date.now() / 1000),
		exp: Math.floor(Date.now() / 1000) + 3600,
	};
	const scoped = new Hono();
	scoped.use("*", async (c, next) => {
		c.set("auth", { authenticated: true, claims });
		await next();
	});
	registerHooksRoutes(scoped);
	return scoped;
}

beforeEach(() => {
	dir = mkdtempSync(join(suiteDir, "case-"));
	initDbAccessor(join(dir, "memory.db"), { agentsDir: dir });
	app = new Hono();
	registerHooksRoutes(app);
});

afterEach(async () => {
	await closeDbAccessor();
	rmSync(dir, { recursive: true, force: true });
});

afterAll(() => {
	if (previousSignetPath === undefined) Reflect.deleteProperty(process.env, "SIGNET_PATH");
	else process.env.SIGNET_PATH = previousSignetPath;
	rmSync(transcriptUploadAgentDirectory(AGENTS_DIR, agent), { recursive: true, force: true });
	rmSync(suiteDir, { recursive: true, force: true });
});

function sha(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function query(overrides: Readonly<Record<string, string | null>> = {}): string {
	const params = new URLSearchParams();
	const values: Record<string, string | null> = {
		harness: "codex",
		sessionKey: "sess-1",
		agentId: agent,
		cwd: "/repo",
		...overrides,
	};
	for (const [key, value] of Object.entries(values)) if (value !== null) params.set(key, value);
	return `/api/hooks/transcript-upload?${params.toString()}`;
}

async function patch(
	body: string,
	options: {
		readonly offset?: number;
		readonly generation?: number;
		readonly checksum?: string;
		readonly query?: Readonly<Record<string, string | null>>;
		readonly target?: Hono;
		readonly stream?: ReadableStream<Uint8Array>;
	} = {},
): Promise<Response> {
	return await (options.target ?? app).request(query(options.query), {
		method: "PATCH",
		headers: {
			"Content-Type": "application/x-ndjson",
			"Upload-Generation": String(options.generation ?? 0),
			"Upload-Offset": String(options.offset ?? 0),
			"Upload-Checksum": options.checksum ?? sha(body),
		},
		body: options.stream ?? body,
	});
}

const SKILL_TRANSCRIPT = `${[
	JSON.stringify({
		sessionId: "sess-1",
		timestamp: "2026-11-26T10:00:00.000Z",
		cwd: "/repo",
		message: { content: [{ type: "tool_use", name: "Skill", id: "toolu_AAA", input: { skill: "web-search" } }] },
	}),
	JSON.stringify({
		sessionId: "sess-1",
		timestamp: "2026-11-26T10:00:01.000Z",
		cwd: "/repo",
		message: { content: [{ type: "tool_result", tool_use_id: "toolu_AAA", is_error: false }] },
	}),
].join("\n")}\n`;

type SkillRow = { skill_name: string; tool_use_id: string | null; origin: string };

async function skillRows(): Promise<SkillRow[]> {
	const deadline = Date.now() + 2000;
	for (;;) {
		const rows = await getDbAccessor().withReadDbAsync(
			(db) =>
				db
					.prepare("SELECT skill_name, tool_use_id, origin FROM skill_invocations WHERE agent_id = ?")
					.all(agent) as SkillRow[],
		);
		if (rows.length > 0 || Date.now() > deadline) return rows;
		await Bun.sleep(20);
	}
}

async function hook(path: string, extra: Readonly<Record<string, string>> = {}): Promise<Response> {
	return await app.request(path, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			harness: "codex",
			sessionKey: "sess-1",
			sessionId: "sess-1",
			agentId: agent,
			cwd: "/repo",
			...extra,
		}),
	});
}

describe("transcript upload route", () => {
	it("appends ranges and reports the committed state", async () => {
		const first = await patch('{"a":1}\n');
		expect(first.status).toBe(200);
		expect(await first.json()).toMatchObject({ committedOffset: 8, generation: 0, tailSha256: sha('{"a":1}\n') });
		expect((await patch('{"b":2}\n', { offset: 8 })).status).toBe(200);
		expect(existsSync(transcriptUploadAgentDirectory(AGENTS_DIR, agent))).toBe(true);
		const state = await app.request(query());
		expect(state.status).toBe(200);
		expect(await state.json()).toEqual({
			committedOffset: 16,
			generation: 0,
			tailSha256: sha('{"a":1}\n{"b":2}\n'),
		});
	});

	it("reports an empty state before the first range", async () => {
		const state = await app.request(query());
		expect(await state.json()).toEqual({ committedOffset: 0, generation: null, tailSha256: null });
	});

	it("refuses a range whose body was still arriving when a purge of its agent finished", async () => {
		const daemon = new Hono();
		registerGlobalMiddleware(daemon);
		registerHooksRoutes(daemon);
		const body = '{"a":1}\n';
		const arrival = Promise.withResolvers<void>();
		const stream = new ReadableStream<Uint8Array>({
			async pull(controller) {
				await arrival.promise;
				controller.enqueue(new TextEncoder().encode(body));
				controller.close();
			},
		});
		const purged = { agentId: `purge-race-${randomUUID()}` };
		const pending = patch(body, { stream, target: daemon, query: purged });
		await Bun.sleep(20);
		await withTranscriptUploadAgentLock(purged.agentId, "exclusive", async () => {});
		arrival.resolve();
		const response = await pending;
		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({ error: "purge_pending", retryable: true });
		const state = await app.request(query(purged));
		expect(await state.json()).toEqual({ committedOffset: 0, generation: null, tailSha256: null });
		expect(existsSync(transcriptUploadAgentDirectory(AGENTS_DIR, purged.agentId))).toBe(false);
	});

	it("requires an agent instead of falling back to the default agent", async () => {
		expect((await patch('{"a":1}\n', { query: { agentId: null } })).status).toBe(400);
		expect((await app.request(query({ agentId: null }))).status).toBe(400);
	});

	it("rejects bad headers and bad bodies", async () => {
		expect((await patch('{"a":1}\n', { checksum: "nope" })).status).toBe(400);
		expect((await patch('{"a":1}\n', { checksum: sha("other") })).status).toBe(400);
		expect((await patch('{"a":1}\n', { offset: -1 })).status).toBe(400);
		expect((await patch('{"a":1}\n', { query: { harness: null } })).status).toBe(400);
		const large = `${"x".repeat(MAX_TRANSCRIPT_UPLOAD_BYTES)}\n`;
		expect((await patch(large)).status).toBe(413);
		expect((await patch(large, { stream: new Blob([large]).stream() })).status).toBe(413);
	});

	it("returns the committed state on a stale offset or another harness", async () => {
		await patch('{"a":1}\n');
		const stale = await patch('{"z":9}\n');
		expect(stale.status).toBe(409);
		expect(await stale.json()).toEqual({
			error: "offset_mismatch",
			committedOffset: 8,
			generation: 0,
			tailSha256: sha('{"a":1}\n'),
		});
		const harness = await patch('{"b":2}\n', { offset: 8, query: { harness: "claude-code" } });
		expect(harness.status).toBe(409);
		expect(await harness.json()).toEqual({ error: "harness_mismatch" });
	});

	it("hides the committed state from another project", async () => {
		await patch('{"a":1}\n');
		expect((await app.request(query({ cwd: "/other" }))).status).toBe(403);
		expect((await app.request(query())).status).toBe(200);
		expect((await app.request(query({ cwd: null }))).status).toBe(200);
	});

	it("hides an upload with no project from a project-scoped token", async () => {
		await patch('{"a":1}\n', { query: { cwd: null } });
		const previousMode = authConfig.mode;
		authConfig.mode = "team";
		const scoped = scopedApp("project-token", { agent, project: "/repo" });
		try {
			expect((await scoped.request(query({ agentId: null }))).status).toBe(403);
			expect((await patch('{"b":2}\n', { offset: 8, target: scoped, query: { agentId: null } })).status).toBe(403);
		} finally {
			authConfig.mode = previousMode;
		}
	});

	it("keeps a checkpoint from copying an upload into another project", async () => {
		const previousMode = authConfig.mode;
		authConfig.mode = "team";
		const scopedTo = (project: string): Hono => scopedApp(`project-token-${project}`, { agent, project });
		const checkpoint = async (target: Hono, project: string): Promise<Response> =>
			await target.request("/api/hooks/session-checkpoint-extract", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ harness: "test", sessionKey: "sess-1", agentId: agent, project }),
			});
		const storedRow = async () => await getStoredSessionTranscriptInfoAsync("sess-1", agent);
		const words = `${"checkpoint upload words ".repeat(30)}\n`;
		const repo = scopedTo("/repo");
		try {
			const uploaded = await patch(words, { target: repo, query: { agentId: null, harness: "test" } });
			expect(uploaded.status).toBe(200);
			expect(await (await checkpoint(scopedTo("/other"), "/other")).json()).toMatchObject({ skipped: true });
			expect(await storedRow()).toBeUndefined();
			expect((await checkpoint(repo, "/repo")).status).toBe(200);
			expect(await storedRow()).toMatchObject({ project: "/repo", content: expect.stringContaining("upload words") });
		} finally {
			authConfig.mode = previousMode;
		}
	});

	it("uses the token agent and rejects another agent in team mode", async () => {
		const previousMode = authConfig.mode;
		authConfig.mode = "team";
		const scoped = scopedApp("agent-token", { agent });
		try {
			expect((await patch('{"a":1}\n', { target: scoped, query: { agentId: "other" } })).status).toBe(403);
			const own = await patch('{"a":1}\n', { target: scoped, query: { agentId: null } });
			expect(own.status).toBe(200);
			expect((await scoped.request(query({ agentId: "other" }))).status).toBe(403);
			expect((await app.request(query())).status).toBe(403);
			const state = await scoped.request(query({ agentId: null }));
			expect(await state.json()).toMatchObject({ committedOffset: 8 });
		} finally {
			authConfig.mode = previousMode;
		}
	});

	it("ends the session on the uploaded transcript instead of the stored one", async () => {
		const uploaded = await patch('{"a":1}\n');
		expect(uploaded.status).toBe(200);
		const { jobId } = await uploaded.json();
		expect(jobId).toEqual(expect.any(String));
		const ended = await app.request("/api/hooks/session-end", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				harness: "codex",
				sessionKey: "sess-1",
				sessionId: "sess-1",
				agentId: agent,
				cwd: "/repo",
				reason: "session_shutdown",
			}),
		});
		expect(ended.status).toBe(200);
		expect(await ended.json()).toMatchObject({ queued: true, transcriptCaptureJobId: jobId });
	});

	it("records the skills of an uploaded transcript at session end", async () => {
		expect((await patch(SKILL_TRANSCRIPT)).status).toBe(200);
		expect((await hook("/api/hooks/session-end")).status).toBe(200);
		expect(await skillRows()).toEqual([{ skill_name: "web-search", tool_use_id: "toolu_AAA", origin: "scan" }]);
	});

	it("records the skills of an uploaded transcript before compaction", async () => {
		expect((await patch(SKILL_TRANSCRIPT)).status).toBe(200);
		expect((await hook("/api/hooks/pre-compaction")).status).toBe(200);
		expect(await skillRows()).toEqual([{ skill_name: "web-search", tool_use_id: "toolu_AAA", origin: "scan" }]);
	});
});
