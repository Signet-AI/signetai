import { afterEach } from "bun:test";
import type { Server } from "bun";
import { SignetClient } from "../index.js";

interface RecordedRequest {
	readonly method: string;
	readonly path: string;
	readonly query: Record<string, string>;
	readonly body: unknown;
}

export function createMockDaemonFixture(): {
	mockDaemon: (responseOverride?: (request: RecordedRequest) => unknown) => {
		server: Server;
		client: SignetClient;
	};
	lastRequest: () => RecordedRequest;
	requests: () => readonly RecordedRequest[];
} {
	let servers: Server[] = [];
	let recorded: RecordedRequest[] = [];

	function mockDaemon(responseOverride?: (request: RecordedRequest) => unknown): {
		server: Server;
		client: SignetClient;
	} {
		const server = Bun.serve({
			port: 0,
			async fetch(request) {
				const url = new URL(request.url);
				const query: Record<string, string> = {};
				for (const [key, value] of url.searchParams) {
					query[key] = value;
				}

				let body: unknown = null;
				if (request.headers.get("content-type")?.includes("application/json")) {
					body = await request.json();
				}

				const entry: RecordedRequest = {
					method: request.method,
					path: url.pathname,
					query,
					body,
				};
				recorded.push(entry);

				const response = responseOverride ? responseOverride(entry) : { ok: true };
				return response instanceof Response ? response : Response.json(response);
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
		const request = recorded[recorded.length - 1];
		if (!request) throw new Error("No requests recorded");
		return request;
	}

	afterEach(() => {
		for (const server of servers) {
			server.stop(true);
		}
		servers = [];
		recorded = [];
	});

	return { mockDaemon, lastRequest, requests: () => recorded };
}
