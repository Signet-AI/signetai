import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = process.cwd();
// biome-ignore lint/suspicious/noUndeclaredEnvVars: test-only binary override
const bin = process.env.SIGNET_RUST_DAEMON_BIN ?? join(root, "platform/rust-daemon/target/debug/signet-daemon");
const children: Bun.Subprocess[] = [];
const dirs: string[] = [];
async function start(path: string) {
	const port = 36000 + Math.floor(Math.random() * 10000);
	const child = Bun.spawn([bin], {
		cwd: root,
		env: {
			...process.env,
			SIGNET_PATH: path,
			SIGNET_API_KEY: "pipeline-contract-key",
			SIGNET_BIND: "127.0.0.1",
			SIGNET_PORT: String(port),
			SIGNET_AGENT_ID: "pipeline-agent",
		},
		stdout: "ignore",
		stderr: "pipe",
	});
	children.push(child);
	const origin = `http://127.0.0.1:${port}`;
	for (let i = 0; i < 240; i++) {
		try {
			if ((await fetch(`${origin}/health/ready`)).ok) return { origin };
		} catch {}
		await Bun.sleep(25);
	}
	throw new Error(`daemon readiness timeout: ${await new Response(child.stderr).text()}`);
}
afterEach(async () => {
	for (const child of children.splice(0)) {
		child.kill("SIGTERM");
		await Promise.race([child.exited, Bun.sleep(1_000)]);
		if (child.exitCode === null) {
			child.kill("SIGKILL");
			await child.exited;
		}
	}
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("fresh pipeline boundary preserves owner operations and names unsupported consumer surfaces", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pipeline-contract-"));
	dirs.push(dir);
	const daemon = await start(dir);
	const headers = {
		"content-type": "application/json",
		"x-signet-agent": "pipeline-agent",
		"x-signet-api-key": "pipeline-contract-key",
		"x-workspace-id": "workspace-a",
	};

	const status = await fetch(`${daemon.origin}/api/pipeline/status`, { headers });
	expect(status.status).toBe(200);
	expect(await status.json()).toEqual({ agentId: "pipeline-agent", state: "idle", paused: false });

	const paused = await fetch(`${daemon.origin}/api/pipeline/pause`, { method: "POST", headers });
	expect(paused.status).toBe(200);
	expect(await paused.json()).toEqual({ agentId: "pipeline-agent", state: "paused", paused: true });

	const resumed = await fetch(`${daemon.origin}/api/pipeline/resume`, { method: "POST", headers });
	expect(resumed.status).toBe(200);

	const triggered = await fetch(`${daemon.origin}/api/dream/trigger`, {
		method: "POST",
		headers,
		body: JSON.stringify({ source: "contract" }),
	});
	expect(triggered.status).toBe(200);
	const triggerBody = await triggered.json();
	expect(triggerBody).toMatchObject({ agentId: "pipeline-agent", workspaceId: "workspace-a" });
	expect(typeof triggerBody.id).toBe("string");

	// Model registry behavior is covered by pipeline-model-registry.native.contract.hermes8629112f.test.ts.
	for (const path of ["/api/dream/quality", "/api/dream/operations", "/api/dream/tools"]) {
		const response = await fetch(`${daemon.origin}${path}`, {
			method: path.endsWith("refresh") || path.endsWith("operations") ? "POST" : "GET",
			headers,
			body: path.endsWith("operations") ? JSON.stringify({ operations: [] }) : undefined,
		});
		expect(response.status).toBe(501);
		const body = await response.json();
		expect(body.error).toContain("unsupported");
	}
});
