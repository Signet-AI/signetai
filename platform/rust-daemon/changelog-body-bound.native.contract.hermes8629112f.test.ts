import { afterEach, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = process.cwd();
const configuredBinary = Reflect.get(process.env, "SIGNET_RUST_DAEMON_BIN");
const binary =
	(typeof configuredBinary === "string" ? configuredBinary : undefined) ??
	join(root, "platform/rust-daemon/target/debug/signet-daemon");
const children: Bun.Subprocess[] = [];
const workspaces: string[] = [];
let nextPort = 39_700;

async function waitForReady(origin: string, child: Bun.Subprocess): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		try {
			if ((await fetch(`${origin}/health/ready`)).ok) return;
		} catch {}
		if (await Promise.race([child.exited.then(() => true), Bun.sleep(25).then(() => false)])) {
			throw new Error("daemon exited during readiness");
		}
	}
	throw new Error("daemon did not become ready");
}

async function stop(child: Bun.Subprocess): Promise<void> {
	child.kill("SIGTERM");
	if (await Promise.race([child.exited.then(() => true), Bun.sleep(1_000).then(() => false)])) return;
	child.kill("SIGKILL");
	await Promise.race([child.exited, Bun.sleep(1_000)]);
}

afterEach(async () => {
	for (const child of children.splice(0)) await stop(child);
	for (const workspace of workspaces.splice(0)) rmSync(workspace, { recursive: true, force: true });
});

it("bounds chunked changelog, roadmap, and readme bodies in a real daemon process", async () => {
	if (!existsSync(binary)) throw new Error(`fresh Rust daemon binary is missing: ${binary}`);
	const upstream = Bun.serve({
		port: 0,
		fetch() {
			const stream = new ReadableStream<Uint8Array>({
				start(controller) {
					const chunk = new Uint8Array(64 * 1024);
					for (let i = 0; i < 33; i++) controller.enqueue(chunk);
					controller.close();
				},
			});
			return new Response(stream, { headers: { "content-type": "text/markdown" } });
		},
	});
	try {
		const workspace = mkdtempSync(join(tmpdir(), "signet-changelog-bound-"));
		workspaces.push(workspace);
		const port = nextPort++;
		const child = Bun.spawn([binary], {
			cwd: root,
			env: {
				...process.env,
				SIGNET_PATH: workspace,
				SIGNET_BIND: "127.0.0.1",
				SIGNET_PORT: String(port),
				SIGNET_CHANGELOG_MODE: "test",
				SIGNET_CHANGELOG_BASE_URL: `http://127.0.0.1:${upstream.port}`,
			},
			stdout: "ignore",
			stderr: "ignore",
		});
		children.push(child);
		const origin = `http://127.0.0.1:${port}`;
		await waitForReady(origin, child);
		for (const path of ["/api/changelog", "/api/roadmap", "/api/readme"]) {
			const response = await fetch(`${origin}${path}`);
			expect(response.status).toBe(503);
			expect(await response.json()).toEqual({
				error:
					path === "/api/changelog"
						? "Changelog unavailable"
						: path === "/api/roadmap"
							? "Roadmap unavailable"
							: "README unavailable",
			});
		}
	} finally {
		upstream.stop(true);
	}
});
