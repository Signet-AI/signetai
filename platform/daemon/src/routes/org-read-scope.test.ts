import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compartmentFor } from "@signet/core";
import { Hono } from "hono";
import { bindPrincipalAccess } from "../auth/agent-access";
import { readOrganization } from "../auth/organization-store";
import { localPrincipal, rolePermissions } from "../auth/principal";
import { initDbAccessor, closeDbAccessor, getDbAccessor } from "../db-accessor";
import { closeRegisteredDbOwnerMaintenance } from "../db-owner-maintenance";
import { registerMemoryRoutes } from "./memory-routes";

const previousPath = process.env.SIGNET_PATH;
const directory = mkdtempSync(join(tmpdir(), "org-read-routes-"));
const at = "2026-11-25T00:00:00.000Z";
let app: Hono;
let compartment: number | null;

beforeAll(async () => {
	process.env.SIGNET_PATH = directory;
	mkdirSync(join(directory, "memory"));
	writeFileSync(join(directory, "agent.yaml"), "embedding:\n  provider: none\nauth:\n  mode: local\n");
	const state = await import("./state");
	state.reloadAuthState(directory);
	initDbAccessor(join(directory, "memory", "memories.db"));
	getDbAccessor().withWriteTx((db) => {
		for (const id of ["default", "alpha", "beta"])
			db.prepare("INSERT OR IGNORE INTO agents (id,name,created_at,updated_at) VALUES (?,?,?,?)").run(id, id, at, at);
		db.prepare("UPDATE agents SET kind='organization' WHERE id='default'").run();
		db.prepare("UPDATE agents SET kind='personal',owner_user_id='alice' WHERE id='alpha'").run();
		db.prepare("UPDATE agents SET kind='personal',owner_user_id='bob' WHERE id='beta'").run();
		db.prepare("INSERT INTO classifications(id,name,created_at,updated_at) VALUES ('cls_hr','HR',?,?)").run(at, at);
		db.prepare("INSERT INTO classification_audience VALUES ('cls_hr','user','carol')").run();
		compartment = compartmentFor(db, ["cls_hr"]);
	});
	const org = await readOrganization();
	app = new Hono();
	app.use("*", async (c, next) => {
		const principal = {
			...localPrincipal(),
			kind: "user" as const,
			userId: c.req.header("x-test-user") ?? "alice",
			role: "member" as const,
			permissions: rolePermissions("member"),
		};
		bindPrincipalAccess(principal, {
			agentModel: "personal",
			personalAgentsSelfService: true,
			organizationAgentId: "default",
			personalAgentId: "alpha",
			defaultReadAgentId: null,
			agents: [
				{ id: "default", kind: "organization", owner_user_id: null, owner_group_id: null, archived_at: null },
				{ id: "alpha", kind: "personal", owner_user_id: "alice", owner_group_id: null, archived_at: null },
				{ id: "beta", kind: "personal", owner_user_id: "bob", owner_group_id: null, archived_at: null },
			],
		});
		c.set("principal", principal);
		c.set("organization", org);
		await next();
	});
	registerMemoryRoutes(app, { fetchEmbedding: async () => null });
	seed("visible", null);
});

afterAll(async () => {
	await closeRegisteredDbOwnerMaintenance();
	await closeDbAccessor();
	if (previousPath === undefined) Reflect.deleteProperty(process.env, "SIGNET_PATH");
	else process.env.SIGNET_PATH = previousPath;
	rmSync(directory, { recursive: true, force: true });
});

function seed(id: string, label: number | null): void {
	getDbAccessor().withWriteTx((db) =>
		db
			.prepare(
				"INSERT INTO memories(id,type,content,created_at,updated_at,updated_by,agent_id,visibility,author_user_id,compartment_id) VALUES (?,'fact',?,?,?,'fixture','beta','private','bob',?)",
			)
			.run(id, `atlas reading ${id}`, at, at, label),
	);
}
async function request(path: string, user = "alice") {
	const response = await app.request(`http://localhost${path}`, { headers: { "x-test-user": user } });
	return { status: response.status, headers: [...response.headers], body: await response.text() };
}

describe("organization memory read routes", () => {
	test("organization and another personal agent read org-visible private content with authorship", async () => {
		for (const query of ["", "?agentId=beta"]) {
			const reply = await request(`/api/memory/visible${query}`);
			expect(reply.status).toBe(200);
			expect(JSON.parse(reply.body)).toMatchObject({ id: "visible", authorUserId: "bob" });
		}
	});

	test("hidden inserts and updates do not change memory lists, FTS scores, facets, or missing replies", async () => {
		const paths = [
			"/api/memories?limit=1",
			"/memory/search?q=atlas",
			"/memory/search?distinct=who",
			"/api/memory/hidden",
			"/api/memory/hidden/history",
		];
		const before = await Promise.all(paths.map((path) => request(path)));
		seed("hidden", compartment);
		const after = await Promise.all(paths.map((path) => request(path)));
		expect(after).toEqual(before);
		getDbAccessor().withWriteTx((db) =>
			db.prepare("UPDATE memories SET content='atlas atlas reading confidential',importance=1 WHERE id='hidden'").run(),
		);
		expect(await Promise.all(paths.map((path) => request(path)))).toEqual(before);
		const positive = await request("/memory/search?q=atlas", "carol");
		expect(positive.status).toBe(200);
		expect(
			JSON.parse(positive.body)
				.results.map((row: { id: string }) => row.id)
				.sort(),
		).toEqual(["hidden", "visible"]);
	});

	test("per-user NDJSON export is self or admin and intersects caller visibility", async () => {
		expect((await request("/api/org/export?author=bob")).status).toBe(403);
		const self = await request("/api/org/export?author=alice");
		expect(self.status).toBe(200);
		expect(self.body).toBe("");
	});
});
