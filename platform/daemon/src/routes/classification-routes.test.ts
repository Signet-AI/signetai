import { expect, test } from "bun:test";
import { Hono } from "hono";
import { executeClassification } from "../classification-owner";
import { classificationFixture } from "../test-support/classification-fixture.test";
import { registerClassificationRoutes } from "./classification-routes";

test("HTTP hides definitions, compliance classifies without content access and owners cannot remove", async () => {
	const db = classificationFixture();
	const app = new Hono();
	app.use("*", async (c, next) => {
		const user = c.req.header("x-test-user") ?? "bob";
		c.set("principal", {
			kind: "user",
			userId: user,
			groupIds: [],
			compliance: user === "carol",
			credential: { kind: "session", id: user },
			allowedProjects: null,
		});
		await next();
	});
	registerClassificationRoutes(app, { request: async (request) => executeClassification(db, request) });
	const json = (user: string, body: unknown) => ({
		method: "POST",
		headers: { "content-type": "application/json", "x-test-user": user },
		body: JSON.stringify(body),
	});
	const created = await app.request(
		"/api/classifications",
		json("carol", { name: "HR", audience: [{ kind: "user", id: "alice" }] }),
	);
	expect(created.status).toBe(201);
	const result: unknown = await created.json();
	if (typeof result !== "object" || result === null || !("id" in result) || typeof result.id !== "string")
		throw new Error("invalid creation");
	const id = result.id;
	const hidden = await app.request(`/api/classifications/${id}`);
	const missing = await app.request("/api/classifications/cls_absent");
	expect(hidden.status).toBe(404);
	expect(await hidden.text()).toBe(await missing.text());
	expect(await (await app.request("/api/classifications")).json()).toEqual([]);
	const target = { kind: "memory", id: "m", agentId: "default" };
	expect((await app.request(`/api/classifications/${id}/apply?wait=1`, json("alice", { target }))).status).toBe(202);
	const items = await app.request(`/api/classifications/${id}/items`, { headers: { "x-test-user": "carol" } });
	expect(items.status).toBe(200);
	expect(await items.json()).toEqual({
		items: [{ target_kind: "memory", target_id: "m", agent_id: "default" }],
		nextCursor: null,
	});
	expect((await app.request(`/api/classifications/${id}/remove?wait=1`, json("alice", { target }))).status).toBe(403);
	expect((await app.request(`/api/classifications/${id}/remove?wait=1`, json("carol", { target }))).status).toBe(202);
	db.close();
});
