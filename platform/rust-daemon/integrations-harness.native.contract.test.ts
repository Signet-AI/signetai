import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "../..");
const binary =
	(Reflect.get(process.env, "SIGNET_RUST_DAEMON_BIN") as string | undefined) ??
	join(root, "platform/rust-daemon/target/debug/signet-daemon");
const children: ReturnType<typeof Bun.spawn>[] = [];
const workspaces: string[] = [];
let port = 39_400;

async function start() {
	expect(existsSync(binary)).toBe(true);
	const workspace = mkdtempSync(join("/tmp", "signet-integrations-harness-"));
	workspaces.push(workspace);
	writeFileSync(join(workspace, "agent.yaml"), "harnesses:\n  - bun\n  - claude\n");
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

describe("native harness configuration parity", () => {
	it("discovers configured harnesses from the workspace agent config", async () => {
		const origin = await start();
		const response = await fetch(`${origin}/api/harnesses`);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			configuredHarnesses: ["bun", "claude"],
			harnesses: [{ name: "bun" }, { name: "claude" }],
		});
	});
});
