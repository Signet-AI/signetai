import { expect, test } from "bun:test";
import { Hono } from "hono";
import { observeRequestOwnerJob, ownerRequestProfiling } from "./db-request-profile";

function app(enabled = true) {
	const app = new Hono();
	app.use("*", ownerRequestProfiling(enabled));
	app.get("/:kind", async (c) => {
		const metrics = Promise.resolve({ startedAt: 12, finishedAt: 15 });
		observeRequestOwnerJob(
			{
				kind: "query",
				statement: { sql: "SELECT * FROM users WHERE id=?", params: ["private-secret"], result: "get", readonly: true },
			},
			"read",
			c.req.param("kind"),
			10,
			metrics,
		);
		await metrics;
		if (c.req.param("kind") === "denied") return c.json({ error: "missing" }, 404);
		await Bun.sleep(c.req.param("kind") === "slow" ? 5 : 0);
		return c.json({ ok: true });
	});
	return app;
}

test("owner profiling isolates concurrent requests and excludes parameters", async () => {
	const server = app();
	const responses = await Promise.all([
		server.request("http://localhost/slow"),
		server.request("http://localhost/fast"),
	]);
	for (const [index, response] of responses.entries()) {
		const header = response.headers.get("x-signet-owner-profile");
		expect(header).not.toBeNull();
		expect(header).not.toContain("private-secret");
		const data: unknown = JSON.parse(header ?? "null");
		expect(data).toEqual([
			{
				kind: "query",
				lane: "read",
				operation: index === 0 ? "slow" : "fast",
				tables: ["users"],
				count: 1,
				measured: 1,
				busyMs: 3,
				queueMs: 2,
			},
		]);
	}
});

test("owner profiling is opt-in and suppresses identity-denial details", async () => {
	expect((await app(false).request("http://localhost/fast")).headers.has("x-signet-owner-profile")).toBe(false);
	expect((await app().request("http://localhost/denied")).headers.has("x-signet-owner-profile")).toBe(false);
});
