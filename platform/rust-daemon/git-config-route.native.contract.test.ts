import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "../..");
const configuredBinary = Reflect.get(process.env, "SIGNET_RUST_DAEMON_BIN");
const binary =
	(typeof configuredBinary === "string" ? configuredBinary : undefined) ??
	join(root, "platform/rust-daemon/target/debug/signet-daemon");
const children: Bun.Subprocess[] = [];
const workspaces: string[] = [];

async function stop(child: Bun.Subprocess): Promise<void> {
	child.kill("SIGTERM");
	if (await Promise.race([child.exited.then(() => true), Bun.sleep(1_000).then(() => false)])) return;
	child.kill("SIGKILL");
	await Promise.race([child.exited, Bun.sleep(1_000)]);
}

afterEach(async () => {
	for (const child of children.splice(0)) await stop(child);
	for (const workspace of workspaces.splice(0)) rmSync(workspace, { recursive: true, force: true });
});

test("native git config route keeps its startup workspace boundary", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "signet-git-config-contract-"));
	const outside = mkdtempSync(join(tmpdir(), "signet-git-config-outside-"));
	const workspaceAlias = `${workspace}-alias`;
	workspaces.push(workspace, outside);
	symlinkSync(workspace, workspaceAlias);
	workspaces.push(workspaceAlias);
	writeFileSync(join(workspace, "agent.yaml"), "git:\n  remote: inside\n");
	writeFileSync(join(outside, "agent.yaml"), "git:\n  remote: outside\n");
	const port = 39_000 + Math.floor(Math.random() * 1_000);
	const child = Bun.spawn([binary], {
		cwd: root,
		env: {
			...process.env,
			SIGNET_PATH: workspaceAlias,
			SIGNET_BIND: "127.0.0.1",
			SIGNET_PORT: String(port),
			SIGNET_API_KEY: "contract-key",
		},
		stdout: "ignore",
		stderr: "pipe",
	});
	children.push(child);
	const stderr = new Response(child.stderr).text();
	const origin = `http://127.0.0.1:${port}`;
	let ready = false;
	for (let i = 0; i < 200; i++) {
		if (child.exitCode !== null) break;
		try {
			if ((await fetch(`${origin}/health/ready`)).ok) {
				ready = true;
				break;
			}
		} catch {}
		await Bun.sleep(25);
	}
	if (!ready) {
		await stop(child);
		throw new Error(`native daemon did not become ready: ${await stderr}`);
	}
	const initial = await fetch(`${origin}/api/git/config`, {
		headers: { "x-signet-api-key": "contract-key" },
	});
	expect(initial.status).toBe(200);
	expect(await initial.json()).toMatchObject({ remote: "inside" });
	rmSync(workspaceAlias);
	symlinkSync(outside, workspaceAlias);
	const response = await fetch(`${origin}/api/git/config`, {
		headers: { "x-signet-api-key": "contract-key" },
	});
	expect(response.status).toBe(200);
	expect(await response.json()).toMatchObject({ remote: "inside" });
});

test("native git config route is process reachable", async () => {
	expect(existsSync(binary)).toBe(true);
	const workspace = mkdtempSync(join(tmpdir(), "signet-git-config-contract-"));
	workspaces.push(workspace);
	writeFileSync(
		join(workspace, "agent.yaml"),
		"git:\n  enabled: false\n  autoCommit: true\n  autoSync: true\n  syncInterval: 1\n  remote: upstream\n  branch: feature\n",
	);
	const port = 39_000 + Math.floor(Math.random() * 1_000);
	const child = Bun.spawn([binary], {
		cwd: root,
		env: {
			...process.env,
			SIGNET_PATH: workspace,
			SIGNET_BIND: "127.0.0.1",
			SIGNET_PORT: String(port),
			SIGNET_API_KEY: "contract-key",
		},
		stdout: "ignore",
		stderr: "pipe",
	});
	children.push(child);
	const stderr = new Response(child.stderr).text();
	const origin = `http://127.0.0.1:${port}`;
	let ready = false;
	for (let i = 0; i < 200; i++) {
		if (child.exitCode !== null) break;
		try {
			if ((await fetch(`${origin}/health/ready`)).ok) {
				ready = true;
				break;
			}
		} catch {}
		await Bun.sleep(25);
	}
	if (!ready) {
		await stop(child);
		throw new Error(`native daemon did not become ready: ${await stderr}`);
	}

	const response = await fetch(`${origin}/api/git/config`, {
		headers: { "x-signet-api-key": "contract-key" },
	});
	expect(response.status).toBe(200);
	expect(await response.json()).toEqual({
		enabled: false,
		autoCommit: true,
		autoSync: true,
		syncInterval: 60,
		remote: "upstream",
		branch: "feature",
	});
});
