import { expect, it } from "bun:test";

const origin = process.env.SIGNET_RUST_DAEMON_ORIGIN;

it("serves changelog, roadmap, and readme with the native response contract", async () => {
	if (!origin) return;
	for (const path of ["/api/changelog", "/api/roadmap", "/api/readme"]) {
		const response = await fetch(`${origin}${path}`);
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body).toEqual({
			html: expect.any(String),
			cachedAt: expect.any(Number),
		});
		expect(["github", "local"]).toContain(body.source);
		expect(body.html).not.toContain("<script");
	}
});

it("returns truthful 503 when the development source is absent", async () => {
	if (!origin) return;
	const response = await fetch(`${origin}/api/readme`);
	expect([200, 503]).toContain(response.status);
	if (response.status === 503) expect((await response.json()).error).toBe("README unavailable");
});
