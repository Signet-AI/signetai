import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compartmentFor } from "@signet/core";
import { Hono } from "hono";
import type { Principal } from "../auth/principal";

const previousSignetPath = process.env.SIGNET_PATH;
const NOW = "2026-11-20T10:00:00.000Z";
let agentsDir = "";
let db: typeof import("../db-accessor");
let routes: typeof import("./memory-routes");
let principals: typeof import("../auth/principal");
let state: typeof import("./state.js");

function legacyReader(): Principal {
	return principals.legacyPrincipal({
		sub: "classified-scope-reader",
		role: "admin",
		scope: {},
		iat: 0,
		exp: Number.MAX_SAFE_INTEGER,
	});
}

function app(principal: Principal): Hono {
	const hono = new Hono();
	hono.use("*", async (c, next) => {
		c.set("principal", principal);
		await next();
	});
	routes.registerMemoryRoutes(hono, { fetchEmbedding: async () => null });
	return hono;
}

async function ids(hono: Hono, path: string): Promise<{ readonly status: number; readonly ids: string[] }> {
	const res = await hono.request(`http://localhost${path}`);
	const body: unknown = await res.json();
	const rows =
		typeof body === "object" && body !== null
			? (Object.getOwnPropertyDescriptor(body, "results")?.value ??
				Object.getOwnPropertyDescriptor(body, "memories")?.value)
			: undefined;
	const found = Array.isArray(rows)
		? rows.flatMap((row: unknown) => {
				const id = typeof row === "object" && row !== null ? Object.getOwnPropertyDescriptor(row, "id")?.value : null;
				return typeof id === "string" ? [id] : [];
			})
		: [];
	return { status: res.status, ids: found.sort() };
}

beforeAll(async () => {
	agentsDir = mkdtempSync(join(tmpdir(), "signet-memory-classified-scope-"));
	mkdirSync(join(agentsDir, "memory"), { recursive: true });
	writeFileSync(join(agentsDir, "agent.yaml"), "embedding:\n  provider: none\nauth:\n  mode: local\n");
	process.env.SIGNET_PATH = agentsDir;
	db = await import("../db-accessor");
	routes = await import("./memory-routes");
	principals = await import("../auth/principal");
	state = await import("./state.js");
	state.reloadAuthState(agentsDir);
	db.initDbAccessor(join(agentsDir, "memory", "memories.db"));
	db.getDbAccessor().withWriteTx((write) => {
		write
			.prepare("INSERT INTO classifications (id, name, created_at, updated_at) VALUES ('cls_hr', 'HR', ?, ?)")
			.run(NOW, NOW);
		const compartment = compartmentFor(write, ["cls_hr"]);
		if (compartment === null) throw new Error("compartment missing");
		const insert = write.prepare(
			`INSERT INTO memories (id, type, content, importance, created_at, updated_at, updated_by, agent_id, visibility, compartment_id)
			 VALUES (?, 'fact', ?, 0.9, ?, ?, 'test', 'default', 'global', ?)`,
		);
		insert.run("public-note", "quarterly planning notes for the atlas team", NOW, NOW, null);
		insert.run("hr-note", "quarterly planning compensation award for the atlas team", NOW, NOW, compartment);
	});
});

afterAll(async () => {
	await db.closeDbAccessor();
	if (previousSignetPath === undefined) Reflect.deleteProperty(process.env, "SIGNET_PATH");
	else process.env.SIGNET_PATH = previousSignetPath;
	rmSync(agentsDir, { recursive: true, force: true });
});

describe("memory read routes resolve the caller's classification scope", () => {
	it("a credential outside every audience cannot find a classified memory through search", async () => {
		const hono = app(legacyReader());
		const own = await ids(hono, "/memory/search?q=quarterly&agentId=default");
		expect(own.status).toBe(200);
		expect(own.ids).toEqual(["public-note"]);
		const everyAgent = await ids(hono, "/memory/search?q=quarterly&agentId=all");
		expect(everyAgent.status).toBe(200);
		expect(everyAgent.ids).toEqual(["public-note"]);
	});

	it("a credential outside every audience cannot list or open a classified memory", async () => {
		const hono = app(legacyReader());
		expect((await ids(hono, "/api/memories?agentId=default")).ids).toEqual(["public-note"]);
		expect((await ids(hono, "/api/memories?agentId=all")).ids).toEqual(["public-note"]);
		const opened = await hono.request("http://localhost/api/memory/hr-note?agentId=default");
		expect(opened.status).toBe(404);
	});

	it("the local operator still reads every compartment", async () => {
		const hono = app(principals.localPrincipal());
		expect((await ids(hono, "/api/memories?agentId=default")).ids).toEqual(["hr-note", "public-note"]);
		expect((await ids(hono, "/api/memories?agentId=all")).ids).toEqual(["hr-note", "public-note"]);
		expect((await hono.request("http://localhost/api/memory/hr-note?agentId=default")).status).toBe(200);
	});
});
