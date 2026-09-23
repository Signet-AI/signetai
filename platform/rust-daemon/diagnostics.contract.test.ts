/* biome-ignore-all lint/suspicious/noExplicitAny: dynamic JSON contract payloads */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const port = 39000 + Math.floor(Math.random() * 1000);
const key = `contract-${crypto.randomUUID()}`;
const root = await mkdtemp(join(tmpdir(), "signet-diagnostics-"));
const binary = join(import.meta.dir, "target/debug/signet-daemon");
let child: ReturnType<typeof Bun.spawn>;
const base = `http://127.0.0.1:${port}`;
const stderr: string[] = [];

async function request(path: string, auth = key, agent = "") {
	return fetch(`${base}${path}`, {
		headers: auth ? { authorization: `Bearer ${auth}`, ...(agent ? { "x-signet-agent": agent } : {}) } : {},
	});
}
async function jsonRequest(path: string, init: RequestInit, auth = key, agent = "agent-a") {
	const response = await fetch(`${base}${path}`, {
		...init,
		headers: {
			authorization: `Bearer ${auth}`,
			"x-signet-agent": agent,
			"content-type": "application/json",
			...(init.headers ?? {}),
		},
	});
	const text = await response.text();
	let body: any = {};
	try {
		body = JSON.parse(text);
	} catch {}
	return { response, body, text };
}

beforeAll(async () => {
	child = Bun.spawn([binary], {
		env: { ...process.env, SIGNET_TOKEN: undefined, SIGNET_PATH: root, SIGNET_PORT: String(port), SIGNET_API_KEY: key },
		stdout: "ignore",
		stderr: "pipe",
	});
	void (async () => {
		const reader = child.stderr.getReader();
		const decoder = new TextDecoder();
		while (true) {
			const next = await reader.read();
			if (next.done) break;
			stderr.push(decoder.decode(next.value));
		}
	})();
	for (let i = 0; i < 100; i++) {
		try {
			if ((await fetch(`${base}/health/live`)).ok) return;
		} catch {}
		await Bun.sleep(50);
	}
	throw new Error("fresh daemon did not become ready");
});
afterAll(async () => {
	child.kill("SIGTERM");
	expect(await child.exited).toBe(0);
	expect(stderr.join("")).not.toContain(key);
	await expect(fetch(`${base}/health/live`)).rejects.toThrow();
	await rm(root, { recursive: true, force: true });
});

describe("native database diagnostics", () => {
	test("enforces auth and exposes schema and bounded samples", async () => {
		expect((await request("/api/diagnostics/database/schema", "")).status).toBe(401);
		const schema = await (await request("/api/diagnostics/database/schema")).json();
		expect(schema.complete).toBe(true);
		expect(schema.tables.some((table: { name: string }) => table.name === "memories")).toBe(true);
		const memories = schema.tables.find((table: { name: string }) => table.name === "memories");
		expect(memories.indexes.length).toBeGreaterThan(0);
		expect(
			schema.tables.every(
				(table: { name: string }, i: number, all: { name: string }[]) =>
					i === 0 || all[i - 1].name.localeCompare(table.name) <= 0,
			),
		).toBe(true);
		const sample = await (await request("/api/diagnostics/database/tables/memories/sample?limit=1&offset=0")).json();
		expect(sample.limit).toBe(1);
		expect(sample.offset).toBe(0);
		expect(sample.scope).toEqual({ agent: false, workspace: false, isolated: false });
		expect((await request("/api/diagnostics/database/tables/schema_migrations/sample")).status).toBe(200);
		expect((await request("/api/diagnostics/database/tables/no_such_table/sample")).status).toBe(404);
		expect((await request("/api/diagnostics/database/tables/sqlite_master/sample")).status).toBe(400);
		expect((await request("/api/diagnostics/database/tables/memories/sample?limit=101")).status).toBe(400);
	});

	test("keeps native scoped samples private", async () => {
		const createKey = async (agent: string, workspace: string, permissions: string[]) => {
			const result = await jsonRequest(
				"/api/auth/api-keys",
				{
					method: "POST",
					body: JSON.stringify({
						name: `diag-${agent}-${workspace}`,
						role: "operator",
						scope: { agent, workspace },
						permissions,
					}),
				},
				key,
				agent,
			);
			expect(result.response.status).toBe(201);
			return result.body.apiKey.key as string;
		};
		const createEntity = async (agent: string, workspace: string, name: string) => {
			const result = await jsonRequest(
				`/api/knowledge/entities?workspace_id=${workspace}`,
				{ method: "POST", body: JSON.stringify({ name, type: "contract", metadata: { marker: name } }) },
				key,
				agent,
			);
			expect(result.response.status).toBe(201);
		};
		await createEntity("agent-a", "workspace-a", "private-a");
		await createEntity("agent-b", "workspace-b", "private-b");
		const scopedA = await createKey("agent-a", "workspace-a", ["diagnostics"]);
		const scopedB = await createKey("agent-b", "workspace-b", ["diagnostics"]);
		const denied = await createKey("agent-a", "workspace-a", []);
		const a = await jsonRequest(
			"/api/diagnostics/database/tables/kg_entities/sample?limit=25&offset=0",
			{},
			scopedA,
			"agent-a",
		);
		const b = await jsonRequest(
			"/api/diagnostics/database/tables/kg_entities/sample?limit=25&offset=0",
			{},
			scopedB,
			"agent-b",
		);
		expect(a.response.status).toBe(200);
		expect(b.response.status).toBe(200);
		expect(a.body.rows.length).toBeGreaterThan(0);
		expect(b.body.rows.length).toBeGreaterThan(0);
		expect(a.body.rows.every((row: any) => row.agent_id === "agent-a" && row.workspace_id === "workspace-a")).toBe(
			true,
		);
		expect(b.body.rows.every((row: any) => row.agent_id === "agent-b" && row.workspace_id === "workspace-b")).toBe(
			true,
		);
		expect(JSON.stringify(a.body)).not.toContain("private-b");
		expect(JSON.stringify(b.body)).not.toContain("private-a");
		const forbidden = await jsonRequest("/api/diagnostics/database/tables/kg_entities/sample", {}, denied, "agent-a");
		expect(forbidden.response.status).toBe(403);
		expect(forbidden.text).not.toMatch(/private-[ab]|agent-[ab]|workspace-[ab]/);
		const missing = await jsonRequest("/api/diagnostics/database/tables/no_such_table/sample", {}, scopedA, "agent-a");
		expect(missing.response.status).toBe(404);
		expect(missing.text).not.toMatch(/private-[ab]|agent-[ab]|workspace-[ab]/);
	});

	test("persists across restart", async () => {
		const before = await (await request("/api/diagnostics/database/schema")).json();
		child.kill("SIGTERM");
		expect(await child.exited).toBe(0);
		child = Bun.spawn([binary], {
			env: {
				...process.env,
				SIGNET_TOKEN: undefined,
				SIGNET_PATH: root,
				SIGNET_PORT: String(port),
				SIGNET_API_KEY: key,
			},
			stdout: "ignore",
			stderr: "pipe",
		});
		for (let i = 0; i < 100; i++) {
			try {
				if ((await fetch(`${base}/health/live`)).ok) break;
			} catch {}
			await Bun.sleep(50);
		}
		const after = await (await request("/api/diagnostics/database/schema")).json();
		expect(after.tables.map((t: { name: string }) => t.name)).toEqual(
			before.tables.map((t: { name: string }) => t.name),
		);
	});
});
