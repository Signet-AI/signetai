import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
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
	const daemon = await start(dir);
	const a = headers("dep-agent", "dep-workspace");
	const make = async (name: string) =>
		json(
			await fetch(`${daemon.origin}/api/knowledge/entities`, {
				method: "POST",
				headers: a,
				body: JSON.stringify({ name, type: "person", metadata: {} }),
			}),
		) as { id: string };
	const source = await make("source");
	const target = await make("target");
	const created = await fetch(`${daemon.origin}/api/knowledge/relations`, {
		method: "POST",
		headers: a,
		body: JSON.stringify({
			from_id: source.id,
			to_id: target.id,
			relation: "depends_on",
			metadata: { reason: "contract" },
		}),
	});
	expect(created.status).toBe(201);
	const outgoing = await fetch(
		`${daemon.origin}/api/knowledge/entities/${source.id}/dependencies?direction=outgoing&limit=999`,
		{ headers: a },
	);
	expect(outgoing.status).toBe(200);
	expect(await json(outgoing)).toMatchObject({
		items: [
			{
				direction: "outgoing",
				sourceEntityId: source.id,
				targetEntityId: target.id,
				sourceEntityName: "source",
				targetEntityName: "target",
				dependencyType: "depends_on",
			},
		],
		limit: 200,
	});
	const incoming = (await json(
		await fetch(`${daemon.origin}/api/knowledge/entities/${target.id}/dependencies?direction=incoming`, { headers: a }),
	)) as { items: unknown[] };
	expect(incoming.items).toHaveLength(1);
	expect(
		(
			await fetch(`${daemon.origin}/api/knowledge/entities/${source.id}/dependencies?direction=sideways`, {
				headers: a,
			})
		).status,
	).toBe(400);
	expect(
		(
			await fetch(`${daemon.origin}/api/knowledge/entities/${source.id}/dependencies`, {
				headers: { ...a, "x-signet-workspace-id": "other" },
			})
		).status,
	).toBe(400);
	expect((await fetch(`${daemon.origin}/api/knowledge/entities/not-found/dependencies`, { headers: a })).status).toBe(
		404,
	);
});
