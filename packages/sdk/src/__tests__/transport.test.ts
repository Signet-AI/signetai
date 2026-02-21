import { afterEach, describe, expect, test } from "bun:test";
import { SignetTransport } from "../transport.js";
import {
  SignetApiError,
  SignetNetworkError,
  SignetTimeoutError,
} from "../errors.js";
import type { Server } from "bun";

let servers: Server[] = [];

function mockServer(
  handler: (req: Request) => Response | Promise<Response>,
): Server {
  const server = Bun.serve({
    port: 0,
    fetch: handler,
  });
  servers.push(server);
  return server;
}

afterEach(() => {
  for (const s of servers) {
    s.stop(true);
  }
  servers = [];
});

describe("SignetTransport", () => {
  test("successful GET returns parsed JSON", async () => {
    const payload = { ok: true, data: [1, 2, 3] };
    const server = mockServer(() =>
      Response.json(payload),
    );

    const transport = new SignetTransport({
      baseUrl: `http://localhost:${server.port}`,
    });
    const result = await transport.get<typeof payload>("/test");
    expect(result).toEqual(payload);
  });

  test("successful POST sends body and returns parsed JSON", async () => {
    let receivedBody: unknown;
    let receivedContentType: string | null = null;

    const server = mockServer(async (req) => {
      receivedContentType = req.headers.get("content-type");
      receivedBody = await req.json();
      return Response.json({ saved: true });
    });

    const transport = new SignetTransport({
      baseUrl: `http://localhost:${server.port}`,
    });
    const body = { content: "hello world", importance: 0.8 };
    const result = await transport.post<{ saved: boolean }>("/save", body);

    expect(result).toEqual({ saved: true });
    expect(receivedBody).toEqual(body);
    expect(receivedContentType).toBe("application/json");
  });

  test("4xx response throws SignetApiError with status and body", async () => {
    const errorBody = { error: "Memory not found" };
    const server = mockServer(() =>
      Response.json(errorBody, { status: 404 }),
    );

    const transport = new SignetTransport({
      baseUrl: `http://localhost:${server.port}`,
    });

    try {
      await transport.get("/missing");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(SignetApiError);
      const apiErr = err as SignetApiError;
      expect(apiErr.status).toBe(404);
      expect(apiErr.body).toEqual(errorBody);
      expect(apiErr.message).toBe("Memory not found");
    }
  });

  test("5xx response throws SignetApiError", async () => {
    const server = mockServer(() =>
      Response.json({ error: "Internal failure" }, { status: 500 }),
    );

    const transport = new SignetTransport({
      baseUrl: `http://localhost:${server.port}`,
    });

    try {
      await transport.get("/broken");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(SignetApiError);
      const apiErr = err as SignetApiError;
      expect(apiErr.status).toBe(500);
    }
  });

  test("network timeout throws SignetTimeoutError", async () => {
    const server = mockServer(async () => {
      // Stall long enough to exceed the timeout
      await new Promise((resolve) => setTimeout(resolve, 5000));
      return Response.json({ ok: true });
    });

    const transport = new SignetTransport({
      baseUrl: `http://localhost:${server.port}`,
      timeoutMs: 50,
      retries: 0,
    });

    try {
      await transport.get("/slow");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(SignetTimeoutError);
      expect((err as SignetTimeoutError).message).toContain("50ms");
    }
  });

  test("GET retries on network error up to retries count", async () => {
    // Grab a port by starting a server, then stop it immediately.
    // This gives us a port where nothing is listening (connection refused).
    const tempServer = Bun.serve({ port: 0, fetch: () => new Response() });
    const port = tempServer.port;
    tempServer.stop(true);

    const transport = new SignetTransport({
      baseUrl: `http://localhost:${port}`,
      retries: 2,
      retryDelayMs: 10,
    });

    try {
      await transport.get("/flaky");
      expect.unreachable("should have thrown");
    } catch (err) {
      // After 1 initial + 2 retries = 3 attempts, it should throw
      // a network error (not an API error).
      expect(err).not.toBeInstanceOf(SignetApiError);
      expect(err).toBeInstanceOf(SignetNetworkError);
    }
  });

  test("POST does not retry on network error", async () => {
    // Same technique: grab a port with nothing listening
    const tempServer = Bun.serve({ port: 0, fetch: () => new Response() });
    const port = tempServer.port;
    tempServer.stop(true);

    const transport = new SignetTransport({
      baseUrl: `http://localhost:${port}`,
      retries: 3,
      retryDelayMs: 10,
      timeoutMs: 1000,
    });

    const start = Date.now();
    try {
      await transport.post("/fail", { data: 1 });
      expect.unreachable("should have thrown");
    } catch (err) {
      const elapsed = Date.now() - start;
      expect(err).toBeInstanceOf(SignetNetworkError);
      // POST should fail fast (1 attempt, no retries).
      // With retries=3 and retryDelayMs=10, if it retried we'd see
      // at least 10+20+30 = 60ms of delay. Should be well under that.
      expect(elapsed).toBeLessThan(50);
    }
  });

  test("custom headers from config are sent", async () => {
    let receivedHeaders: Record<string, string> = {};

    const server = mockServer((req) => {
      receivedHeaders = {
        "x-signet-actor": req.headers.get("x-signet-actor") ?? "",
        "x-custom": req.headers.get("x-custom") ?? "",
      };
      return Response.json({ ok: true });
    });

    const transport = new SignetTransport({
      baseUrl: `http://localhost:${server.port}`,
      headers: {
        "x-signet-actor": "test-agent",
        "x-custom": "custom-value",
      },
    });

    await transport.get("/check-headers");
    expect(receivedHeaders["x-signet-actor"]).toBe("test-agent");
    expect(receivedHeaders["x-custom"]).toBe("custom-value");
  });

  test("query parameters are correctly appended to URL", async () => {
    let receivedUrl = "";

    const server = mockServer((req) => {
      receivedUrl = req.url;
      return Response.json({ ok: true });
    });

    const transport = new SignetTransport({
      baseUrl: `http://localhost:${server.port}`,
    });

    await transport.get("/search", {
      q: "hello world",
      limit: 10,
      active: true,
      missing: undefined,
    });

    const url = new URL(receivedUrl);
    expect(url.pathname).toBe("/search");
    expect(url.searchParams.get("q")).toBe("hello world");
    expect(url.searchParams.get("limit")).toBe("10");
    expect(url.searchParams.get("active")).toBe("true");
    // undefined values should be omitted
    expect(url.searchParams.has("missing")).toBe(false);
  });
});
