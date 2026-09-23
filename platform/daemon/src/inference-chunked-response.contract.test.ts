import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "../../..");
const binary = process.env.SIGNET_RUST_DAEMON_BIN ?? join(root, "platform/rust-daemon/target/debug/signet-daemon");
let daemon: Bun.Subprocess;
let port: number;
let workspace: string;
let provider: { port: number | undefined; stop: () => void };

async function waitFor(url: string): Promise<void> {
	for (let attempt = 0; attempt < 200; attempt += 1) {
		try {
			if ((await fetch(url)).ok) return;
		} catch {}
		await Bun.sleep(25);
	}
	throw new Error(`timed out waiting for ${url}`);
}

describe("inference provider bounded response contract", () => {
	beforeAll(async () => {
		workspace = await mkdtemp(join(tmpdir(), "signet-inference-limit-"));
		provider = Bun.serve({
			port: 0,
			fetch() {
				const chunk = new TextEncoder().encode("a".repeat(16 * 1024));
				return new Response(
					new ReadableStream({
						start(controller) {
							for (let i = 0; i < 65; i += 1) controller.enqueue(chunk);
							controller.close();
						},
					}),
					{ headers: { "content-type": "application/json" } },
				);
			},
		});
		if (provider.port === undefined) throw new Error("provider did not bind");
		port = provider.port;
		const daemonProbe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {}, open() {}, close() {} } });
		const daemonPort = daemonProbe.port;
		daemonProbe.stop();
		daemon = Bun.spawn([binary], {
			cwd: root,
			env: {
				...process.env,
				SIGNET_PATH: workspace,
				SIGNET_BIND: "127.0.0.1",
				SIGNET_PORT: String(daemonPort),
				SIGNET_API_KEY: "contract-key",
				SIGNET_OPENAI_BASE_URL: `http://127.0.0.1:${port}`,
				SIGNET_OPENAI_MODEL: "contract-model",
			},
			stdout: "ignore",
			stderr: "pipe",
		});
		await waitFor(`http://127.0.0.1:${daemonPort}/health/live`);
		port = daemonPort;
	});
	afterAll(async () => {
		provider?.stop();
		daemon?.kill("SIGTERM");
		await daemon?.exited.catch(() => {});
		await rm(workspace, { recursive: true, force: true });
	});
	it("rejects a chunked provider body above 1 MiB without buffering it unboundedly", async () => {
		const response = await fetch(`http://127.0.0.1:${port}/api/inference/execute`, {
			method: "POST",
			headers: {
				authorization: "Bearer contract-key",
				"x-signet-agent": "contract-agent",
				"content-type": "application/json",
			},
			body: JSON.stringify({ prompt: "hello" }),
		});
		expect(response.status).toBe(502);
		expect(await response.json()).toMatchObject({ code: "upstream_error", error: "provider response exceeds 1 MiB" });
	});
});
