import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import type { TokenClaims } from "../auth";
import { closeDbAccessor, initDbAccessor } from "../db-accessor";
import { MAX_TRANSCRIPT_UPLOAD_BYTES } from "@signet/core/transcript-upload";
import { withTranscriptUploadAgentLock } from "../transcript-upload-agent-lock";
import { transcriptUploadAgentDirectory } from "../transcript-upload-paths";

const previousSignetPath = process.env.SIGNET_PATH;
const suiteDir = mkdtempSync(join(tmpdir(), "signet-transcript-upload-routes-"));
process.env.SIGNET_PATH = suiteDir;
const { registerHooksRoutes } = await import("./hooks-routes");
const { registerGlobalMiddleware } = await import("../middleware");
const { AGENTS_DIR, authConfig } = await import("./state");

const agent = `noam-${randomUUID()}`;
let dir = "";
let app: Hono;

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
		const claims: TokenClaims = {
			sub: "project-token",
			scope: { agent, project: "/repo" },
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
		try {
			expect((await scoped.request(query({ agentId: null }))).status).toBe(403);
			expect((await patch('{"b":2}\n', { offset: 8, target: scoped, query: { agentId: null } })).status).toBe(403);
		} finally {
			authConfig.mode = previousMode;
		}
	});

	it("uses the token agent and rejects another agent in team mode", async () => {
		const previousMode = authConfig.mode;
		authConfig.mode = "team";
		const claims: TokenClaims = {
			sub: "agent-token",
			scope: { agent },
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
});
