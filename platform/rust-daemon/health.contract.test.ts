import { afterEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = process.cwd();
const binary = process.env.SIGNET_RUST_DAEMON_BIN ?? join(root, "platform/rust-daemon/target/debug/signet-daemon");
const children: Bun.Subprocess[] = [];
const workspaces: string[] = [];
let port = 39600;

async function start(workspace = mkdtempSync(join(tmpdir(), "signet-health-"))) {
	workspaces.push(workspace);
	const child = Bun.spawn([binary], {
		cwd: root,
		env: { ...process.env, SIGNET_PATH: workspace, SIGNET_BIND: "127.0.0.1", SIGNET_PORT: String(port++) },
		stdout: "ignore",
		stderr: "pipe",
	});
	children.push(child);
	const origin = `http://127.0.0.1:${port - 1}`;
	for (let i = 0; i < 200; i++) {
		try {
			if ((await fetch(`${origin}/health/ready`)).ok) return { child, origin, workspace };
		} catch {}
		await Bun.sleep(25);
	}
	throw new Error(`daemon did not become ready: ${await new Response(child.stderr).text()}`);
}

afterEach(async () => {
	for (const child of children.splice(0)) {
		child.kill("SIGTERM");
		await Promise.race([child.exited, Bun.sleep(1000)]);
	}
	for (const workspace of workspaces.splice(0)) rmSync(workspace, { recursive: true, force: true });
});

it("exposes truthful native health aliases and persists across SIGTERM restart", async () => {
	const daemon = await start();
	expect((await fetch(`${daemon.origin}/health/live`)).status).toBe(200);
	for (const path of ["/health/ready", "/health", "/api/status"]) {
		const response = await fetch(`${daemon.origin}${path}`);
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body.runtime).toBe("rust");
		if (path !== "/health/ready") expect(body.implementation).toBe("fresh");
	}
	expect((await fetch(`${daemon.origin}/api/mode`)).status).toBe(200);
	const features = await fetch(`${daemon.origin}/api/features`);
	expect(features.status).toBe(200);
	expect((await features.json()).features.providerProbes).toBe(false);
	const status = await (await fetch(`${daemon.origin}/api/status`)).json();
	expect(status.unsupported.embedding).toBe("unprobed");
	expect(status.unsupported.inference).toBe("unsupported");
	daemon.child.kill("SIGTERM");
	await daemon.child.exited;
	children.splice(children.indexOf(daemon.child), 1);
	const restarted = await start(daemon.workspace);
	expect((await fetch(`${restarted.origin}/health/ready`)).status).toBe(200);
});

it("keeps live cheap and rejects malformed query input without crashing", async () => {
	const { origin } = await start();
	expect((await fetch(`${origin}/health/live?%zz`)).status).toBe(200);
	expect((await fetch(`${origin}/api/memory/search?limit=not-an-integer`)).status).toBe(400);
	expect((await fetch(`${origin}/api/mode?x=${"x".repeat(8192)}`)).status).toBe(200);
});
