import { afterEach, describe, expect, test } from "bun:test";
import { SignetClient } from "../index.js";
import type { Server } from "bun";

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

describe("Embeddings API", () => {
	test("getEmbeddingStatus() sends GET /api/embeddings/status", async () => {
		const { client } = mockDaemon();
		await client.getEmbeddingStatus();

		const req = lastRequest();
		expect(req.method).toBe("GET");
		expect(req.path).toBe("/api/embeddings/status");
	});

	test("getEmbeddingHealth() sends GET /api/embeddings/health", async () => {
		const { client } = mockDaemon();
		await client.getEmbeddingHealth();

		const req = lastRequest();
		expect(req.method).toBe("GET");
		expect(req.path).toBe("/api/embeddings/health");
	});

	test("getEmbeddingProjection() sends GET /api/embeddings/projection with dimensions", async () => {
		const { client } = mockDaemon((req) => {
			if (req.path === "/api/embeddings/projection") {
				return {
					status: "ready",
					dimensions: 2,
					count: 1,
					total: 1,
					limit: 1,
					offset: 0,
					hasMore: false,
					nodes: [{ id: "m1", x: 0, y: 0 }],
					edges: [],
				};
			}
			return { ok: true };
		});
		const projection = await client.getEmbeddingProjection({ dimensions: 2 });

		const req = lastRequest();
		expect(req.method).toBe("GET");
		expect(req.path).toBe("/api/embeddings/projection");
		expect(req.query.dimensions).toBe("2");
		expect(projection.status).toBe("ready");
	});

	test("cancelEmbeddingProjection() accepts the successful cancellation response", async () => {
		const { client } = mockDaemon((req) => {
			if (req.path === "/api/embeddings/projection/job-123")
				return { status: "cancelled", jobId: "job-123", dimensions: 2 };
			return { ok: true };
		});

		const result = await client.cancelEmbeddingProjection("job-123");

		expect(lastRequest()).toMatchObject({ method: "DELETE", path: "/api/embeddings/projection/job-123" });
		expect(result).toEqual({ status: "cancelled", jobId: "job-123", dimensions: 2 });
	});

	test("cancelEmbeddingProjection() exposes ready, timeout, and error terminal responses", async () => {
		const responses: unknown[] = [
			{
				status: "ready",
				jobId: "job-123",
				dimensions: 2,
				count: 1,
				total: 1,
				limit: 1,
				offset: 0,
				hasMore: false,
				sampled: false,
				nodes: [{ id: "m1", x: 0, y: 0 }],
				edges: [],
			},
			{
				status: "timeout",
				jobId: "job-123",
				dimensions: 2,
				message: "Embedding projection exceeded its deadline",
				code: "PROJECTION_TIMEOUT",
			},
			{
				status: "error",
				jobId: "job-123",
				dimensions: 2,
				message: "Projection worker failed",
				code: "PROJECTION_ERROR",
			},
		];
		const { client } = mockDaemon(() => responses.shift());

		const ready = await client.cancelEmbeddingProjection("job-123");
		if (ready.status !== "ready") throw new Error(`Expected ready response, got ${ready.status}`);
		expect(ready.jobId).toBe("job-123");
		expect(ready.nodes).toHaveLength(1);

		const timeout = await client.cancelEmbeddingProjection("job-123");
		if (timeout.status !== "timeout") throw new Error(`Expected timeout response, got ${timeout.status}`);
		expect(timeout.message).toContain("deadline");
		expect(timeout.code).toBe("PROJECTION_TIMEOUT");

		const error = await client.cancelEmbeddingProjection("job-123");
		if (error.status !== "error") throw new Error(`Expected error response, got ${error.status}`);
		expect(error.message).toBe("Projection worker failed");
		expect(error.code).toBe("PROJECTION_ERROR");
	});
});
