import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Context } from "hono";
import { z } from "zod";
import { requirePermission } from "../auth";
import { requireLocalHost } from "../host-route-guard";
import { authConfig } from "../routes/state";
import type { Hono } from "hono";
import { admissionKey, type ConcurrencyAdmission, createConcurrencyAdmission } from "../concurrency-admission.js";
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
let mcpRequestGateForTests: (() => Promise<void>) | null = null;

export function __setMcpAdmissionForTests(admission: ConcurrencyAdmission | null): void {
	mcpAdmission = admission ?? createConcurrencyAdmission(MCP_MAX_IN_FLIGHT);
}

export function __setMcpRequestGateForTests(gate: (() => Promise<void>) | null): void {
	mcpRequestGateForTests = gate;
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

function requestedMcpAgentId(c: Context): string | undefined {
	return c.req.query("agentId")?.trim() || c.req.header("x-signet-agent-id")?.trim() || undefined;
}

function resolveMcpWorkloadAgentId(c: Context): string {
	return c.get("auth")?.claims?.scope.agent?.trim() || requestedMcpAgentId(c) || "default";
}

export function mountMcpRoute(app: Hono): void {
	app.all("/mcp", async (c) => {
		const release = await mcpAdmission.acquire(admissionKey(c), c.req.raw.signal);
		if (typeof release !== "function" || c.req.raw.signal.aborted) {
			if (typeof release === "function") release();
			c.header("Retry-After", String(typeof release === "function" ? 1 : release.retryAfter));
			return c.json(
				{
					jsonrpc: "2.0",
					reason: "admission",
					error: {
						code: -32000,
						message: `Too many concurrent MCP requests (max ${mcpAdmission.maxInFlight}); retry shortly`,
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
			requestId = nextMcpRequestId++;
			activeMcpRequests.set(requestId, {
				agentId: resolveMcpWorkloadAgentId(c),
				startedAt: Date.now(),
			});
			await mcpRequestGateForTests?.();
			const parsedBody = await parseMcpJsonBody(c);
			if (parsedBody instanceof Response) return parsedBody;
			for (const element of Array.isArray(parsedBody) ? parsedBody : [parsedBody]) {
				const call = z
					.object({ method: z.literal("tools/call"), params: z.object({ name: z.string() }) })
					.safeParse(element);
				if (call.success && /^(?:signet_)?code_/.test(call.data.params.name)) {
					const hostDenied = requireLocalHost(c);
					if (hostDenied) return hostDenied;
					const permission = /clear|index/.test(call.data.params.name) ? "admin" : "recall";
					if (!c.get("principal"))
						return c.json({ reason: "permission", required: permission, error: "A principal is required" }, 403);
					const denied = await requirePermission(permission, authConfig)(c, () => Promise.resolve());
					if (denied) return denied;
				}
			}

			transport = new WebStandardStreamableHTTPServerTransport({
				sessionIdGenerator: undefined,
				enableJsonResponse: true,
			});
			const cookie = c.req.header("cookie");
			const csrf = c.req.header("x-signet-csrf");
			server = await createMcpServer({
				authorizationHeader: c.req.header("authorization"),
				allowEnvironmentAuth: false,
				request: async (url, init) => app.request(new Request(url, init)),
				forwardedHeaders: {
					...(cookie ? { cookie } : {}),
					...(csrf ? { "x-signet-csrf": csrf } : {}),
				},
				agentId: requestedMcpAgentId(c),
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
					release();
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
