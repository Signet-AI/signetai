import { afterEach, expect, it } from "bun:test";
import {
	linkSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const root = join(import.meta.dir, "../..");
// biome-ignore lint/suspicious/noUndeclaredEnvVars: test override for compiled daemon
const binary = process.env.SIGNET_RUST_DAEMON_BIN ?? join(root, "platform/rust-daemon/target/debug/signet-daemon");
const children: Bun.Subprocess[] = [];
const dirs: string[] = [];
async function start() {
	const workspace = mkdtempSync(join(tmpdir(), "signet-plugins-"));
	dirs.push(workspace);
	const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
	const p = probe.port;
	probe.stop();
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

it("preserves concurrent updates to different plugin records", async () => {
	const { origin, workspace } = await start();
	const registryPath = join(workspace, ".daemon/plugins/registry-v1.json");
	mkdirSync(join(workspace, ".daemon/plugins"), { recursive: true });
	const ids = ["signet-graphiq", "signet-secrets"] as const;
	for (let attempt = 0; attempt < 8; attempt++) {
		writeFileSync(
			registryPath,
			JSON.stringify({
				version: 1,
				plugins: Object.fromEntries(ids.map((id) => [id, { enabled: true, installedAt: "1", updatedAt: "1" }])),
			}),
		);
		const responses = await Promise.all(
			ids.map((id) =>
				fetch(`${origin}/api/plugins/${id}`, {
					method: "PATCH",
					headers: { ...auth, "content-type": "application/json" },
					body: JSON.stringify({ enabled: false }),
				}),
			),
		);
		expect(responses.map((response) => response.status)).toEqual([200, 200]);
		const saved = JSON.parse(readFileSync(registryPath, "utf8"));
		for (const id of ids) expect(saved.plugins[id].enabled).toBe(false);
	}
});

it("rejects plugin registry and audit paths redirected through a workspace symlink", async () => {
	const { origin, workspace } = await start();
	const outside = mkdtempSync(join(tmpdir(), "signet-plugins-outside-"));
	dirs.push(outside);
	const outsideRegistry = join(outside, "registry-v1.json");
	const initialRegistry = JSON.stringify({
		version: 1,
		plugins: { "signet-graphiq": { enabled: true, installedAt: "1", updatedAt: "1" } },
	});
	writeFileSync(outsideRegistry, initialRegistry);
	const initialAudit = '{"timestamp":"outside","pluginId":"signet-graphiq","event":"outside"}\n';
	writeFileSync(join(outside, "audit-v1.ndjson"), initialAudit);
	const pluginDirectory = join(workspace, ".daemon/plugins");
	mkdirSync(pluginDirectory, { recursive: true });
	rmSync(pluginDirectory, { recursive: true, force: true });
	symlinkSync(outside, pluginDirectory, "dir");
	expect((await get(origin, "/api/plugins", auth)).status).toBe(409);
	expect((await get(origin, "/api/plugins/audit", auth)).status).toBe(409);
	const response = await fetch(`${origin}/api/plugins/signet-graphiq`, {
		method: "PATCH",
		headers: { ...auth, "content-type": "application/json" },
		body: JSON.stringify({ enabled: false }),
	});
	expect(response.status).toBe(409);
	expect(readFileSync(outsideRegistry, "utf8")).toBe(initialRegistry);
	expect(readFileSync(join(outside, "audit-v1.ndjson"), "utf8")).toBe(initialAudit);
});

it("keeps plugin state bound to the admitted workspace after pathname replacement", async () => {
	const { origin, workspace } = await start();
	const outside = mkdtempSync(join(tmpdir(), "signet-plugins-root-replacement-"));
	dirs.push(outside);
	const outsidePlugins = join(outside, ".daemon/plugins");
	mkdirSync(outsidePlugins, { recursive: true });
	const outsideRegistry = join(outsidePlugins, "registry-v1.json");
	const initialRegistry = JSON.stringify({ version: 1, plugins: {} });
	const initialAudit = '{"timestamp":"outside","pluginId":"signet-graphiq","event":"outside"}\\n';
	writeFileSync(outsideRegistry, initialRegistry);
	writeFileSync(join(outsidePlugins, "audit-v1.ndjson"), initialAudit);
	const pinnedWorkspace = `${workspace}-pinned`;
	renameSync(workspace, pinnedWorkspace);
	dirs.push(pinnedWorkspace);
	symlinkSync(outside, workspace, "dir");
	const response = await fetch(`${origin}/api/plugins/signet-graphiq`, {
		method: "PATCH",
		headers: { ...auth, "content-type": "application/json" },
		body: JSON.stringify({ enabled: false }),
	});
	expect(response.status).toBe(200);
	expect((await response.json()).enabled).toBe(false);
	expect(readFileSync(outsideRegistry, "utf8")).toBe(initialRegistry);
	expect(readFileSync(join(outsidePlugins, "audit-v1.ndjson"), "utf8")).toBe(initialAudit);
	const savedRegistry = JSON.parse(readFileSync(join(pinnedWorkspace, ".daemon/plugins/registry-v1.json"), "utf8"));
	expect(savedRegistry.plugins["signet-graphiq"].enabled).toBe(false);
	expect(readFileSync(join(pinnedWorkspace, ".daemon/plugins/audit-v1.ndjson"), "utf8")).toContain("plugin.disabled");
});

it("rejects registry and audit leaf symlinks without reading or appending outside", async () => {
	const { origin, workspace } = await start();
	const outside = mkdtempSync(join(tmpdir(), "signet-plugins-leaf-symlink-"));
	dirs.push(outside);
	const pluginDirectory = join(workspace, ".daemon/plugins");
	mkdirSync(pluginDirectory, { recursive: true });
	const outsideRegistry = join(outside, "registry-v1.json");
	const outsideAudit = join(outside, "audit-v1.ndjson");
	const initialRegistry = JSON.stringify({ version: 1, plugins: {} });
	const initialAudit = `${JSON.stringify({ timestamp: "outside", pluginId: "signet-graphiq", event: "outside" })}\n`;
	writeFileSync(outsideRegistry, initialRegistry);
	writeFileSync(outsideAudit, initialAudit);
	const registryPath = join(pluginDirectory, "registry-v1.json");
	const auditPath = join(pluginDirectory, "audit-v1.ndjson");
	symlinkSync(outsideRegistry, registryPath, "file");
	expect((await get(origin, "/api/plugins", auth)).status).toBe(409);
	rmSync(registryPath);
	writeFileSync(
		registryPath,
		JSON.stringify({
			version: 1,
			plugins: { "signet-graphiq": { enabled: true, installedAt: "1", updatedAt: "1" } },
		}),
	);
	symlinkSync(outsideAudit, auditPath, "file");
	expect((await get(origin, "/api/plugins/audit", auth)).status).toBe(409);
	const response = await fetch(`${origin}/api/plugins/signet-graphiq`, {
		method: "PATCH",
		headers: { ...auth, "content-type": "application/json" },
		body: JSON.stringify({ enabled: false }),
	});
	expect(response.status).toBe(200);
	expect((await response.json()).auditDegraded).toBe(true);
	expect(readFileSync(outsideRegistry, "utf8")).toBe(initialRegistry);
	expect(readFileSync(outsideAudit, "utf8")).toBe(initialAudit);
});

it("rejects hard-linked registry files instead of reading outside state", async () => {
	const { origin, workspace } = await start();
	const outside = mkdtempSync(join(tmpdir(), "signet-plugins-hardlink-read-"));
	dirs.push(outside);
	const pluginDirectory = join(workspace, ".daemon/plugins");
	mkdirSync(pluginDirectory, { recursive: true });
	const outsideRegistry = join(outside, "registry-v1.json");
	const registry = JSON.stringify({
		version: 1,
		plugins: { "signet-graphiq": { enabled: false, installedAt: "outside-only", updatedAt: "1" } },
	});
	writeFileSync(outsideRegistry, registry);
	linkSync(outsideRegistry, join(pluginDirectory, "registry-v1.json"));
	const response = await get(origin, "/api/plugins", auth);
	expect(response.status).toBe(409);
	expect(readFileSync(outsideRegistry, "utf8")).toBe(registry);
});
it("does not append plugin audit events through hard-linked files", async () => {
	const { origin, workspace } = await start();
	const outside = mkdtempSync(join(tmpdir(), "signet-plugins-hardlink-audit-"));
	dirs.push(outside);
	const pluginDirectory = join(workspace, ".daemon/plugins");
	mkdirSync(pluginDirectory, { recursive: true });
	const outsideAudit = join(outside, "audit-v1.ndjson");
	const initialAudit = '{"timestamp":"outside","pluginId":"signet-graphiq","event":"outside"}\\n';
	writeFileSync(outsideAudit, initialAudit);
	linkSync(outsideAudit, join(pluginDirectory, "audit-v1.ndjson"));
	const response = await fetch(`${origin}/api/plugins/signet-graphiq`, {
		method: "PATCH",
		headers: { ...auth, "content-type": "application/json" },
		body: JSON.stringify({ enabled: false }),
	});
	expect(response.status).toBe(200);
	const updated = await response.json();
	expect(readFileSync(outsideAudit, "utf8")).toBe(initialAudit);
	expect(updated.auditDegraded).toBe(true);
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

it("strictly validates persisted manifest versions and prompt budgets", async () => {
	const { origin, workspace } = await start();
	const path = join(workspace, ".daemon/plugins/registry-v1.json");
	mkdirSync(join(workspace, ".daemon/plugins"), { recursive: true });
	const record = (version: string, maxTokens: unknown = 1, priority: unknown = 0) => ({
		id: "signet-graphiq",
		name: "GraphIQ",
		version,
		publisher: "aaf2tbz",
		description: "GraphIQ",
		runtime: {},
		compatibility: {},
		trustTier: "verified",
		capabilities: [],
		surfaces: {},
		docs: {},
		promptContributions: [{ maxTokens, priority }],
		enabled: true,
		installedAt: "1",
		updatedAt: "1",
	});
	for (const version of ["1.01.0", "1.0.0-", "1.0.0-01", " 1.0.0", "1.0.0 ", "1.0.0+build.1"]) {
		writeFileSync(path, JSON.stringify({ version: 1, plugins: { "signet-graphiq": record(version) } }));
		expect((await get(origin, "/api/plugins", auth)).status).toBe(version === "1.0.0+build.1" ? 200 : 409);
	}
	for (const [maxTokens, priority] of [
		[0, 0],
		[1, -1],
		[Number.NaN, 0],
		[1, Number.POSITIVE_INFINITY],
	]) {
		writeFileSync(
			path,
			JSON.stringify({ version: 1, plugins: { "signet-graphiq": record("1.0.0", maxTokens, priority) } }),
		);
		expect((await get(origin, "/api/plugins", auth)).status).toBe(409);
	}
});
