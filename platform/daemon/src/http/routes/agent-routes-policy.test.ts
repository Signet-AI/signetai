import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const workspace = join(tmpdir(), `signet-agent-routes-${Date.now()}`);
mkdirSync(join(workspace, "memory"), { recursive: true });
process.env.SIGNET_PATH = workspace;

let closeDb: (() => void) | undefined;
let app: InstanceType<typeof import("hono").Hono>;

beforeAll(async () => {
	await import("../../daemon");
	const { Hono } = await import("hono");
	const db = await import("../../db/owner/accessor");
	db.closeDbAccessor();
	db.initDbAccessor(join(workspace, "memory", "memories.db"));
	closeDb = db.closeDbAccessor;
	const { registerMiscRoutes } = await import("./misc-routes");
	app = new Hono();
	registerMiscRoutes(app);
});

afterAll(() => {
	closeDb?.();
	rmSync(workspace, { recursive: true, force: true });
});

async function request(method: string, path: string, body?: unknown) {
	return app.request(path, {
		method,
		headers: body === undefined ? undefined : { "content-type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
}

describe("agent route memory policy contracts", () => {
	it("POST distinguishes omitted, invalid, and valid policy fields", async () => {
		expect((await request("POST", "/api/agents", { name: "omitted" })).status).toBe(201);
		expect((await request("POST", "/api/agents", { name: "number", read_policy: 123 })).status).toBe(400);
		expect((await request("POST", "/api/agents", { name: "bogus", read_policy: "bogus" })).status).toBe(400);
		expect((await request("POST", "/api/agents", { name: "shared", read_policy: "shared" })).status).toBe(201);
		expect((await request("POST", "/api/agents", { name: "group-no-name", read_policy: "group" })).status).toBe(400);
		expect(
			(await request("POST", "/api/agents", { name: "group", read_policy: "group", policy_group: "team" })).status,
		).toBe(201);
	});

	it("POST of an existing agent is a 409 conflict, not a 500, even when racing", async () => {
		const created = await Promise.all(
			Array.from({ length: 6 }, () => request("POST", "/api/agents", { name: "raced", read_policy: "isolated" })),
		);
		const statuses = created.map((response) => response.status).sort();
		expect(statuses).toEqual([201, 409, 409, 409, 409, 409]);
		expect(await created.find((response) => response.status === 409)?.json()).toEqual({
			error: "Agent raced already exists",
		});
	});

	it("GET returns a structured error for a legacy invalid persisted policy", async () => {
		const { getDbAccessor, runWriteTxAsync } = await import("../../db/owner/accessor");
		await runWriteTxAsync(getDbAccessor(), (db) => {
			db.prepare(
				`INSERT INTO agents (id, name, read_policy, policy_group, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?)`,
			).run("legacy", "legacy", "bogus", null, new Date().toISOString(), new Date().toISOString());
		});
		const response = await request("GET", "/api/agents/legacy");
		expect(response.status).toBe(500);
		expect(await response.json()).toEqual({
			error: "Invalid persisted memory policy: memory must be one of: isolated, shared, group",
		});
	});

	it("PATCH distinguishes omitted, invalid, and valid policy fields", async () => {
		expect((await request("PATCH", "/api/agents/omitted", {})).status).toBe(200);
		expect((await request("PATCH", "/api/agents/omitted", { read_policy: 123 })).status).toBe(400);
		expect((await request("PATCH", "/api/agents/omitted", { read_policy: "bogus" })).status).toBe(400);
		expect((await request("PATCH", "/api/agents/omitted", { read_policy: "shared" })).status).toBe(200);
		expect((await request("PATCH", "/api/agents/omitted", { read_policy: "group" })).status).toBe(400);
		expect((await request("PATCH", "/api/agents/omitted", { read_policy: "group", policy_group: "team" })).status).toBe(
			200,
		);
		expect((await request("PATCH", "/api/agents/omitted", { read_policy: "group", policy_group: "" })).status).toBe(
			400,
		);
		expect(
			(await request("PATCH", "/api/agents/omitted", { read_policy: "group", policy_group: "x".repeat(129) })).status,
		).toBe(400);
		expect((await request("PATCH", "/api/agents/not-found", {})).status).toBe(404);
	});

	it("answers roster routes that queue behind a long owner job", async () => {
		expect((await request("POST", "/api/agents", { name: "queued-patch" })).status).toBe(201);
		expect((await request("POST", "/api/agents", { name: "queued-delete" })).status).toBe(201);
		const { getDbOwner } = await import("../../db/owner/runtime");
		const longJob = (await getDbOwner()).submit(
			{ kind: "sleep", durationMs: 2_500 },
			{ operation: "test.long-owner-job", lane: "write", deadlineMs: 10_000 },
		);
		const responses = await Promise.all([
			request("GET", "/api/agents"),
			request("GET", "/api/agents/queued-patch"),
			request("PATCH", "/api/agents/queued-patch", { read_policy: "shared" }),
			request("DELETE", "/api/agents/queued-delete"),
		]);
		await longJob.result;
		expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 200]);
	});
});
