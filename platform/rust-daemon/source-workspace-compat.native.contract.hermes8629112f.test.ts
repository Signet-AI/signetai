import { afterEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const binary =
	process.env.SIGNET_RUST_DAEMON_BIN ?? join(process.cwd(), "platform/rust-daemon/target/debug/signet-daemon");
const children: Array<{ kill: (signal?: number | NodeJS.Signals) => void; exited: Promise<number> }> = [];
let port = 39_700;

async function start() {
	const workspace = mkdtempSync(join(tmpdir(), "signet-source-workspace-"));
	const child = Bun.spawn([binary], {
		cwd: process.cwd(),
		env: { ...process.env, SIGNET_PATH: workspace, SIGNET_BIND: "127.0.0.1", SIGNET_PORT: String(port++) },
		stdout: "ignore",
		stderr: "pipe",
	}) as unknown as (typeof children)[number];
	children.push(child);
	const origin = `http://127.0.0.1:${port - 1}`;
	for (let i = 0; i < 200; i++) {
		try {
			if ((await fetch(`${origin}/health/ready`)).ok) return { origin, workspace };
		} catch {}
		await Bun.sleep(25);
	}
	throw new Error("daemon did not become ready");
}

afterEach(async () => {
	for (const child of children.splice(0)) {
		child.kill("SIGTERM");
		await Promise.race([child.exited, Bun.sleep(1_000).then(() => -1)]);
	}
});

it("creates and lists a source in the canonical default workspace when scope is omitted", async () => {
	const daemon = await start();
	const headers = { "content-type": "application/json", "x-signet-agent": "compat-agent" };
	const created = await fetch(`${daemon.origin}/api/sources`, {
		method: "POST",
		headers,
		body: JSON.stringify({ kind: "file", name: "compat-source", config: {} }),
	});
	expect(created.status).toBe(201);
	const source = (await created.json()) as { id: string };
	const listed = await fetch(`${daemon.origin}/api/sources`, { headers: { "x-signet-agent": "compat-agent" } });
	expect(listed.status).toBe(200);
	expect((await listed.json()).sources).toContainEqual(
		expect.objectContaining({ id: source.id, workspace_id: "default" }),
	);
	rmSync(daemon.workspace, { recursive: true, force: true });
});

it("rejects conflicting explicit source workspace identities", async () => {
	const daemon = await start();
	const response = await fetch(`${daemon.origin}/api/sources`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-signet-agent": "compat-agent",
			"x-signet-workspace-id": "one",
			"x-workspace-id": "two",
		},
		body: JSON.stringify({ kind: "file", name: "conflict", config: {} }),
	});
	expect(response.status).toBe(400);
});
