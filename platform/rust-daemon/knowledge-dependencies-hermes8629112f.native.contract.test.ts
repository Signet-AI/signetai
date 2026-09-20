import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = process.cwd();
// biome-ignore lint/suspicious/noUndeclaredEnvVars: test-only binary override
const bin =
	process.env.SIGNET_RUST_DAEMON_BIN ?? "/mnt/work/hermes-scratch/migration-index-gates-917/debug/signet-daemon";
const children: Bun.Subprocess[] = [];
const dirs: string[] = [];
async function start(path: string) {
	const port = 41000 + Math.floor(Math.random() * 1000);
	const child = Bun.spawn([bin], {
		cwd: root,
		env: { ...process.env, SIGNET_PATH: path, SIGNET_BIND: "127.0.0.1", SIGNET_PORT: String(port) },
		stdout: "ignore",
		stderr: "pipe",
	});
	children.push(child);
	const origin = `http://127.0.0.1:${port}`;
	for (let i = 0; i < 240; i++) {
		try {
			if ((await fetch(`${origin}/health/ready`)).ok) return { child, origin };
		} catch {}
		await Bun.sleep(25);
	}
	throw new Error(`daemon readiness timeout: ${await new Response(child.stderr).text()}`);
}
const headers = (agent: string, workspace: string) => ({
	"content-type": "application/json",
	"x-signet-agent": agent,
	"x-workspace-id": workspace,
});
async function json(r: Response): Promise<unknown> {
	return r.json();
}
afterEach(async () => {
	for (const child of children.splice(0)) {
		child.kill("SIGTERM");
		await child.exited;
	}
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("dependencies returns detailed scoped directional items with bounded input", async () => {
	const dir = mkdtempSync(join(tmpdir(), "kg-deps-"));
	dirs.push(dir);
	mkdirSync(join(dir, "memory"));
	const seeded = new Database(join(dir, "memory", "memories.db"));
	seeded.exec(`CREATE TABLE entities (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, workspace_id TEXT NOT NULL, name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active');
		CREATE TABLE entity_dependencies (id TEXT PRIMARY KEY, source_entity_id TEXT NOT NULL, target_entity_id TEXT NOT NULL, agent_id TEXT NOT NULL, workspace_id TEXT NOT NULL, dependency_type TEXT NOT NULL, strength REAL NOT NULL, aspect_id TEXT, reason TEXT, status TEXT NOT NULL DEFAULT 'active', updated_at TEXT NOT NULL);
		INSERT INTO entities VALUES ('seed-source', 'dep-agent', 'dep-workspace', 'seed source', 'active'), ('seed-target', 'dep-agent', 'dep-workspace', 'seed target', 'active');
		INSERT INTO entity_dependencies VALUES ('seed-dep', 'seed-source', 'seed-target', 'dep-agent', 'dep-workspace', 'blocks', 0.91, 'seed-aspect', 'seed-reason', 'active', '2026-01-01T00:00:00Z');`);
	seeded.close();
	const daemon = await start(dir);
	const a = headers("dep-agent", "dep-workspace");
	const seededResponse = await fetch(
		`${daemon.origin}/api/knowledge/entities/seed-source/dependencies?direction=outgoing`,
		{ headers: a },
	);
	expect(seededResponse.status).toBe(200);
	expect(await json(seededResponse)).toMatchObject({
		items: [
			{
				id: "seed-dep",
				dependencyType: "blocks",
				strength: 0.91,
				aspectId: "seed-aspect",
				reason: "seed-reason",
				status: "active",
			},
		],
	});
	const outgoing = await fetch(
		`${daemon.origin}/api/knowledge/entities/seed-source/dependencies?direction=outgoing&limit=999`,
		{ headers: a },
	);
	expect(outgoing.status).toBe(200);
	expect(await json(outgoing)).toMatchObject({
		items: [
			{
				id: "seed-dep",
				direction: "outgoing",
				sourceEntityId: "seed-source",
				targetEntityId: "seed-target",
				sourceEntityName: "seed source",
				targetEntityName: "seed target",
				dependencyType: "blocks",
				strength: 0.91,
				aspectId: "seed-aspect",
				reason: "seed-reason",
				status: "active",
			},
		],
		limit: 200,
	});
	const incoming = (await json(
		await fetch(`${daemon.origin}/api/knowledge/entities/seed-target/dependencies?direction=incoming`, { headers: a }),
	)) as { items: unknown[] };
	expect(incoming.items).toHaveLength(1);
	expect(
		(
			await fetch(`${daemon.origin}/api/knowledge/entities/seed-source/dependencies?direction=sideways`, {
				headers: a,
			})
		).status,
	).toBe(200);
	expect(
		(
			await fetch(`${daemon.origin}/api/knowledge/entities/seed-source/dependencies`, {
				headers: { ...a, "x-signet-workspace-id": "other" },
			})
		).status,
	).toBe(400);
	expect((await fetch(`${daemon.origin}/api/knowledge/entities/not-found/dependencies`, { headers: a })).status).toBe(
		404,
	);
});
