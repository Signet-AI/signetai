import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { Hono } from "hono";
import { createConcurrencyAdmission } from "../concurrency-admission.js";
import {
	__setMcpAdmissionForTests,
	__setMcpRequestGateForTests,
	getMcpWorkloadDiagnostics,
	MCP_MAX_BODY_BYTES,
	mountMcpRoute,
} from "./route.js";

function makeApp(): Hono {
	const app = new Hono();
	mountMcpRoute(app);
	return app;
}

const streamableHeaders = {
	Accept: "application/json, text/event-stream",
	"Content-Type": "application/json",
};

describe("MCP route", () => {
	const originalFetch = globalThis.fetch;
	beforeEach(() => {
		globalThis.fetch = mock(
			async () =>
				new Response(
					JSON.stringify({
						policy: { mode: "hybrid", maxExpandedTools: 12, maxSearchResults: 8 },
						tools: [],
						servers: [],
						count: 0,
					}),
					{
						status: 200,
						headers: { "Content-Type": "application/json" },
					},
				),
		) as unknown as typeof fetch;
	});
	afterEach(() => {
		globalThis.fetch = originalFetch;
		__setMcpAdmissionForTests(null);
		__setMcpRequestGateForTests(null);
	});

	it("keeps cookie-authenticated MCP calls on the caller credential without actor impersonation", async () => {
		const previousKey = process.env.SIGNET_API_KEY;
		process.env.SIGNET_API_KEY = "test-daemon-only-credential";
		const observed: Headers[] = [];
		globalThis.fetch = mock(async (_input: string | URL | Request, init?: RequestInit) => {
			const headers = new Headers(init?.headers);
			observed.push(headers);
			const caller =
				headers.get("cookie") === "signet_session=test-browser-session" &&
				headers.get("x-signet-csrf") === "test-csrf" &&
				!headers.has("authorization") &&
				!headers.has("x-signet-actor") &&
				!headers.has("x-signet-actor-type");
			return Response.json(caller ? { memories: [], stats: {} } : { error: "actor_conflict" }, {
				status: caller ? 200 : 403,
			});
		});
		try {
			const response = await makeApp().request("/mcp", {
				method: "POST",
				headers: { ...streamableHeaders, cookie: "signet_session=test-browser-session", "x-signet-csrf": "test-csrf" },
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					method: "tools/call",
					params: { name: "memory_list", arguments: { limit: 3 } },
				}),
			});
			const body = await response.json();
			expect(body.result.isError).not.toBe(true);
			expect(observed.length).toBeGreaterThan(0);
		} finally {
			if (previousKey === undefined) delete process.env.SIGNET_API_KEY;
			else process.env.SIGNET_API_KEY = previousKey;
		}
	});

	it("rejects requests when the in-flight admission cap is saturated", async () => {
		const admission = createConcurrencyAdmission(1, { maxWaiters: 0 });
		const release = await admission.acquire("local");
		if (typeof release !== "function") throw new Error("expected grant");
		__setMcpAdmissionForTests(admission);
		try {
			const res = await makeApp().request("/mcp", { method: "GET" });
			expect(res.status).toBe(503);
			expect((await res.json()).error.message).toBe("Too many concurrent MCP requests (max 1); retry shortly");
		} finally {
			release();
			__setMcpAdmissionForTests(null);
		}
	});

	it("releases a grant cancelled before MCP work starts", async () => {
		const admission = createConcurrencyAdmission(1);
		__setMcpAdmissionForTests(admission);
		let work = 0;
		__setMcpRequestGateForTests(async () => {
			work++;
		});
		const controller = new AbortController();
		const request = makeApp().request("/mcp", { method: "GET", signal: controller.signal });
		controller.abort();
		const response = await request;
		expect(response.status).toBe(503);
		expect(work).toBe(0);
		expect(admission.inFlight()).toBe(0);
	});

	it("passes parsed Bun/Hono JSON bodies to the streamable HTTP transport", async () => {
		const res = await makeApp().request("/mcp", {
			method: "POST",
			headers: streamableHeaders,
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: {
					protocolVersion: "2024-11-05",
					capabilities: {},
					clientInfo: { name: "route-test", version: "0.1.0" },
				},
			}),
		});

		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.result.serverInfo.name).toBe("signet");
	});

	it("forwards the caller's agent header to memory tools when the query agent is blank", async () => {
		const requested: string[] = [];
		globalThis.fetch = mock(async (input: string | URL | Request) => {
			requested.push(typeof input === "string" ? input : input.toString());
			return new Response(JSON.stringify({ memories: [], stats: {} }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}) as unknown as typeof fetch;

		const res = await makeApp().request("/mcp?agentId=%20", {
			method: "POST",
			headers: { ...streamableHeaders, "x-signet-agent-id": "hermes-a" },
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 2,
				method: "tools/call",
				params: { name: "memory_list", arguments: { limit: 3 } },
			}),
		});

		expect(res.status).toBe(200);
		const list = requested.map((url) => new URL(url)).find((url) => url.pathname === "/api/memories");
		expect(list?.searchParams.get("agentId")).toBe("hermes-a");
	});

	it("refuses an all-agents memory_list from a tool call", async () => {
		const requested: string[] = [];
		globalThis.fetch = mock(async (input: string | URL | Request) => {
			requested.push(typeof input === "string" ? input : input.toString());
			return new Response(JSON.stringify({ memories: [], stats: {} }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}) as unknown as typeof fetch;

		const res = await makeApp().request("/mcp", {
			method: "POST",
			headers: streamableHeaders,
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 3,
				method: "tools/call",
				params: { name: "memory_list", arguments: { agent_id: "all" } },
			}),
		});

		const body = (await res.json()) as { result?: { isError?: boolean }; error?: unknown };
		expect(body.error !== undefined || body.result?.isError === true).toBe(true);
		expect(requested.some((url) => new URL(url).pathname === "/api/memories")).toBe(false);
	});

	it("reports scoped in-flight MCP count and oldest age", async () => {
		let releaseGate: (() => void) | undefined;
		const gateReached = new Promise<void>((resolve) => {
			__setMcpRequestGateForTests(
				() =>
					new Promise<void>((release) => {
						releaseGate = release;
						resolve();
					}),
			);
		});
		const request = makeApp().request("/mcp?agentId=agent-a", {
			method: "POST",
			headers: streamableHeaders,
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: {
					protocolVersion: "2024-11-05",
					capabilities: {},
					clientInfo: { name: "route-test", version: "0.1.0" },
				},
			}),
		});
		await gateReached;
		expect(getMcpWorkloadDiagnostics("agent-a").inFlight).toBe(1);
		expect(getMcpWorkloadDiagnostics("agent-a").oldestAgeMs).toBeGreaterThanOrEqual(0);
		expect(getMcpWorkloadDiagnostics("other")).toEqual({ inFlight: 0, oldestAgeMs: null, maxInFlight: 8 });
		releaseGate?.();
		await request;
		expect(getMcpWorkloadDiagnostics("agent-a")).toEqual({ inFlight: 0, oldestAgeMs: null, maxInFlight: 8 });
	});

	it("counts malformed-body requests while the body is still being read", async () => {
		let releaseGate: (() => void) | undefined;
		const gateReached = new Promise<void>((resolve) => {
			__setMcpRequestGateForTests(
				() =>
					new Promise<void>((release) => {
						releaseGate = release;
						resolve();
					}),
			);
		});
		const request = makeApp().request("/mcp?agentId=agent-a", {
			method: "POST",
			headers: streamableHeaders,
			body: "{",
		});
		await gateReached;
		expect(getMcpWorkloadDiagnostics("agent-a").inFlight).toBe(1);
		releaseGate?.();
		const response = await request;
		expect(response.status).toBe(400);
		expect(getMcpWorkloadDiagnostics("agent-a")).toEqual({ inFlight: 0, oldestAgeMs: null, maxInFlight: 8 });
	});

	it("returns the SDK parse-error shape for malformed JSON", async () => {
		const res = await makeApp().request("/mcp", {
			method: "POST",
			headers: streamableHeaders,
			body: "{",
		});

		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({
			jsonrpc: "2.0",
			error: { code: -32700, message: "Parse error: Invalid JSON" },
			id: null,
		});
	});

	it("rejects oversized JSON bodies before server creation", async () => {
		const res = await makeApp().request("/mcp", {
			method: "POST",
			headers: streamableHeaders,
			body: JSON.stringify({ payload: "x".repeat(MCP_MAX_BODY_BYTES) }),
		});

		expect(res.status).toBe(413);
		expect((await res.json()).error.message).toContain("body exceeds");
	});
});
