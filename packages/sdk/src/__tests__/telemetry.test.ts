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
});
