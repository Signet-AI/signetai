import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = import.meta.dir;
const binary = process.env.SIGNET_RUST_DAEMON_BIN ?? join(root, "../../../rust-daemon/target/debug/signet-daemon");
let child: Bun.Subprocess | undefined;
let port = 0;
let workspace = "";

async function waitForDaemon(): Promise<void> {
	for (let attempt = 0; attempt < 200; attempt += 1) {
		try {
			const response = await fetch(`http://127.0.0.1:${port}/health/live`);
			if (response.ok) return;
		} catch {
			// The process needs a short window to bind its listener.
		}
		await Bun.sleep(25);
	}
	throw new Error("native daemon did not become ready");
}

async function stopChild(): Promise<string> {
	if (!child) return "";
	child.kill("SIGTERM");
	await child.exited.catch(() => {});
	if (!child.stderr || typeof child.stderr === "number") return "";
	return new Response(child.stderr).text();
}

describe("fresh native MCP boundary", () => {
	beforeAll(async () => {
		workspace = await mkdtemp(join(tmpdir(), "signet-mcp-boundary-"));
		const probe = Bun.listen({
			hostname: "127.0.0.1",
			port: 0,
			socket: { data() {}, open() {}, close() {} },
		});
		port = probe.port;
		probe.stop();
		child = Bun.spawn([binary], {
			cwd: root,
			env: {
				PATH: process.env.PATH ?? "",
				SIGNET_PATH: workspace,
				SIGNET_BIND: "127.0.0.1",
				SIGNET_PORT: String(port),
			},
			stdout: "ignore",
			stderr: "pipe",
		});
		try {
			await waitForDaemon();
		} catch (error) {
			const stderr = await stopChild();
			throw new Error(`${error instanceof Error ? error.message : String(error)}\n${stderr}`);
		}
	});

	afterAll(async () => {
		await stopChild();
		if (workspace) await rm(workspace, { recursive: true, force: true });
	});

	it("publishes truthful native discovery metadata from the running process", async () => {
		const response = await fetch(`http://127.0.0.1:${port}/api/mcp/capabilities`);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			transport: "streamable-http",
			native: true,
			stdio: { supported: false, provider_execution: false },
			management: { supported: false, reason: "not represented by native Operations" },
			analytics: { supported: false, reason: "not represented by native Operations" },
		});
	});
});
