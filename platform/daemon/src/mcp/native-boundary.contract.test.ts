import { afterAll, beforeAll, describe, expect, it } from "bun:test";

const port = 43981;
const binary = process.env.SIGNET_RUST_DAEMON_BIN ?? "platform/rust-daemon/target/debug/signet-daemon";
let child: Bun.Subprocess;

async function waitForDaemon(): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		try {
			const response = await fetch(`http://127.0.0.1:${port}/health/live`);
			if (response.ok) return;
		} catch {
			// The process needs a short window to bind its listener.
		}
		await Bun.sleep(25);
	}
	throw new Error("native daemon did not become ready");
}

describe("fresh native MCP boundary", () => {
	beforeAll(async () => {
		child = Bun.spawn([binary], {
			env: { ...process.env, SIGNET_PORT: String(port), SIGNET_BIND: "127.0.0.1" },
			stdout: "pipe",
			stderr: "pipe",
		});
		await waitForDaemon();
	});

	afterAll(() => child?.kill("SIGTERM"));

	it("publishes truthful native discovery metadata from the running process", async () => {
		const response = await fetch(`http://127.0.0.1:${port}/api/mcp/capabilities`);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			transport: "streamable-http",
			native: true,
			stdio: { supported: true, provider_execution: false },
			management: { supported: false, reason: "not represented by native Operations" },
			analytics: { supported: false, reason: "not represented by native Operations" },
		});
	});
});
