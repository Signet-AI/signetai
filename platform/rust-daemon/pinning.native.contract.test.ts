import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = process.cwd();
// biome-ignore lint/suspicious/noUndeclaredEnvVars: test-only binary override
const binary = process.env.SIGNET_RUST_DAEMON_BIN ?? join(root, "platform/rust-daemon/target/debug/signet-daemon");
const children: Bun.Subprocess[] = [];
const workspaces: string[] = [];
async function startDaemon() {
	const workspace = mkdtempSync(join(tmpdir(), "signet-pinning-"));
	workspaces.push(workspace);
	const reservation = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {}, open() {}, close() {} } });
	const port = reservation.port;
	reservation.stop();
	const stdout = Bun.file(join(workspace, "stdout.log"));
	const stderr = Bun.file(join(workspace, "stderr.log"));
	const child = Bun.spawn([binary], {
		cwd: root,
		env: {
			...process.env,
			SIGNET_PATH: workspace,
			SIGNET_BIND: "127.0.0.1",
			SIGNET_MODE: "local",
			SIGNET_PORT: String(port),
			SIGNET_AGENT_ID: "pin-owner",
			SIGNET_API_KEY: "pin-test-key",
			SIGNET_TOKEN: "",
		},
		stdout,
		stderr,
	});
	children.push(child);
	const origin = `http://127.0.0.1:${port}`;
	for (let i = 0; i < 240; i++) {
		try {
			if ((await fetch(`${origin}/health/ready`)).ok) return { child, origin, workspace, stderr };
		} catch {}
		await Bun.sleep(25);
	}
	throw new Error(`readiness timeout stderr=${await stderr.text()}`);
}
async function stop(child: Bun.Subprocess) {
	child.kill("SIGTERM");
	await Promise.race([child.exited, Bun.sleep(1000)]);
	if (!child.killed) child.kill("SIGKILL");
	await child.exited;
}
afterEach(async () => {
	for (const child of children.splice(0)) await stop(child);
	for (const workspace of workspaces.splice(0)) rmSync(workspace, { recursive: true, force: true });
});

test("fresh daemon pin HTTP contract enforces modify auth and durable scope", async () => {
	const daemon = await startDaemon();
	const scope = { "x-signet-agent": "pin-owner", "x-workspace-id": "pin-workspace" };
	const create = await fetch(`${daemon.origin}/api/knowledge/entities`, {
		method: "POST",
		headers: { ...scope, "x-signet-api-key": "pin-test-key", "content-type": "application/json" },
		body: JSON.stringify({ name: "Pinned contract", type: "note" }),
	});
	expect(create.status).toBe(201);
	const entity = (await create.json()).id;
	const unauth = await fetch(`${daemon.origin}/api/knowledge/entities/${entity}/pin`, {
		method: "POST",
		headers: scope,
	});
	expect(unauth.status).toBe(401);
	expect(
		(
			await fetch(`${daemon.origin}/api/knowledge/entities/pinned?agent_id=pin-owner&workspace_id=pin-workspace`, {
				headers: { ...scope, "x-signet-api-key": "pin-test-key" },
			})
		).status,
	).toBe(200);
	const auth = { ...scope, "x-signet-api-key": "pin-test-key" };
	expect(
		(await fetch(`${daemon.origin}/api/knowledge/entities/${entity}/pin`, { method: "POST", headers: auth })).status,
	).toBe(200);
	const pinned = await (
		await fetch(`${daemon.origin}/api/knowledge/entities/pinned?agent_id=pin-owner&workspace_id=pin-workspace`, {
			headers: { ...scope, "x-signet-api-key": "pin-test-key" },
		})
	).json();
	expect(pinned.map((x: { id: string }) => x.id)).toContain(entity);
	expect(
		(
			await fetch(`${daemon.origin}/api/knowledge/entities/${entity}/pin?agent_id=other&workspace_id=pin-workspace`, {
				method: "DELETE",
				headers: auth,
			})
		).status,
	).toBe(400);
	expect(
		(await fetch(`${daemon.origin}/api/knowledge/entities/${entity}/pin`, { method: "DELETE", headers: auth })).status,
	).toBe(200);
	expect(
		(await fetch(`${daemon.origin}/api/knowledge/entities/${entity}/pin`, { method: "DELETE", headers: auth })).status,
	).toBe(200);
	const after = await (
		await fetch(`${daemon.origin}/api/knowledge/entities/pinned?agent_id=pin-owner&workspace_id=pin-workspace`, {
			headers: { ...scope, "x-signet-api-key": "pin-test-key" },
		})
	).json();
	expect(after.map((x: { id: string }) => x.id)).not.toContain(entity);
	expect(await daemon.stderr.text()).not.toContain("panic");
});
