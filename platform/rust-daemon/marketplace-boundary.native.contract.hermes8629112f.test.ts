import { afterEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "../..");
// biome-ignore lint/suspicious/noUndeclaredEnvVars: test override for compiled daemon
const binary = process.env.SIGNET_RUST_DAEMON_BIN ?? join(root, "platform/rust-daemon/target/debug/signet-daemon");
const children: Bun.Subprocess[] = [];
const workspaces: string[] = [];
let port = 40180;
const auth = { "x-signet-api-key": "test-key" };

async function start() {
	const workspace = mkdtempSync(join(tmpdir(), "signet-marketplace-boundary-"));
	workspaces.push(workspace);
	const portNumber = port++;
	const origin = `http://127.0.0.1:${portNumber}`;
	const child = Bun.spawn([binary], {
		cwd: workspace,
		env: {
			...process.env,
			SIGNET_API_KEY: "test-key",
			SIGNET_PATH: workspace,
			SIGNET_BIND: "127.0.0.1",
			SIGNET_PORT: String(portNumber),
		},
		stdout: "ignore",
		stderr: "pipe",
	});
	children.push(child);
	for (let i = 0; i < 200; i++) {
		try {
			if ((await fetch(`${origin}/health/ready`)).ok) return origin;
		} catch {}
		await Bun.sleep(25);
	}
	throw new Error(await new Response(child.stderr).text());
}

afterEach(async () => {
	for (const child of children.splice(0)) {
		child.kill("SIGTERM");
		await Promise.race([child.exited, Bun.sleep(1000)]);
	}
	for (const workspace of workspaces.splice(0)) rmSync(workspace, { recursive: true, force: true });
});

it("keeps unbacked marketplace/provider/install/review/network operations explicit", async () => {
	const origin = await start();
	const operations: Array<[string, string]> = [
		["GET", "/api/marketplace/mcp"],
		["GET", "/api/marketplace/mcp/browse"],
		["POST", "/api/marketplace/mcp/install"],
		["POST", "/api/marketplace/mcp/register"],
		["POST", "/api/marketplace/mcp/call"],
		["GET", "/api/marketplace/reviews"],
		["POST", "/api/marketplace/reviews/sync"],
	];
	for (const [method, path] of operations) {
		expect((await fetch(origin + path, { method })).status).toBe(401);
		const response = await fetch(origin + path, { method, headers: auth });
		expect(response.status).toBe(501);
		expect(await response.json()).toMatchObject({ code: "unsupported" });
	}
});
