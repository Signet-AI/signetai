import { afterEach, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const root = join(import.meta.dir, "../..");
// biome-ignore lint/suspicious/noUndeclaredEnvVars: test override for compiled daemon
const binary = process.env.SIGNET_RUST_DAEMON_BIN ?? join(root, "platform/rust-daemon/target/debug/signet-daemon");
const children: Bun.Subprocess[] = [];
const workspaces: string[] = [];
let port = 39700;
const auth = { "x-signet-api-key": "test-key" };
async function start() {
	const workspace = mkdtempSync(join(tmpdir(), "signet-skills-"));
	workspaces.push(workspace);
	mkdirSync(join(workspace, "skills", "demo"), { recursive: true });
	writeFileSync(join(workspace, "skills", "demo", "SKILL.md"), "---\ndescription: local demo\n---\nhello");
	const child = Bun.spawn([binary], {
		cwd: root,
		env: {
			...process.env,
			SIGNET_API_KEY: "test-key",
			SIGNET_PATH: workspace,
			SIGNET_BIND: "127.0.0.1",
			SIGNET_PORT: String(port++),
		},
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
	throw new Error(await new Response(child.stderr).text());
}
afterEach(async () => {
	for (const child of children.splice(0)) {
		child.kill("SIGTERM");
		await Promise.race([child.exited, Bun.sleep(1000)]);
	}
	for (const path of workspaces.splice(0)) rmSync(path, { recursive: true, force: true });
});
it("serves bounded local skills and rejects traversal/symlink escape", async () => {
	const { origin, workspace } = await start();
	const list = await fetch(`${origin}/api/skills?limit=1`, { headers: auth });
	expect(list.status).toBe(200);
	expect((await list.json()).count).toBe(1);
	const detail = await fetch(`${origin}/api/skills/demo`, { headers: auth });
	expect(detail.status).toBe(200);
	expect((await detail.json()).content).toContain("hello");
	expect((await fetch(`${origin}/api/skills/../demo`, { headers: auth })).status).not.toBe(200);
	writeFileSync(join(workspace, "skills", "escape"), "not a directory");
	symlinkSync(workspace, join(workspace, "skills", "escape-link"));
	expect((await fetch(`${origin}/api/skills/escape-link`, { headers: auth })).status).toBe(400);
	expect(
		(
			await fetch(`${origin}/api/skills/install`, {
				method: "POST",
				headers: { ...auth, "content-type": "application/json" },
				body: JSON.stringify({ name: "remote" }),
			})
		).status,
	).toBe(501);
});
