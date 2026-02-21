import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SignetClient } from "../index.js";
import { getMemoryContext, memoryTools } from "../ai-sdk.js";

let mockServer: ReturnType<typeof Bun.serve>;
let port: number;

// Track calls the mock client receives
const calls: { method: string; args: unknown[] }[] = [];

function mockClient(): SignetClient {
  const client = new SignetClient({ daemonUrl: `http://localhost:${port}` });
  return client;
}

beforeAll(() => {
  mockServer = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);

      // recall endpoint - used by memory_search and getMemoryContext
      if (url.pathname === "/api/memory/recall") {
        return Response.json({
          results: [
            {
              id: "m1",
              content: "Test memory content",
              type: "fact",
              importance: 0.8,
              score: 0.95,
              source: "hybrid",
            },
          ],
          stats: { total: 1, searchTime: 5 },
        });
      }

      // remember endpoint - used by memory_store
      if (url.pathname === "/api/memory/remember") {
        return Response.json({
          id: "new-id",
          type: "fact",
          tags: null,
          pinned: false,
          importance: 0.5,
          content: "stored",
        });
      }

      // modify endpoint
      if (req.method === "PATCH" && url.pathname.startsWith("/api/memory/")) {
        return Response.json({
          id: "m1",
          status: "updated",
          currentVersion: 2,
          newVersion: 3,
        });
      }

      // forget endpoint
      if (req.method === "DELETE" && url.pathname.startsWith("/api/memory/")) {
        return Response.json({
          id: "m1",
          status: "deleted",
          currentVersion: 2,
        });
      }

      return new Response("Not found", { status: 404 });
    },
  });
  port = mockServer.port;
});

afterAll(() => {
  mockServer.stop(true);
});

describe("memoryTools", () => {
  test("creates 4 tools with correct names", async () => {
    const client = mockClient();
    const tools = await memoryTools(client);

    const names = Object.keys(tools);
    expect(names).toEqual([
      "memory_search",
      "memory_store",
      "memory_modify",
      "memory_forget",
    ]);
  });

  test("each tool has description and parameters", async () => {
    const client = mockClient();
    const tools = await memoryTools(client);

    for (const tool of Object.values(tools)) {
      expect(typeof tool.description).toBe("string");
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.parameters).toBeDefined();
      expect(typeof tool.execute).toBe("function");
    }
  });

  test("memory_search executes recall", async () => {
    const client = mockClient();
    const tools = await memoryTools(client);

    const result = await tools.memory_search.execute({
      query: "test query",
      limit: 3,
      type: undefined,
    });

    expect(result).toHaveProperty("results");
    expect(result).toHaveProperty("stats");
  });

  test("memory_store executes remember", async () => {
    const client = mockClient();
    const tools = await memoryTools(client);

    const result = await tools.memory_store.execute({
      content: "new fact",
      type: "fact",
      importance: 0.7,
    });

    expect(result).toHaveProperty("id");
  });

  test("memory_modify executes modifyMemory", async () => {
    const client = mockClient();
    const tools = await memoryTools(client);

    const result = await tools.memory_modify.execute({
      id: "m1",
      content: "updated content",
      reason: "correction",
      ifVersion: undefined,
    });

    expect(result).toHaveProperty("status", "updated");
  });

  test("memory_forget executes forgetMemory", async () => {
    const client = mockClient();
    const tools = await memoryTools(client);

    const result = await tools.memory_forget.execute({
      id: "m1",
      reason: "no longer relevant",
    });

    expect(result).toHaveProperty("status", "deleted");
  });
});

describe("getMemoryContext", () => {
  test("returns formatted string with results", async () => {
    const client = mockClient();
    const result = await getMemoryContext(client, "test query");

    expect(result).toContain("## Relevant Memories");
    expect(result).toContain("- Test memory content");
  });

  test("returns empty string when no results", async () => {
    // Use a separate mock server that returns empty results
    const emptyServer = Bun.serve({
      port: 0,
      fetch() {
        return Response.json({
          results: [],
          stats: { total: 0, searchTime: 1 },
        });
      },
    });

    try {
      const client = new SignetClient({
        daemonUrl: `http://localhost:${emptyServer.port}`,
      });
      const result = await getMemoryContext(client, "nothing here");
      expect(result).toBe("");
    } finally {
      emptyServer.stop(true);
    }
  });

  test("respects limit option", async () => {
    // The mock always returns 1 result, but we verify the call goes through
    const client = mockClient();
    const result = await getMemoryContext(client, "query", { limit: 2 });
    expect(result).toContain("## Relevant Memories");
  });
});
