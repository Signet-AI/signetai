/* biome-ignore-all lint/suspicious/noUndeclaredEnvVars: native contract harness */
import { describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
const bin = process.env.SIGNET_RUST_DAEMON_BIN;
if (!bin) throw new Error("SIGNET_RUST_DAEMON_BIN is required; native contract must not be skipped");
const key = process.env.SIGNET_API_KEY ?? "test-native-api-key";
let root = "";
let child: ChildProcess | undefined;
let origin = "";
let stdoutPath = "";
let stderrPath = "";
const headers = () => ({
	authorization: `Bearer ${key}`,
	"content-type": "application/json",
	"x-signet-agent-id": "native-contract",
	"x-signet-workspace-id": "native-contract",
});
async function waitReady() {
	for (let i = 0; i < 100; i++) {
		try {
			if ((await fetch(`${origin}/health/ready`)).ok) return;
		} catch {}
		await Bun.sleep(50);
	}
	throw new Error("native daemon did not become ready");
}
async function request(path: string, init?: RequestInit) {
	const r = await fetch(`${origin}${path}`, init);
	return { r, body: (await r.json()) as Record<string, unknown> };
}
describe("native secrets exec HTTP contract", () => {
	it("launches the exact binary and enforces the HTTP contract", async () => {
		root = await mkdtemp(join(tmpdir(), "signet-native-secrets-"));
		const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {}, open() {}, close() {} } });
		const port = probe.port;
		probe.stop();
		origin = `http://127.0.0.1:${port}`;
		child = spawn(bin, ["--host", "127.0.0.1", "--port", String(port)], {
			env: {
				...process.env,
				SIGNET_PATH: root,
				SIGNET_BIND: "127.0.0.1",
				SIGNET_MODE: "test",
				SIGNET_PORT: String(port),
				SIGNET_API_KEY: key,
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		stdoutPath = join(root, "daemon.stdout.log");
		stderrPath = join(root, "daemon.stderr.log");
		child.stdout?.on("data", (chunk) => Bun.write(stdoutPath, chunk, { createPath: true }));
		child.stderr?.on("data", (chunk) => Bun.write(stderrPath, chunk, { createPath: true }));
		await waitReady();
		expect((await fetch(`${origin}/api/secrets/exec`, { method: "POST", body: "{}" })).status).toBe(401);
		const put = await request("/api/secrets", {
			method: "POST",
			headers: headers(),
			body: JSON.stringify({ name: "contract-secret", value: "native-secret-value" }),
		});
		expect(put.r.status).toBe(201);
		const bad = await request("/api/secrets/exec", {
			method: "POST",
			headers: headers(),
			body: JSON.stringify({ command: "echo hi; id", secrets: {} }),
		});
		expect(bad.r.status).toBe(400);
		const made = await request("/api/secrets/exec", {
			method: "POST",
			headers: headers(),
			body: JSON.stringify({ command: "printf %s", secrets: { VALUE: "contract-secret" }, timeoutMs: 1000 }),
		});
		expect(made.r.status).toBe(202);
		expect(made.body).toMatchObject({ status: "queued", timeoutMs: 1000 });
		let done = made.body;
		for (let i = 0; i < 100 && done.status === "queued"; i++) {
			await Bun.sleep(25);
			done = (await request(`/api/secrets/exec/${made.body.id as string}`, { headers: headers() })).body;
		}
		expect(["completed", "failed"]).toContain(done.status);
		expect(JSON.stringify(done)).not.toContain("native-secret-value");
		expect((await fetch(`${origin}/api/secrets/exec/missing`, { headers: headers() })).status).toBe(404);
		child.kill("SIGTERM");
		await new Promise((resolve) => child?.once("exit", resolve));
		await rm(root, { recursive: true, force: true });
	});
});
