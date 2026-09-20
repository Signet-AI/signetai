import { afterEach, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const root = join(import.meta.dir, "../..");
// biome-ignore lint/suspicious/noUndeclaredEnvVars: test override for compiled daemon
const binary = process.env.SIGNET_RUST_DAEMON_BIN ?? join(root, "platform/rust-daemon/target/debug/signet-daemon");
const children: Bun.Subprocess[] = [];
const dirs: string[] = [];
let port = 39940;
async function start() {
	const workspace = mkdtempSync(join(tmpdir(), "signet-plugins-"));
	dirs.push(workspace);
	const p = port++;
	const child = Bun.spawn([binary], {
		cwd: workspace,
		env: {
			...process.env,
			SIGNET_API_KEY: "test-key",
			SIGNET_PATH: workspace,
			SIGNET_BIND: "127.0.0.1",
			SIGNET_PORT: String(p),
		},
		stdout: "ignore",
		stderr: "pipe",
	});
	children.push(child);
	const origin = `http://127.0.0.1:${p}`;
	for (let i = 0; i < 200; i++) {
		try {
			if ((await fetch(`${origin}/health/ready`)).ok) return { origin, workspace };
		} catch {}
		await Bun.sleep(25);
	}
	throw new Error(await new Response(child.stderr).text());
}
const auth = { "x-signet-api-key": "test-key" };
const get = (o: string, p: string, h: Record<string, string> = {}) => fetch(o + p, { headers: h });
afterEach(async () => {
	for (const c of children.splice(0)) {
		c.kill("SIGTERM");
		await Promise.race([c.exited, Bun.sleep(1000)]);
	}
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
it("starts, authenticates every route, filters audit, persists safely", async () => {
	const { origin, workspace } = await start();
	for (const p of [
		"/api/plugins",
		"/api/plugins/signet-secrets",
		"/api/plugins/signet-secrets/diagnostics",
		"/api/plugins/prompt-contributions",
		"/api/plugins/audit",
	])
		expect((await get(origin, p)).status).toBe(401);
	expect((await get(origin, "/api/plugins", auth)).status).toBe(200);
	expect((await get(origin, "/api/plugins/nope", auth)).status).toBe(404);
	const d = await (await get(origin, "/api/plugins/signet-graphiq/diagnostics", auth)).json();
	expect(d.plugin.promptContributions).toBeArray();
	expect(d.plugin.promptContributionDiagnostics).toBeArray();
	expect(
		(
			await fetch(`${origin}/api/plugins/signet-graphiq`, {
				method: "PATCH",
				headers: { ...auth, "content-type": "application/json" },
				body: JSON.stringify({ enabled: false }),
			})
		).status,
	).toBe(200);
	const path = join(workspace, ".daemon/plugins/registry-v1.json");
	const saved = JSON.parse(readFileSync(path, "utf8"));
	expect(saved.plugins["signet-graphiq"].installedAt).toBeDefined();
	expect((await (await get(origin, "/api/plugins/signet-graphiq", auth)).json()).enabled).toBe(false);
	expect(
		(await get(origin, "/api/plugins/audit?event=plugin.disabled&since=0&until=9999999999&limit=10", auth)).status,
	).toBe(200);
});
it("refuses malformed registry instead of overwriting it", async () => {
	const { origin, workspace } = await start();
	const path = join(workspace, ".daemon/plugins/registry-v1.json");
	mkdirSync(join(workspace, ".daemon/plugins"), { recursive: true });
	writeFileSync(path, "not-json");
	const r = await fetch(`${origin}/api/plugins/signet-graphiq`, {
		method: "PATCH",
		headers: { ...auth, "content-type": "application/json" },
		body: JSON.stringify({ enabled: false }),
	});
	expect(r.status).toBe(409);
	expect(readFileSync(path, "utf8")).toBe("not-json");
});
