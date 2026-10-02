import { describe, expect, test } from "bun:test";
import { createMockDaemonFixture } from "../test-utils/mock-daemon.js";

const { mockDaemon, lastRequest } = createMockDaemonFixture();

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
});
