import { describe, expect, test } from "bun:test";
import { memoryToolDefinitions, executeMemoryTool } from "../openai.js";
import { SignetError } from "../errors.js";
import type { SignetClient } from "../index.js";

// Lightweight mock that tracks calls to each method.
interface MockCall {
  readonly method: string;
  readonly args: readonly unknown[];
}

function createMockClient(): {
  client: SignetClient;
  calls: MockCall[];
} {
  const calls: MockCall[] = [];

  function track(method: string, returnValue: unknown) {
    return (...args: unknown[]) => {
      calls.push({ method, args });
      return Promise.resolve(returnValue);
    };
  }

  const client = {
    recall: track("recall", { results: [], stats: { total: 0 } }),
    remember: track("remember", { id: "new-mem", content: "stored" }),
    modifyMemory: track("modifyMemory", { id: "m1", status: "updated" }),
    forgetMemory: track("forgetMemory", { id: "m1", status: "deleted" }),
  } as unknown as SignetClient;

  return { client, calls };
}

describe("memoryToolDefinitions", () => {
  const tools = memoryToolDefinitions();

  test("returns array of 4 tools", () => {
    expect(tools).toHaveLength(4);
  });

  test("tools have correct names", () => {
    const names = tools.map((t) => t.function.name);
    expect(names).toEqual([
      "memory_search",
      "memory_store",
      "memory_modify",
      "memory_forget",
    ]);
  });

  test("every tool has type: function", () => {
    for (const tool of tools) {
      expect(tool.type).toBe("function");
    }
  });

  test("memory_search requires query", () => {
    const search = tools.find((t) => t.function.name === "memory_search");
    const params = search?.function.parameters as Record<string, unknown>;
    expect(params.required).toEqual(["query"]);
  });

  test("memory_store requires content", () => {
    const store = tools.find((t) => t.function.name === "memory_store");
    const params = store?.function.parameters as Record<string, unknown>;
    expect(params.required).toEqual(["content"]);
  });

  test("memory_modify requires id and reason", () => {
    const modify = tools.find((t) => t.function.name === "memory_modify");
    const params = modify?.function.parameters as Record<string, unknown>;
    expect(params.required).toEqual(["id", "reason"]);
  });

  test("memory_forget requires id and reason", () => {
    const forget = tools.find((t) => t.function.name === "memory_forget");
    const params = forget?.function.parameters as Record<string, unknown>;
    expect(params.required).toEqual(["id", "reason"]);
  });
});

describe("executeMemoryTool", () => {
  test("memory_search dispatches to client.recall()", async () => {
    const { client, calls } = createMockClient();
    await executeMemoryTool(client, "memory_search", {
      query: "preferences",
      limit: 5,
      type: "preference",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("recall");
    expect(calls[0].args[0]).toBe("preferences");
    expect(calls[0].args[1]).toEqual({ limit: 5, type: "preference" });
  });

  test("memory_store dispatches to client.remember()", async () => {
    const { client, calls } = createMockClient();
    await executeMemoryTool(client, "memory_store", {
      content: "user likes vim",
      type: "preference",
      importance: 0.7,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("remember");
    expect(calls[0].args[0]).toBe("user likes vim");
    expect(calls[0].args[1]).toEqual({ type: "preference", importance: 0.7 });
  });

  test("memory_modify dispatches to client.modifyMemory()", async () => {
    const { client, calls } = createMockClient();
    await executeMemoryTool(client, "memory_modify", {
      id: "mem-42",
      content: "updated",
      reason: "correction",
      ifVersion: 2,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("modifyMemory");
    expect(calls[0].args[0]).toBe("mem-42");
    expect(calls[0].args[1]).toEqual({
      content: "updated",
      reason: "correction",
      ifVersion: 2,
    });
  });

  test("memory_forget dispatches to client.forgetMemory()", async () => {
    const { client, calls } = createMockClient();
    await executeMemoryTool(client, "memory_forget", {
      id: "mem-99",
      reason: "user requested removal",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("forgetMemory");
    expect(calls[0].args[0]).toBe("mem-99");
    expect(calls[0].args[1]).toEqual({ reason: "user requested removal" });
  });

  test("unknown tool name throws SignetError", async () => {
    const { client } = createMockClient();

    try {
      await executeMemoryTool(client, "memory_teleport", { dest: "mars" });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(SignetError);
      const sigErr = err as SignetError;
      expect(sigErr.code).toBe("unknown_tool");
      expect(sigErr.message).toContain("memory_teleport");
    }
  });
});
