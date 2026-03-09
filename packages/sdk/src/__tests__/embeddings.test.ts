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

function mockDaemon(
  responseOverride?: (req: RecordedRequest) => unknown,
): { server: Server; client: SignetClient } {
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

      const responseBody = responseOverride
        ? responseOverride(entry)
        : { ok: true };
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
});
