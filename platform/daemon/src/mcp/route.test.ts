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

	it("rejects requests when the in-flight admission cap is saturated", async () => {
		const admission = createConcurrencyAdmission(1);
		expect(admission.acquire()).toBe(true);
		__setMcpAdmissionForTests(admission);
		try {
			const res = await makeApp().request("/mcp", { method: "GET" });
			expect(res.status).toBe(503);
			expect((await res.json()).error.message).toContain("Too many concurrent MCP requests");
		} finally {
			admission.release();
			__setMcpAdmissionForTests(null);
		}
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
