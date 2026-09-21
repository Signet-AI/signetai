import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = process.cwd();
// biome-ignore lint/suspicious/noUndeclaredEnvVars: test-only binary override
const binary = process.env.SIGNET_RUST_DAEMON_BIN ?? join(root, "platform/rust-daemon/target/debug/signet-daemon");
const children: Bun.Subprocess[] = [];
const workspaces: string[] = [];

async function startDaemon() {
	const workspace = mkdtempSync(join(tmpdir(), "signet-traversal-status-"));
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
			SIGNET_AGENT_ID: "traversal-status-owner",
			SIGNET_API_KEY: "",
			SIGNET_TOKEN: "",
		},
		stdout,
		stderr,
	});
	children.push(child);
	const origin = `http://127.0.0.1:${port}`;
	for (let attempt = 0; attempt < 240; attempt++) {
		try {
			if ((await fetch(`${origin}/health/ready`)).ok) return { child, origin, workspace, stdout, stderr };
		} catch {}
		await Bun.sleep(25);
	}
	throw new Error(`daemon readiness timeout\nstdout=${await stdout.text()}\nstderr=${await stderr.text()}`);
}

async function stopDaemon(child: Bun.Subprocess) {
	child.kill("SIGTERM");
	await Promise.race([child.exited, Bun.sleep(1000)]);
	if (!child.killed) child.kill("SIGKILL");
	await child.exited;
}

afterEach(async () => {
	for (const child of children.splice(0)) await stopDaemon(child);
	for (const workspace of workspaces.splice(0)) rmSync(workspace, { recursive: true, force: true });
});

test("fresh daemon traversal status returns the empty status envelope", async () => {
	const daemon = await startDaemon();
	try {
		const response = await fetch(`${daemon.origin}/api/knowledge/traversal/status`, {
			headers: {
				"x-signet-agent": "traversal-status-owner",
				"x-signet-workspace-id": "traversal-status-workspace",
			},
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ status: null });
	} catch (error) {
		throw new Error(
			`${error instanceof Error ? error.message : String(error)}\nstdout=${readFileSync(join(daemon.workspace, "stdout.log"), "utf8")}\nstderr=${readFileSync(join(daemon.workspace, "stderr.log"), "utf8")}`,
		);
	}
});
