import { afterEach, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "../..");
// biome-ignore lint/suspicious/noUndeclaredEnvVars: test binary override
const binary = process.env.SIGNET_RUST_DAEMON_BIN ?? join(root, "platform/rust-daemon/target/debug/signet-daemon");
const children: Bun.Subprocess[] = [];
const workspaces: string[] = [];
let nextPort = 41000;

async function start() {
	const workspace = mkdtempSync(join(tmpdir(), "signet-skills-contract-"));
	workspaces.push(workspace);
	for (const name of ["alpha", "beta"]) {
		mkdirSync(join(workspace, "skills", name), { recursive: true });
		writeFileSync(join(workspace, "skills", name, "SKILL.md"), `---\ndescription: ${name} skill\n---\nbody`);
	}
	const port = nextPort++;
	const child = Bun.spawn([binary], {
		cwd: root,
		env: {
			...process.env,
			SIGNET_API_KEY: "skills-test-key",
			SIGNET_PATH: workspace,
			SIGNET_BIND: "127.0.0.1",
			SIGNET_PORT: String(port),
			SIGNET_SKILLS_SH_BASE_URL: "http://127.0.0.1:1",
			SIGNET_CLAWHUB_BASE_URL: "http://127.0.0.1:1",
		},
		stdout: "ignore",
		stderr: "pipe",
	});
	children.push(child);
	const origin = `http://127.0.0.1:${port}`;
	for (let i = 0; i < 200; i++) {
		try {
			if ((await fetch(`${origin}/health/ready`)).ok) return { origin, workspace };
		} catch {}
		await Bun.sleep(25);
	}
	const stderr = await new Response(child.stderr).text();
	throw new Error(`daemon did not become ready: ${stderr.slice(-2000)}`);
}

async function stop(child: Bun.Subprocess) {
	child.kill("SIGTERM");
	if (await Promise.race([child.exited.then(() => true), Bun.sleep(1000).then(() => false)])) return;
	child.kill("SIGKILL");
	await Promise.race([child.exited, Bun.sleep(1000)]);
}

afterEach(async () => {
	for (const child of children.splice(0)) await stop(child);
	for (const path of workspaces.splice(0)) rmSync(path, { recursive: true, force: true });
});

it("lists scoped skills with truthful truncation and bounded unsupported actions", async () => {
	const { origin } = await start();
	const auth = { "x-signet-api-key": "skills-test-key" };
	const response = await fetch(`${origin}/api/skills?limit=1`, { headers: auth });
	expect(response.status).toBe(200);
	expect(await response.json()).toMatchObject({ count: 1, total: 2, truncated: true });
	expect((await fetch(`${origin}/api/skills`, { headers: {} })).status).toBe(401);
	expect((await fetch(`${origin}/api/skills?limit=0`, { headers: auth })).status).toBe(400);
	expect(
		(
			await fetch(`${origin}/api/skills/install`, {
				method: "POST",
				headers: { ...auth, "content-type": "application/json" },
				body: JSON.stringify({}),
			})
		).status,
	).toBe(400);
	expect(
		(
			await fetch(`${origin}/api/skills/install`, {
				method: "POST",
				headers: { ...auth, "content-type": "application/json" },
				body: JSON.stringify({ name: "remote", source: "https://example.invalid" }),
			})
		).status,
	).toBe(501);
});
