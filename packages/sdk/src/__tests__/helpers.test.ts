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

function mockDaemon(responseOverride?: (req: RecordedRequest) => Response | unknown): {
	server: Server;
	client: SignetClient;
} {
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
			if (responseBody instanceof Response) {
				return responseBody;
			}
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

describe("SignetClientHelpers", () => {
	test("waitForJob() polls until job completes", async () => {
		let callCount = 0;
		const { client } = mockDaemon((req) => {
			if (req.path.includes("/jobs/")) {
				callCount++;
				return {
					id: "job-123",
					status: callCount < 3 ? "pending" : "done",
					progress: callCount * 33,
				};
			}
			return { ok: true };
		});

		const result = await client.waitForJob("job-123", {
			interval: 10,
			timeout: 1000,
		});

		expect(result.status).toBe("done");
		expect(callCount).toBeGreaterThanOrEqual(3);
	});

	test("waitForJob() throws on timeout", async () => {
		const { client } = mockDaemon(() => ({
			id: "job-123",
			status: "pending",
			progress: 0,
		}));

		await expect(client.waitForJob("job-123", { interval: 10, timeout: 50 })).rejects.toThrow(
			"did not complete within 50ms",
		);
	});

	test("createAndIngestDocument() creates and waits for ingestion", async () => {
		let readCount = 0;
		const { client } = mockDaemon((req) => {
			if (req.path === "/api/documents" && req.method === "POST") {
				return { id: "doc-123", status: "queued" };
			}
			if (req.path === "/api/documents/doc-123") {
				readCount++;
				return {
					id: "doc-123",
					status: readCount < 3 ? "embedding" : "done",
					title: "Test Doc",
					created_at: new Date().toISOString(),
				};
			}
			return { ok: true };
		});

		const doc = await client.createAndIngestDocument({
			source_type: "url",
			url: "https://example.com",
		});

		expect(doc.id).toBe("doc-123");
		expect(doc.status).toBe("done");
		expect(readCount).toBeGreaterThanOrEqual(3);
	});

	test("recallOrThrow() returns results when found", async () => {
		const { client } = mockDaemon(() => ({
			results: [
				{
					id: "mem-1",
					content: "user prefers dark mode",
					score: 0.95,
				},
			],
			total: 1,
		}));

		const result = await client.recallOrThrow("dark mode");
		expect(result.results).toHaveLength(1);
		expect(result.results[0].content).toBe("user prefers dark mode");
	});

	test("recallOrThrow() throws when no results", async () => {
		const { client } = mockDaemon(() => ({
			results: [],
			total: 0,
		}));

		await expect(client.recallOrThrow("nonexistent")).rejects.toThrow('No memories found for query: "nonexistent"');
	});

	test("getMemoryOrThrow() returns memory when found", async () => {
		const { client } = mockDaemon(() => ({
			id: "mem-abc",
			content: "test memory",
			created_at: new Date().toISOString(),
			type: "fact",
		}));

		const memory = await client.getMemoryOrThrow("mem-abc");
		expect(memory.id).toBe("mem-abc");
		expect(memory.content).toBe("test memory");
	});

	test("getMemoryOrThrow() maps API 404 to friendly message", async () => {
		const { client } = mockDaemon((req) => {
			if (req.path === "/api/memory/mem-missing") {
				return Response.json({ error: "not found" }, { status: 404 });
			}
			return { ok: true };
		});

		await expect(client.getMemoryOrThrow("mem-missing")).rejects.toThrow("Memory not found: mem-missing");
	});

	test("getDocumentOrThrow() returns document when found", async () => {
		const { client } = mockDaemon(() => ({
			id: "doc-123",
			status: "ready",
			title: "Test Document",
			created_at: new Date().toISOString(),
		}));

		const doc = await client.getDocumentOrThrow("doc-123");
		expect(doc.id).toBe("doc-123");
		expect(doc.title).toBe("Test Document");
	});

	test("getDocumentOrThrow() maps API 404 to friendly message", async () => {
		const { client } = mockDaemon((req) => {
			if (req.path === "/api/documents/doc-missing") {
				return Response.json({ error: "missing document" }, { status: 404 });
			}
			return { ok: true };
		});

		await expect(client.getDocumentOrThrow("doc-missing")).rejects.toThrow("Document not found: doc-missing");
	});

	test("batchModifyWithProgress() calls progress callback", async () => {
		const progressCalls: Array<{ done: number; total: number }> = [];

		const { client } = mockDaemon(() => ({
			success: 2,
			failed: 0,
			results: [
				{ id: "m1", success: true },
				{ id: "m2", success: true },
			],
		}));

		const result = await client.batchModifyWithProgress(
			[
				{ id: "m1", reason: "fix", content: "updated 1" },
				{ id: "m2", reason: "fix", content: "updated 2" },
			],
			(progress) => {
				progressCalls.push(progress);
			},
		);

		expect(result.success).toBe(2);
		expect(progressCalls).toHaveLength(2);
		expect(progressCalls[0]).toEqual({ done: 0, total: 2 });
		expect(progressCalls[1]).toEqual({ done: 2, total: 2 });
	});
});
