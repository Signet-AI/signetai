import { describe, expect, it } from "bun:test";

// biome-ignore lint/suspicious/noUndeclaredEnvVars: injected by native contract runner
const origin = process.env.SIGNET_RUST_DAEMON_ORIGIN;
const request = (path: string, init?: RequestInit) => fetch(`${origin}${path}`, init);

describe("fresh native update boundary", () => {
	it("exposes config aliases, bounded validation, and truthful unsupported run", async () => {
		if (!origin) return;
		const initial = await request("/api/update/config");
		expect(initial.status).toBe(200);
		const initialBody = await initial.json();
		expect(initialBody).toMatchObject({ checkInterval: 21600, minInterval: 300, maxInterval: 604800 });
		const saved = await request("/api/update/config", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ auto_install: true, check_interval: 600, channel: "nightly" }),
		});
		expect(saved.status).toBe(200);
		expect((await saved.json()).config).toMatchObject({ autoInstall: true, checkInterval: 600, channel: "nightly" });
		const persisted = await request("/api/update/config");
		expect((await persisted.json()).channel).toBe("nightly");
		for (const [channel, canonical] of [
			["latest", "stable"],
			["next", "nightly"],
		] as const) {
			const alias = await request("/api/update/config", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ channel }),
			});
			expect(alias.status).toBe(200);
			expect((await alias.json()).config.channel).toBe(canonical);
		}
		for (const checkInterval of [299, 604801, "not-a-number"]) {
			const bounded = await request("/api/update/config", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ checkInterval }),
			});
			expect(bounded.status).toBe(400);
		}
		const malformed = await request("/api/update/config", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ channel: "beta" }),
		});
		expect(malformed.status).toBe(400);
		const invalidJson = await request("/api/update/config", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{",
		});
		expect([400, 422]).toContain(invalidJson.status);
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
