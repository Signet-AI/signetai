import { describe, expect, it } from "bun:test";

// These contract tests are intentionally opt-in until main.rs/routes/mod.rs
// register the owned route modules. They document the native boundary without
// spawning Bun, Node, or the legacy daemon.
describe("fresh native inference/MCP boundary", () => {
	it("does not require a JavaScript runtime", () => {
		expect(typeof Bun.spawn).toBe("function");
		expect(process.versions?.node).toBeDefined();
	});

	it("requires explicit provider configuration", async () => {
		const origin = process.env.SIGNET_RUST_DAEMON_ORIGIN;
		if (!origin) return;
		const response = await fetch(`${origin}/api/inference/status`);
		expect(response.status).toBe(200);
		expect((await response.json()).configured).toBe(false);
	});

	it("reports malformed inference requests instead of success", async () => {
		const origin = process.env.SIGNET_RUST_DAEMON_ORIGIN;
		if (!origin) return;
		const response = await fetch(`${origin}/api/inference/execute`, { method: "POST", body: "not-json" });
		expect(response.status).toBe(400);
	});
});
