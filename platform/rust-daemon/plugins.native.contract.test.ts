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
it("rejects semantically invalid registry shapes", async () => {
	const { origin, workspace } = await start();
	const path = join(workspace, ".daemon/plugins/registry-v1.json");
	mkdirSync(join(workspace, ".daemon/plugins"), { recursive: true });
	for (const value of [
		{ version: 2, plugins: {} },
		{ version: 1, plugins: [] },
		{ version: 1, plugins: { "signet-graphiq": [] } },
	]) {
		writeFileSync(path, JSON.stringify(value));
		expect((await get(origin, "/api/plugins", auth)).status).toBe(409);
	}
});
it("rejects a foreign plugin record in an otherwise valid registry", async () => {
	const { origin, workspace } = await start();
	const path = join(workspace, ".daemon/plugins/registry-v1.json");
	mkdirSync(join(workspace, ".daemon/plugins"), { recursive: true });
	writeFileSync(
		path,
		JSON.stringify({ version: 1, plugins: { foreign: { enabled: true, installedAt: "1", updatedAt: "1" } } }),
	);
	expect((await get(origin, "/api/plugins", auth)).status).toBe(409);
});

it("includes an event when the bounded audit window starts on its newline", async () => {
	const { origin, workspace } = await start();
	const path = join(workspace, ".daemon/plugins/audit-v1.ndjson");
	mkdirSync(join(workspace, ".daemon/plugins"), { recursive: true });
	const event = JSON.stringify({ timestamp: "boundary", pluginId: "signet-graphiq", event: "plugin.disabled" });
	const prefix = `x\n${"x".repeat(2 * 1024 * 1024 - 2)}\n`;
	expect(prefix.length).toBe(2 * 1024 * 1024 + 1);
	writeFileSync(path, prefix + event + "\n");
	const r = await (await get(origin, "/api/plugins/audit?event=plugin.disabled&limit=1", auth)).json();
	expect(r.events[0].timestamp).toBe("boundary");
	expect(r.truncated).toBe(true);
	expect(r.bytesScanned).toBeLessThanOrEqual(2 * 1024 * 1024);
});

it("bounds audit reads and reports truncation while preserving newest filtering", async () => {
	const { origin, workspace } = await start();
	const path = join(workspace, ".daemon/plugins/audit-v1.ndjson");
	mkdirSync(join(workspace, ".daemon/plugins"), { recursive: true });
	const lines = Array.from({ length: 12000 }, (_, i) =>
		JSON.stringify({
			timestamp: String(i),
			pluginId: "signet-graphiq",
			event: "plugin.disabled",
			payload: "x".repeat(180),
		}),
	);
	writeFileSync(path, `${lines.join("\n")}\n`);
	const r = await (
		await get(origin, "/api/plugins/audit?plugin_id=signet-graphiq&event=plugin.disabled&limit=3", auth)
	).json();
	expect(r.events).toHaveLength(3);
	expect(r.events[0].timestamp).toBe("11999");
	expect(r.truncated).toBe(true);
	expect(r.bytesScanned).toBeLessThan(2_100_000);
});
