import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = process.cwd();
// biome-ignore lint/suspicious/noUndeclaredEnvVars: test-only binary override
const bin = process.env.SIGNET_RUST_DAEMON_BIN ?? join(root, "platform/rust-daemon/target/debug/signet-daemon");
const children: Bun.Subprocess[] = [];
const dirs: string[] = [];

async function start(path: string, apiKey?: string) {
	const port = 36000 + Math.floor(Math.random() * 10000);
	const child = Bun.spawn([bin], {
		cwd: root,
		env: {
			...process.env,
			SIGNET_PATH: path,
			SIGNET_BIND: "127.0.0.1",
			SIGNET_PORT: String(port),
			SIGNET_API_KEY: apiKey ?? "",
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

test("unsupported pipeline and Dreaming surfaces require authentication", async () => {
	const routes = [
		["GET", "/api/pipeline/models"],
		["GET", "/api/dream/quality"],
		["POST", "/api/dream/tools/recall"],
	] as const;
	const unauthDir = mkdtempSync(join(tmpdir(), "pipeline-auth-unauth-"));
	dirs.push(unauthDir);
	const unauthenticatedDaemon = await start(unauthDir);
	for (const [method, path] of routes) {
		const response = await fetch(`${unauthenticatedDaemon.origin}${path}`, { method });
		expect(response.status).not.toBe(501);
	}

	const authorizedDir = mkdtempSync(join(tmpdir(), "pipeline-auth-authorized-"));
	dirs.push(authorizedDir);
	const daemon = await start(authorizedDir, "pipeline-contract-key");
	for (const [method, path] of routes) {
		const authorized = await fetch(`${daemon.origin}${path}`, {
			method,
			headers: { "x-signet-api-key": "pipeline-contract-key" },
		});
		expect(authorized.status).toBe(501);
		const body = await authorized.json();
		expect(body.code).toBe("unsupported");
	}
});
