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
			{ harness: "oh-my-pi" },
			PROMPT_SUBMIT_TIMEOUT,
		);

		expect(result).toEqual({ inject: "turn-memory" });
	});

	it("returns null and logs a concise timeout message when the daemon stalls past the timeout", async () => {
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
		const result = await client.post<{ inject: string }>("/api/hooks/user-prompt-submit", { harness: "oh-my-pi" }, 10);

		expect(result).toBeNull();
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("POST /api/hooks/user-prompt-submit timed out after 10ms");
	});
});
