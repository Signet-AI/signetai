import { afterEach, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const root = join(import.meta.dir, "../..");
// biome-ignore lint/suspicious/noUndeclaredEnvVars: test override for compiled daemon
const binary = process.env.SIGNET_RUST_DAEMON_BIN ?? join(root, "platform/rust-daemon/target/debug/signet-daemon");
const children: Bun.Subprocess[] = [];
const workspaces: string[] = [];
let port = 39700;
const auth: Record<string, string> = { "x-signet-api-key": "test-key" };
async function start(cwd = root) {
	const workspace = mkdtempSync(join(tmpdir(), "signet-skills-"));
	workspaces.push(workspace);
	mkdirSync(join(workspace, "skills", "demo"), { recursive: true });
	writeFileSync(
		join(workspace, "skills", "demo", "SKILL.md"),
		"---\ndescription: local demo\nuser_invocable: true\npermissions: [network, filesystem]\nverified: false\n---\nhello",
	);
	const child = Bun.spawn([binary], {
		cwd,
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
			if ((await fetch(`${origin}/health/ready`)).ok) return { origin, workspace };
		} catch {}
		await Bun.sleep(25);
	}
	throw new Error(await new Response(child.stderr).text());
}
const get = (origin: string, path: string, headers = auth) => fetch(`${origin}${path}`, { headers });
afterEach(async () => {
	for (const child of children.splice(0)) {
		child.kill("SIGTERM");
		await Promise.race([child.exited, Bun.sleep(1000)]);
	}
	for (const path of workspaces.splice(0)) rmSync(path, { recursive: true, force: true });
});

it.each([root, join(root, "platform/rust-daemon")])("bounds and safely filters skills from cwd %s", async (cwd) => {
	const { origin, workspace } = await start(cwd);
	mkdirSync(join(workspace, "skills", "second"));
	writeFileSync(join(workspace, "skills", "second", "SKILL.md"), "---\ndescription: second\n---\nbody");
	writeFileSync(join(workspace, "skills", "bad-file"), "not a directory");
	writeFileSync(join(workspace, "skills", "bad-utf8"), Buffer.from([0xff, 0xfe]));
	symlinkSync(workspace, join(workspace, "skills", "escape-link"));
	symlinkSync(join(workspace, "skills", "missing"), join(workspace, "skills", "dangling"));
	const listed = await (await get(origin, "/api/skills?limit=1")).json();
	expect(listed.count).toBe(1);
	expect(listed.skills[0]).toMatchObject({
		user_invocable: true,
		verified: false,
		permissions: ["network", "filesystem"],
	});
	expect(listed.total).toBe(2);
	expect(listed.truncated).toBe(true);
	for (const limit of ["0", "101", "abc"]) expect((await get(origin, `/api/skills?limit=${limit}`)).status).toBe(400);
	expect((await get(origin, "/api/skills/browse?limit=1")).status).toBe(200);
	const browse = await (await get(origin, "/api/skills/browse?limit=1")).json();
	expect(browse.results[0]).toMatchObject({
		catalogKey: "local:demo",
		provider: "local",
		installed: true,
		category: "Installed",
	});
	const search = await (await get(origin, "/api/skills/search?q=demo&limit=1")).json();
	expect(search.total).toBe(1);
	expect(search.truncated).toBe(false);
	expect((await (await get(origin, "/api/skills/search?q=missing")).json()).total).toBe(0);
	expect((await get(origin, "/api/skills/escape-link")).status).toBe(400);
	expect((await get(origin, "/api/skills/dangling")).status).toBe(400);
	expect((await get(origin, "/api/skills/no-such")).status).toBe(404);
	expect((await get(origin, "/api/skills/%2e%2e/demo")).status).not.toBe(200);
	const before = await (await get(origin, "/api/skills")).json();
	expect((await fetch(`${origin}/api/skills/demo`, { method: "DELETE", headers: auth })).status).toBe(501);
	expect((await get(origin, "/api/skills")).json()).resolves.toEqual(before);
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

it("enforces signed capability denial while preserving admin API-key access", async () => {
	const { origin } = await start();
	const response = await fetch(`${origin}/api/auth/token`, {
		method: "POST",
		headers: { ...auth, "content-type": "application/json" },
		body: JSON.stringify({ role: "readonly", scope: {}, ttlSeconds: 300 }),
	});
	expect(response.status).toBe(200);
	const { token } = await response.json();
	expect((await get(origin, "/api/skills", { authorization: `Bearer ${token}` })).status).toBe(403);
	expect((await get(origin, "/api/skills", auth)).status).toBe(200);
});
