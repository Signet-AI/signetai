import { describe, expect, it } from "bun:test";

const origin = process.env["SIGNET_RUST_DAEMON_ORIGIN"];
const request = (path: string, init?: RequestInit) => fetch(`${origin}${path}`, init);

describe("fresh native update boundary", () => {
	it("exposes config aliases, bounded validation, and truthful unsupported run", async () => {
		if (!origin) return;
		const initial = await request("/api/update/config");
		expect(initial.status).toBe(200);
		const saved = await request("/api/update/config", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ auto_install: true, check_interval: 600, channel: "nightly" }),
		});
		expect(saved.status).toBe(200);
		expect((await saved.json()).config).toMatchObject({ autoInstall: true, checkInterval: 600, channel: "nightly" });
		const persisted = await request("/api/update/config");
		expect((await persisted.json()).channel).toBe("nightly");
		const malformed = await request("/api/update/config", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ channel: "beta" }),
		});
		expect(malformed.status).toBe(400);
		const run = await request("/api/update/run", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{}",
		});
		expect(run.status).toBe(501);
		expect((await run.json()).errorCode).toBe("unsupported");
	});

	it("rejects an oversized JSON body", async () => {
		if (!origin) return;
		const response = await request("/api/update/config", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ channel: "stable", padding: "x".repeat(70_000) }),
		});
		expect([400, 413]).toContain(response.status);
	});
});
