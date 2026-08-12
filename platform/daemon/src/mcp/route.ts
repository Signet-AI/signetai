/**
 * MCP Streamable HTTP route for the Signet daemon.
 *
 * Mounts a /mcp endpoint on the Hono app that serves MCP tool calls
 * using the web-standard Streamable HTTP transport. Stateless mode —
 * each request gets a fresh server + transport instance.
 */

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Context } from "hono";
import type { Hono } from "hono";
import { type ConcurrencyAdmission, createConcurrencyAdmission } from "../concurrency-admission.js";
import { createMcpServer } from "./tools.js";

interface ActiveMcpRequest {
	readonly agentId: string;
	readonly startedAt: number;
}

const activeMcpRequests = new Map<number, ActiveMcpRequest>();
let nextMcpRequestId = 1;

export const MCP_MAX_IN_FLIGHT = 8;
export const MCP_MAX_BODY_BYTES = 512 * 1024;
let mcpAdmission: ConcurrencyAdmission = createConcurrencyAdmission(MCP_MAX_IN_FLIGHT);

export function __setMcpAdmissionForTests(admission: ConcurrencyAdmission | null): void {
	mcpAdmission = admission ?? createConcurrencyAdmission(MCP_MAX_IN_FLIGHT);
}

export interface McpWorkloadDiagnostics {
	readonly inFlight: number;
	readonly oldestAgeMs: number | null;
	readonly maxInFlight: number;
}

export function getMcpWorkloadDiagnostics(agentId = "default"): McpWorkloadDiagnostics {
	const scopedAgentId = agentId.trim() || "default";
	const now = Date.now();
	let inFlight = 0;
	let oldestAgeMs: number | null = null;
	for (const request of activeMcpRequests.values()) {
		if (request.agentId !== scopedAgentId) continue;
		inFlight += 1;
		const ageMs = Math.max(0, now - request.startedAt);
		oldestAgeMs = oldestAgeMs === null ? ageMs : Math.max(oldestAgeMs, ageMs);
	}
	return { inFlight, oldestAgeMs, maxInFlight: MCP_MAX_IN_FLIGHT };
}

function resolveMcpWorkloadAgentId(c: Context): string {
	const scopedAgentId = c.get("auth")?.claims?.scope.agent?.trim();
	if (scopedAgentId) return scopedAgentId;
	const requestedAgentId = c.req.query("agentId") ?? c.req.header("x-signet-agent-id") ?? "default";
	return requestedAgentId.trim() || "default";
}

export function mountMcpRoute(app: Hono): void {
	// POST /mcp — main MCP message endpoint
	// GET /mcp — SSE stream for server-initiated notifications
	// DELETE /mcp — session termination
	app.all("/mcp", async (c) => {
		if (!mcpAdmission.acquire()) {
			return c.json(
				{
					jsonrpc: "2.0",
					error: {
						code: -32000,
						message: `Too many concurrent MCP requests (max ${MCP_MAX_IN_FLIGHT}); retry shortly`,
					},
					id: null,
				},
				503,
			);
		}
		let requestId: number | null = null;
		let transport: WebStandardStreamableHTTPServerTransport | null = null;
		let server: Awaited<ReturnType<typeof createMcpServer>> | null = null;
		try {
			const parsedBody = await parseMcpJsonBody(c);
			if (parsedBody instanceof Response) return parsedBody;
			requestId = nextMcpRequestId++;
			activeMcpRequests.set(requestId, {
				agentId: resolveMcpWorkloadAgentId(c),
				startedAt: Date.now(),
			});
			transport = new WebStandardStreamableHTTPServerTransport({
				sessionIdGenerator: undefined, // stateless
				enableJsonResponse: true,
			});
			const harness = c.req.query("harness") ?? c.req.header("x-signet-harness") ?? undefined;
			const workspace = c.req.query("workspace") ?? c.req.header("x-signet-workspace") ?? undefined;
			const channel = c.req.query("channel") ?? c.req.header("x-signet-channel") ?? undefined;

			server = await createMcpServer({
				authorizationHeader: c.req.header("authorization"),
				context: {
					harness,
					workspace,
					channel,
				},
			});
			await server.connect(transport);
			const response = await transport.handleRequest(c.req.raw, parsedBody === undefined ? undefined : { parsedBody });
			return response;
		} finally {
			try {
				if (transport) await transport.close();
			} finally {
				try {
					if (server) await server.close();
				} finally {
					if (requestId !== null) activeMcpRequests.delete(requestId);
					mcpAdmission.release();
				}
			}
		}
	});
}

async function parseMcpJsonBody(c: Context): Promise<unknown | Response | undefined> {
	if (c.req.method !== "POST") {
		return undefined;
	}
	if (!c.req.raw.headers.get("content-type")?.includes("application/json")) {
		return undefined;
	}
	const contentLength = c.req.raw.headers.get("content-length");
	if (contentLength) {
		const bytes = Number(contentLength);
		if (Number.isFinite(bytes) && bytes > MCP_MAX_BODY_BYTES) {
			return tooLargeMcpBody();
		}
	}
	try {
		const reader = c.req.raw.clone().body?.getReader();
		if (!reader) return undefined;
		const chunks: Uint8Array[] = [];
		let total = 0;
		try {
			while (true) {
				const next = await reader.read();
				if (next.done || !next.value) break;
				total += next.value.byteLength;
				if (total > MCP_MAX_BODY_BYTES) {
					await reader.cancel().catch(() => undefined);
					return tooLargeMcpBody();
				}
				chunks.push(next.value);
			}
		} finally {
			await reader.cancel().catch(() => undefined);
		}
		const bytes = new Uint8Array(total);
		let offset = 0;
		for (const chunk of chunks) {
			bytes.set(chunk, offset);
			offset += chunk.byteLength;
		}
		const raw = new TextDecoder().decode(bytes);
		return JSON.parse(raw);
	} catch {
		return c.json(
			{
				jsonrpc: "2.0",
				error: { code: -32700, message: "Parse error: Invalid JSON" },
				id: null,
			},
			400,
		);
	}
}

function tooLargeMcpBody(): Response {
	return new Response(
		JSON.stringify({
			jsonrpc: "2.0",
			error: { code: -32000, message: `MCP request body exceeds ${MCP_MAX_BODY_BYTES} byte limit` },
			id: null,
		}),
		{
			status: 413,
			headers: { "Content-Type": "application/json" },
		},
	);
}
