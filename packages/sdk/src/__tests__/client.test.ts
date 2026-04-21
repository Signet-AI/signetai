import { afterEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { SignetClient } from "../index.js";

interface RecordedRequest {
	readonly method: string;
	readonly path: string;
	readonly query: Record<string, string>;
	readonly body: unknown;
}

let servers: Server[] = [];
let recorded: RecordedRequest[] = [];

function mockDaemon(responseOverride?: (req: RecordedRequest) => unknown): { server: Server; client: SignetClient } {
	const server = Bun.serve({
		port: 0,
		async fetch(req) {
			const url = new URL(req.url);
			const query: Record<string, string> = {};
			for (const [k, v] of url.searchParams) {
				query[k] = v;
			}

			let body: unknown = null;
			const ct = req.headers.get("content-type");
			if (ct?.includes("application/json")) {
				body = await req.json();
			}

			const entry: RecordedRequest = {
				method: req.method,
				path: url.pathname,
				query,
				body,
			};
			recorded.push(entry);

			const responseBody = responseOverride ? responseOverride(entry) : { ok: true };
			return Response.json(responseBody);
		},
	});

	servers.push(server);
	const client = new SignetClient({
		daemonUrl: `http://localhost:${server.port}`,
		retries: 0,
	});

	return { server, client };
}

function lastRequest(): RecordedRequest {
	const req = recorded[recorded.length - 1];
	if (!req) throw new Error("No requests recorded");
	return req;
}

afterEach(() => {
	for (const s of servers) {
		s.stop(true);
	}
	servers = [];
	recorded = [];
});

describe("SignetClient", () => {
	test("remember() sends POST /api/memory/remember with content", async () => {
		const { client } = mockDaemon();
		await client.remember("user prefers dark mode", {
			type: "preference",
			importance: 0.9,
		});

		const req = lastRequest();
		expect(req.method).toBe("POST");
		expect(req.path).toBe("/api/memory/remember");
		expect(req.body).toEqual({
			content: "user prefers dark mode",
			type: "preference",
			importance: 0.9,
		});
	});

	test("recall() sends POST /api/memory/recall with query", async () => {
		const { client } = mockDaemon();
		await client.recall("dark mode", { limit: 5, type: "preference" });

		const req = lastRequest();
		expect(req.method).toBe("POST");
		expect(req.path).toBe("/api/memory/recall");
		expect(req.body).toEqual({
			query: "dark mode",
			limit: 5,
			type: "preference",
		});
	});

	test("recall() returns the daemon recall shape and applies minScore client-side", async () => {
		const { client } = mockDaemon((req) => {
			if (req.path === "/api/memory/recall") {
				return {
					results: [
						{
							id: "mem-low",
							content: "Low confidence memory",
							content_length: 21,
							truncated: false,
							score: 0.42,
							source: "keyword",
							type: "fact",
							tags: null,
							pinned: false,
							importance: 0.4,
							who: "claude-code",
							project: null,
							created_at: "2026-04-01T00:00:00.000Z",
						},
						{
							id: "mem-high",
							content: "High confidence memory",
							content_length: 22,
							truncated: false,
							score: 0.91,
							source: "hybrid",
							type: "fact",
							tags: "important",
							pinned: false,
							importance: 0.9,
							who: "claude-code",
							project: "proj-a",
							created_at: "2026-04-02T00:00:00.000Z",
							supplementary: true,
						},
					],
					query: "confidence",
					method: "hybrid",
					meta: {
						totalReturned: 2,
						hasSupplementary: true,
						noHits: false,
					},
					sources: {
						"mem-high": "memory/abc.md",
					},
				};
			}
			return { ok: true };
		});

		const result = await client.recall("confidence", {
			limit: 5,
			minScore: 0.8,
			until: "2026-04-03T00:00:00Z",
			project: "proj-a",
			keywordQuery: "confidence",
			agentId: "agent-1",
		});

		const req = lastRequest();
		expect(req.method).toBe("POST");
		expect(req.path).toBe("/api/memory/recall");
		expect(req.body).toEqual({
			query: "confidence",
			limit: 5,
			minScore: 0.8,
			until: "2026-04-03T00:00:00Z",
			project: "proj-a",
			keywordQuery: "confidence",
			agentId: "agent-1",
		});
		expect(result.query).toBe("confidence");
		expect(result.method).toBe("hybrid");
		expect(result.meta).toEqual({
			totalReturned: 1,
			hasSupplementary: true,
			noHits: false,
		});
		expect(result.results.map((row) => row.id)).toEqual(["mem-high"]);
		expect(result.sources?.["mem-high"]).toBe("memory/abc.md");
	});

	test("hookRecall() forwards the hook recall filters and returns the typed recall shape", async () => {
		const { client } = mockDaemon((req) => {
			if (req.path === "/api/hooks/recall") {
				return {
					results: [
						{
							id: "mem-1",
							content: "User prefers dark mode",
							content_length: 22,
							truncated: false,
							score: 0.91,
							source: "hybrid",
							type: "preference",
							tags: "ui,theme",
							pinned: false,
							importance: 0.8,
							who: "claude-code",
							project: "proj-a",
							created_at: "2026-04-01T00:00:00.000Z",
						},
					],
					query: "dark mode",
					method: "hybrid",
					meta: {
						totalReturned: 1,
						hasSupplementary: false,
						noHits: false,
					},
				};
			}
			return { ok: true };
		});

		const result = await client.hookRecall({
			query: "dark mode",
			keywordQuery: '"dark mode" OR theme',
			project: "proj-a",
			limit: 5,
			type: "preference",
			tags: "ui,theme",
			who: "claude-code",
			since: "2026-01-01T00:00:00Z",
			until: "2026-04-01T00:00:00Z",
			expand: true,
			sessionKey: "sess-123",
			runtimePath: "plugin",
		});

		const req = lastRequest();
		expect(req.method).toBe("POST");
		expect(req.path).toBe("/api/hooks/recall");
		expect(req.body).toEqual({
			query: "dark mode",
			keywordQuery: '"dark mode" OR theme',
			project: "proj-a",
			limit: 5,
			type: "preference",
			tags: "ui,theme",
			who: "claude-code",
			since: "2026-01-01T00:00:00Z",
			until: "2026-04-01T00:00:00Z",
			expand: true,
			sessionKey: "sess-123",
			runtimePath: "plugin",
		});
		expect(result.meta.totalReturned).toBe(1);
		expect(result.query).toBe("dark mode");
		expect(result.results[0]?.project).toBe("proj-a");
	});

	test("deprecated rememberHook()/recallHook() aliases still work", async () => {
		const { client } = mockDaemon((req) => {
			if (req.path === "/api/hooks/remember") {
				return { id: "mem-1" };
			}
			if (req.path === "/api/hooks/recall") {
				return {
					results: [],
					memories: [],
					count: 0,
					query: "dark mode",
					method: "hybrid",
					meta: {
						totalReturned: 0,
						hasSupplementary: false,
						noHits: true,
					},
				};
			}
			return { ok: true };
		});

		const rememberResult = await client.rememberHook({
			content: "dark mode",
			type: "preference",
		});
		expect(rememberResult.id).toBe("mem-1");
		expect(lastRequest().path).toBe("/api/hooks/remember");

		const recallResult = await client.recallHook({
			query: "dark mode",
			sessionKey: "sess-123",
		});
		expect(recallResult.query).toBe("dark mode");
		expect(lastRequest().path).toBe("/api/hooks/recall");
	});

	test("getMemory() sends GET /api/memory/:id", async () => {
		const { client } = mockDaemon();
		await client.getMemory("mem-abc-123");

		const req = lastRequest();
		expect(req.method).toBe("GET");
		expect(req.path).toBe("/api/memory/mem-abc-123");
	});

	test("listMemories() sends GET /api/memories with query params", async () => {
		const { client } = mockDaemon();
		await client.listMemories({ limit: 20, offset: 5 });

		const req = lastRequest();
		expect(req.method).toBe("GET");
		expect(req.path).toBe("/api/memories");
		expect(req.query.limit).toBe("20");
		expect(req.query.offset).toBe("5");
	});

	test("modifyMemory() sends PATCH /api/memory/:id with ifVersion mapped", async () => {
		const { client } = mockDaemon();
		await client.modifyMemory("mem-xyz", {
			content: "updated content",
			reason: "correction",
			ifVersion: 3,
		});

		const req = lastRequest();
		expect(req.method).toBe("PATCH");
		expect(req.path).toBe("/api/memory/mem-xyz");
		expect(req.body).toEqual({
			content: "updated content",
			reason: "correction",
			if_version: 3,
		});
		// ifVersion should not appear as-is in the body
		const bodyRecord = req.body as Record<string, unknown>;
		expect(bodyRecord.ifVersion).toBeUndefined();
	});

	test("forgetMemory() sends DELETE /api/memory/:id with reason in query", async () => {
		const { client } = mockDaemon();
		await client.forgetMemory("mem-del", {
			reason: "no longer relevant",
			force: true,
			ifVersion: 2,
		});

		const req = lastRequest();
		expect(req.method).toBe("DELETE");
		expect(req.path).toBe("/api/memory/mem-del");
		expect(req.query.reason).toBe("no longer relevant");
		expect(req.query.force).toBe("true");
		expect(req.query.if_version).toBe("2");
	});

	test("batchForget() sends POST /api/memory/forget", async () => {
		const { client } = mockDaemon();
		await client.batchForget({
			mode: "preview",
			query: "old stuff",
			limit: 10,
		});

		const req = lastRequest();
		expect(req.method).toBe("POST");
		expect(req.path).toBe("/api/memory/forget");
		expect(req.body).toEqual({
			mode: "preview",
			query: "old stuff",
			limit: 10,
		});
	});

	test("batchModify() sends POST /api/memory/modify with mapped patches", async () => {
		const { client } = mockDaemon();
		await client.batchModify(
			[
				{ id: "m1", reason: "fix typo", content: "corrected", ifVersion: 1 },
				{ id: "m2", reason: "update", importance: 0.5 },
			],
			{ reason: "batch correction", changed_by: "test" },
		);

		const req = lastRequest();
		expect(req.method).toBe("POST");
		expect(req.path).toBe("/api/memory/modify");

		const body = req.body as Record<string, unknown>;
		const patches = body.patches as Record<string, unknown>[];
		expect(patches).toHaveLength(2);
		expect(patches[0]).toEqual({
			id: "m1",
			reason: "fix typo",
			content: "corrected",
			if_version: 1,
		});
		expect(patches[1]).toEqual({
			id: "m2",
			reason: "update",
			importance: 0.5,
			if_version: undefined,
		});
		expect(body.reason).toBe("batch correction");
		expect(body.changed_by).toBe("test");
	});

	test("getHistory() sends GET /api/memory/:id/history", async () => {
		const { client } = mockDaemon();
		await client.getHistory("mem-hist", { limit: 50 });

		const req = lastRequest();
		expect(req.method).toBe("GET");
		expect(req.path).toBe("/api/memory/mem-hist/history");
		expect(req.query.limit).toBe("50");
	});

	test("recoverMemory() sends POST /api/memory/:id/recover", async () => {
		const { client } = mockDaemon();
		await client.recoverMemory("mem-deleted", {
			reason: "needed again",
			ifVersion: 4,
		});

		const req = lastRequest();
		expect(req.method).toBe("POST");
		expect(req.path).toBe("/api/memory/mem-deleted/recover");
		expect(req.body).toEqual({
			reason: "needed again",
			if_version: 4,
		});
	});

	test("health() sends GET /health", async () => {
		const { client } = mockDaemon();
		await client.health();

		const req = lastRequest();
		expect(req.method).toBe("GET");
		expect(req.path).toBe("/health");
	});

	test("status() sends GET /api/status", async () => {
		const { client } = mockDaemon();
		await client.status();

		const req = lastRequest();
		expect(req.method).toBe("GET");
		expect(req.path).toBe("/api/status");
	});

	test("createDocument() sends POST /api/documents", async () => {
		const { client } = mockDaemon();
		await client.createDocument({
			source_type: "text",
			content: "Some document content",
			title: "Test Doc",
		});

		const req = lastRequest();
		expect(req.method).toBe("POST");
		expect(req.path).toBe("/api/documents");
		expect(req.body).toEqual({
			source_type: "text",
			content: "Some document content",
			title: "Test Doc",
		});
	});

	test("getDocument() sends GET /api/documents/:id", async () => {
		const { client } = mockDaemon();
		await client.getDocument("doc-123");

		const req = lastRequest();
		expect(req.method).toBe("GET");
		expect(req.path).toBe("/api/documents/doc-123");
	});

	test("getJob() sends GET /api/memory/jobs/:id", async () => {
		const { client } = mockDaemon();
		await client.getJob("job-abc-123");

		const req = lastRequest();
		expect(req.method).toBe("GET");
		expect(req.path).toBe("/api/memory/jobs/job-abc-123");
	});

	test("deleteDocument() sends DELETE /api/documents/:id with reason", async () => {
		const { client } = mockDaemon();
		await client.deleteDocument("doc-456", "outdated");

		const req = lastRequest();
		expect(req.method).toBe("DELETE");
		expect(req.path).toBe("/api/documents/doc-456");
		expect(req.query.reason).toBe("outdated");
	});
	test("plugin diagnostics helpers call plugin endpoints", async () => {
		const { client } = mockDaemon((req) => {
			if (req.path === "/api/plugins") return { plugins: [] };
			if (req.path === "/api/plugins/signet.secrets") return { id: "signet.secrets", state: "active" };
			if (req.path === "/api/plugins/signet.secrets/diagnostics")
				return { plugin: { record: { id: "signet.secrets" } } };
			if (req.path === "/api/plugins/prompt-contributions") return { contributions: [], activeCount: 0 };
			if (req.path === "/api/plugins/audit") return { events: [], count: 0 };
			return { ok: true };
		});

		await client.listPlugins();
		expect(lastRequest().path).toBe("/api/plugins");

		await client.getPlugin("signet.secrets");
		expect(lastRequest().path).toBe("/api/plugins/signet.secrets");

		await client.getPluginDiagnostics("signet.secrets");
		expect(lastRequest().path).toBe("/api/plugins/signet.secrets/diagnostics");

		await client.listPluginPromptContributions();
		expect(lastRequest().path).toBe("/api/plugins/prompt-contributions");

		await client.listPluginAuditEvents({
			pluginId: "signet.secrets",
			event: "plugin.enabled",
			since: "2026-04-16T00:00:00.000Z",
			until: "2026-04-17T00:00:00.000Z",
			limit: 10,
		});
		expect(lastRequest()).toMatchObject({
			path: "/api/plugins/audit",
			query: {
				pluginId: "signet.secrets",
				event: "plugin.enabled",
				since: "2026-04-16T00:00:00.000Z",
				until: "2026-04-17T00:00:00.000Z",
				limit: "10",
			},
		});
	});
});
