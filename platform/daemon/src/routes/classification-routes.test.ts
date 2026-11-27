import { expect, test } from "bun:test";
import { Hono } from "hono";
import { executeClassification } from "../classification-owner";
import { currentClassificationFixture } from "../test-support/classification-fixture.test";
import { registerClassificationRoutes } from "./classification-routes";

function routeFixture(eager = false) {
	const db = currentClassificationFixture();
	const app = new Hono();
	app.use("*", async (c, next) => {
		const user = c.req.header("x-test-user") ?? "bob";
		c.set("principal", {
			kind: "user",
			userId: user,
			groupIds: [],
			compliance: user === "carol",
			permissions: new Set(c.req.header("x-test-classify") === "0" ? [] : user === "carol" ? ["classify"] : []),
			credential: { kind: "session", id: user },
			allowedProjects: null,
			boundAgentId: null,
		});
		await next();
	});
	registerClassificationRoutes(app, {
		request: async (request) => {
			const result = executeClassification(db, request);
			if (
				eager &&
				request.op === "enqueue" &&
				typeof result === "object" &&
				result !== null &&
				"jobId" in result &&
				typeof result.jobId === "string"
			)
				executeClassification(db, { op: "execute", jobId: result.jobId });
			return result;
		},
	});
	const json = (user: string, body: unknown, canClassify = true) => ({
		method: "POST",
		headers: { "content-type": "application/json", "x-test-user": user, "x-test-classify": canClassify ? "1" : "0" },
		body: JSON.stringify(body),
	});
	return { db, app, json };
}
test("HTTP hides definitions, compliance classifies without content access and owners cannot remove", async () => {
	const { db, app, json } = routeFixture();
	const deniedCreation = json("carol", { name: "Blocked", audience: [] }, false);
	expect((await app.request("/api/classifications", deniedCreation)).status).toBe(403);
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
	const deniedApply = json("carol", { target }, false);
	expect((await app.request(`/api/classifications/${id}/apply?wait=1`, deniedApply)).status).toBe(403);
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

for (const op of ["apply", "remove", "preview"])
	test(`HTTP ${op} hides unaudienced definitions with the nonexistent response`, async () => {
		const { db, app, json } = routeFixture();
		db.exec(
			"INSERT INTO classifications(id,name) VALUES('cls_hr','HR');INSERT INTO classification_audience VALUES('cls_hr','user','alice')",
		);
		const body = { target: { kind: "memory", id: "m", agentId: "default" } };
		const hidden = await app.request(`/api/classifications/cls_hr/${op}?wait=1`, json("bob", body)),
			missing = await app.request(`/api/classifications/cls_absent/${op}?wait=1`, json("bob", body));
		expect(hidden.status).toBe(404);
		expect(await hidden.text()).toBe(await missing.text());
		db.close();
	});
test("HTTP duplicate names and malformed cursors are client errors", async () => {
	const { db, app, json } = routeFixture();
	const body = { name: "HR", audience: [] };
	expect((await app.request("/api/classifications", json("carol", body))).status).toBe(201);
	expect((await app.request("/api/classifications", json("carol", body))).status).toBe(409);
	const row = db.prepare("SELECT id FROM classifications WHERE name='HR'").get();
	if (typeof row?.id !== "string") throw new Error("missing classification");
	expect(
		(await app.request(`/api/classifications/${row.id}/items?cursor=%7B`, { headers: { "x-test-user": "carol" } }))
			.status,
	).toBe(400);
	db.close();
});
test("HTTP maps an already completed execution to conflict rather than a server error", async () => {
	const { db, app, json } = routeFixture(true);
	db.exec("INSERT INTO classifications(id,name) VALUES('cls_hr','HR')");
	expect(
		(
			await app.request(
				"/api/classifications/cls_hr/apply?wait=1",
				json("carol", { target: { kind: "memory", id: "m", agentId: "default" } }),
			)
		).status,
	).toBe(409);
	expect(db.prepare("SELECT status FROM org_jobs").get()).toEqual({ status: "complete" });
	db.close();
});
