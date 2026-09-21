import { afterEach, describe, expect, it } from "bun:test";
import { createDaemonClient } from "./src/daemon-client.js";
import { PROMPT_SUBMIT_TIMEOUT } from "./src/types.js";

const servers: Array<{ stop: () => void }> = [];
const originalWarn = console.warn;

afterEach(() => {
	console.warn = originalWarn;
	for (const server of servers.splice(0)) {
		server.stop();
	}
});

describe("createDaemonClient", () => {
	it("allows user-prompt-submit sized responses to complete within the prompt timeout", async () => {
		const server = Bun.serve({
			port: 0,
			async fetch() {
				await Bun.sleep(3_000);
				return Response.json({ inject: "turn-memory" });
			},
		});
		servers.push(server);

		const client = createDaemonClient(`http://127.0.0.1:${server.port}`);
		const result = await client.post<{ inject: string }>(
			"/api/hooks/user-prompt-submit",
			{ harness: "pi" },
			PROMPT_SUBMIT_TIMEOUT,
		);

		expect(result).toEqual({ inject: "turn-memory" });
	});

	it("treats daemon timeouts as unavailable without writing to the TUI console", async () => {
		const warnings: string[] = [];
		console.warn = (...args: unknown[]) => {
			warnings.push(args.map(String).join(" "));
		};

		const server = Bun.serve({
			port: 0,
			async fetch() {
				await Bun.sleep(100);
				return Response.json({ inject: "late" });
			},
		});
		servers.push(server);

		const client = createDaemonClient(`http://127.0.0.1:${server.port}`);
		const result = await client.post<{ inject: string }>("/api/hooks/user-prompt-submit", { harness: "pi" }, 10);

		expect(result).toBeNull();
		expect(warnings).toEqual([]);
	});

	it("treats a refused daemon connection as unavailable without logging the error object", async () => {
		const warnings: string[] = [];
		console.warn = (...args: unknown[]) => {
			warnings.push(args.map(String).join(" "));
		};

		const offlineServer = Bun.serve({
			port: 0,
			fetch: () => new Response(),
		});
		const offlinePort = offlineServer.port;
		offlineServer.stop();

		const client = createDaemonClient(`http://127.0.0.1:${offlinePort}`);
		const result = await client.postResult("/api/hooks/notifications", { harness: "pi" }, 100);

		expect(result).toEqual({ ok: false, reason: "offline" });
		expect(warnings).toEqual([]);
	});

	it("treats daemon HTTP failures as unavailable without writing to the TUI console", async () => {
		const warnings: string[] = [];
		console.warn = (...args: unknown[]) => {
			warnings.push(args.map(String).join(" "));
		};

		const server = Bun.serve({
			port: 0,
			fetch: () => new Response("temporarily unavailable", { status: 503 }),
		});
		servers.push(server);

		const client = createDaemonClient(`http://127.0.0.1:${server.port}`);
		const result = await client.postResult("/api/hooks/notifications", { harness: "pi" }, 100);

		expect(result).toEqual({ ok: false, reason: "http", status: 503 });
		expect(warnings).toEqual([]);
	});
});
