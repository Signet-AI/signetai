import { afterEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { SignetClient } from "../index.js";

interface RecordedRequest {
	readonly method: string;
	readonly path: string;
	readonly query: Record<string, string>;
	readonly body: unknown;
}

let servers: Server[] = [];
let recorded: RecordedRequest[] = [];

function mockDaemon(responseOverride?: (req: RecordedRequest) => Response | unknown): {
	server: Server;
	client: SignetClient;
} {
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
			if (responseBody instanceof Response) {
				return responseBody;
			}
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

describe("Telemetry API", () => {
	test("getTelemetryEvents() sends GET /api/telemetry/events with query params", async () => {
		const { client } = mockDaemon();
		await client.getTelemetryEvents({
			event: "llm.generate",
			since: "2024-01-01",
			limit: 50,
		});

		const req = lastRequest();
		expect(req.method).toBe("GET");
		expect(req.path).toBe("/api/telemetry/events");
		expect(req.query.event).toBe("llm.generate");
		expect(req.query.since).toBe("2024-01-01");
		expect(req.query.limit).toBe("50");
	});

	test("getTelemetryStats() sends GET /api/telemetry/stats", async () => {
		const { client } = mockDaemon();
		await client.getTelemetryStats({ since: "2024-01-01" });

		const req = lastRequest();
		expect(req.method).toBe("GET");
		expect(req.path).toBe("/api/telemetry/stats");
		expect(req.query.since).toBe("2024-01-01");
	});

	test("exportTelemetry() sends GET /api/telemetry/export", async () => {
		const { client } = mockDaemon((req) => {
			if (req.path === "/api/telemetry/export") {
				return new Response('{"id":"1","event":"test"}\n{"id":"2","event":"test"}', {
					headers: { "content-type": "application/x-ndjson" },
				});
			}
			return { ok: true };
		});
		const result = await client.exportTelemetry({ limit: 100 });

		const req = lastRequest();
		expect(req.method).toBe("GET");
		expect(req.path).toBe("/api/telemetry/export");
		expect(req.query.limit).toBe("100");
		expect(typeof result).toBe("string");
		expect(result).toContain('{"id":"1","event":"test"}');
	});

	test("getMemorySearchTelemetry() sends GET /api/telemetry/memory-search with query params", async () => {
		const { client } = mockDaemon();
		await client.getMemorySearchTelemetry({
			agentId: "ant",
			sessionKey: "sess-1",
			noHits: true,
			limit: 25,
			offset: 10,
		});

		const req = lastRequest();
		expect(req.method).toBe("GET");
		expect(req.path).toBe("/api/telemetry/memory-search");
		expect(req.query.agent_id).toBe("ant");
		expect(req.query.session_key).toBe("sess-1");
		expect(req.query.no_hits).toBe("true");
		expect(req.query.limit).toBe("25");
		expect(req.query.offset).toBe("10");
	});

	test("exportMemorySearchTelemetry() sends GET /api/telemetry/memory-search/export", async () => {
		const { client } = mockDaemon((req) => {
			if (req.path === "/api/telemetry/memory-search/export") {
				return new Response('{"id":"search-1","query":"memory qa"}', {
					headers: { "content-type": "application/x-ndjson" },
				});
			}
			return { ok: true };
		});
		const result = await client.exportMemorySearchTelemetry({ route: "POST /api/memory/recall", limit: 500 });

		const req = lastRequest();
		expect(req.method).toBe("GET");
		expect(req.path).toBe("/api/telemetry/memory-search/export");
		expect(req.query.route).toBe("POST /api/memory/recall");
		expect(req.query.limit).toBe("500");
		expect(result).toContain('"query":"memory qa"');
	});
});
