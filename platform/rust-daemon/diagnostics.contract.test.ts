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

async function request(path: string, auth = key) {
	return fetch(`${base}${path}`, { headers: auth ? { "x-signet-api-key": auth } : {} });
}

beforeAll(async () => {
	child = Bun.spawn([binary], {
		env: { ...process.env, SIGNET_PATH: root, SIGNET_PORT: String(port), SIGNET_API_KEY: key },
		stdout: "ignore",
		stderr: "pipe",
	});
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
	await child.exited;
	await rm(root, { recursive: true, force: true });
});

describe("native database diagnostics", () => {
	test("enforces auth and exposes schema and bounded samples", async () => {
		expect((await request("/api/diagnostics/database/schema", "")).status).toBe(401);
		const schema = await (await request("/api/diagnostics/database/schema")).json();
		expect(schema.complete).toBe(true);
		expect(schema.tables.some((table: { name: string }) => table.name === "memories")).toBe(true);
		const sample = await (await request("/api/diagnostics/database/tables/memories/sample?limit=1&offset=0")).json();
		expect(sample.limit).toBe(1);
		expect(sample.offset).toBe(0);
		expect((await request("/api/diagnostics/database/tables/no_such_table/sample")).status).toBe(404);
		expect((await request("/api/diagnostics/database/tables/sqlite_master/sample")).status).toBe(400);
		expect((await request("/api/diagnostics/database/tables/memories/sample?limit=101")).status).toBe(400);
	});

	test("persists across restart", async () => {
		const before = await (await request("/api/diagnostics/database/schema")).json();
		child.kill("SIGTERM");
		await child.exited;
		child = Bun.spawn([binary], {
			env: { ...process.env, SIGNET_PATH: root, SIGNET_PORT: String(port), SIGNET_API_KEY: key },
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
