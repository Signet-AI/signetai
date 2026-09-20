import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "../..");
const binary = process.env.SIGNET_RUST_DAEMON_BIN ?? join(root, "platform/rust-daemon/target/debug/signet-daemon");
const children: ReturnType<typeof Bun.spawn>[] = [];
const workspaces: string[] = [];
let port = 39_300;

async function start() {
	expect(existsSync(binary)).toBe(true);
	const workspace = mkdtempSync(join("/tmp", "signet-integrations-unsupported-"));
	workspaces.push(workspace);
	const child = Bun.spawn([binary], {
		cwd: root,
		env: { ...process.env, SIGNET_PATH: workspace, SIGNET_BIND: "127.0.0.1", SIGNET_PORT: String(port++) },
		stdout: "ignore",
		stderr: "pipe",
	});
	children.push(child);
	const origin = `http://127.0.0.1:${port - 1}`;
	for (let i = 0; i < 100; i++) {
		try {
			if ((await fetch(`${origin}/health/ready`)).ok) return origin;
		} catch {}
		await Bun.sleep(50);
	}
	throw new Error("native daemon did not become ready");
}

afterEach(async () => {
	for (const child of children.splice(0)) {
		child.kill();
		await child.exited;
	}
	for (const workspace of workspaces.splice(0)) rmSync(workspace, { recursive: true, force: true });
});

describe("native unsupported integration operations", () => {
	it("returns explicit 501 metadata for connector registration and harness regeneration", async () => {
		const origin = await start();
		const connector = await fetch(`${origin}/api/connectors`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ provider: "github-docs" }),
		});
		expect(connector.status).toBe(501);
		expect(await connector.json()).toMatchObject({ status: "unsupported", operation: "connector-registration" });

		const harness = await fetch(`${origin}/api/harnesses/regenerate`, { method: "POST" });
		expect(harness.status).toBe(501);
		expect(await harness.json()).toMatchObject({ status: "unsupported", operation: "harness-regeneration" });
	});
});
