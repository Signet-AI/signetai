/* biome-ignore-all lint/suspicious/noExplicitAny: dynamic JSON contract payloads */
import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const root = process.cwd();
// biome-ignore lint/suspicious/noUndeclaredEnvVars: test-only binary override
const bin = process.env.SIGNET_RUST_DAEMON_BIN ?? join(root, "platform/rust-daemon/target/debug/signet-daemon");
const key = `hardening-${Date.now()}`;

type Daemon = { origin: string; child: ReturnType<typeof Bun.spawn>; workspace: string; stderr: string[] };

async function start(mode: string): Promise<{ daemon: Daemon; seen: any[]; closeProvider: () => void }> {
	const seen: any[] = [];
	const provider = Bun.serve({
		port: 0,
		async fetch(request) {
			const body = await request.json().catch(() => ({}));
			seen.push({ body, authorization: request.headers.get("authorization") });
			if (mode === "slow") await Bun.sleep(250);
			if (mode === "large") return new Response(JSON.stringify({ result: "x".repeat(1_048_577) }), { status: 200 });
			return Response.json({ choices: [{ message: { content: "ok" } }] });
		},
	});
	const workspace = mkdtempSync(join(tmpdir(), "signet-inference-hardening-"));
	mkdirSync(join(workspace, ".daemon"), { recursive: true });
	const stderr: string[] = [];
	const child = Bun.spawn([bin], {
		env: {
			...process.env,
			SIGNET_PATH: workspace,
			SIGNET_BIND: "127.0.0.1",
			SIGNET_PORT: "0",
			SIGNET_API_KEY: key,
			SIGNET_OPENAI_BASE_URL: `http://127.0.0.1:${provider.port}`,
			SIGNET_OPENAI_MODEL: "model",
			SIGNET_OPENAI_API_KEY: "provider-secret",
		},
		stdout: "ignore",
		stderr: "pipe",
	});
	const reader = child.stderr.getReader();
	void (async () => {
		const decoder = new TextDecoder();
		while (true) {
			const next = await reader.read();
			if (next.done) break;
			stderr.push(decoder.decode(next.value));
		}
	})();
	const port = 39000 + Math.floor(Math.random() * 1000);
	child.kill("SIGTERM");
	await child.exited;
	const actual = Bun.spawn([bin], {
		env: {
			...process.env,
			SIGNET_PATH: workspace,
			SIGNET_BIND: "127.0.0.1",
			SIGNET_PORT: String(port),
			SIGNET_API_KEY: key,
			SIGNET_OPENAI_BASE_URL: `http://127.0.0.1:${provider.port}`,
			SIGNET_OPENAI_MODEL: "model",
			SIGNET_OPENAI_API_KEY: "provider-secret",
		},
		stdout: "ignore",
		stderr: "pipe",
	});
	const actualStderr: string[] = [];
	const actualReader = actual.stderr.getReader();
	void (async () => {
		const decoder = new TextDecoder();
		while (true) {
			const next = await actualReader.read();
			if (next.done) break;
			actualStderr.push(decoder.decode(next.value));
		}
	})();
	const origin = `http://127.0.0.1:${port}`;
	for (let i = 0; i < 160; i++) {
		try {
			if ((await fetch(`${origin}/health/ready`)).ok)
				return {
					daemon: { origin, child: actual, workspace, stderr: actualStderr },
					seen,
					closeProvider: () => provider.stop(true),
				};
		} catch {}
		await Bun.sleep(25);
	}
	actual.kill("SIGTERM");
	await actual.exited;
	provider.stop(true);
	throw new Error(`daemon readiness failed: ${actualStderr.join("")}`);
}

async function call(d: Daemon, path: string, body: any, agent = "agent-a") {
	const response = await fetch(d.origin + path, {
		method: "POST",
		headers: { authorization: `Bearer ${key}`, "x-signet-agent": agent, "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	return { response, text: await response.text() };
}

async function stop(d: Daemon) {
	d.child.kill("SIGTERM");
	await d.child.exited;
	expect(d.stderr.join("")).not.toContain("provider-secret");
	expect(d.stderr.join("")).not.toContain(key);
	rmSync(d.workspace, { recursive: true, force: true });
}

describe("fresh Rust inference hardening", () => {
	it("requires a prompt and accepts TypeScript timeout spelling", async () => {
		if (!existsSync(bin)) throw new Error(`missing native daemon: ${bin}`);
		const { daemon, closeProvider } = await start("normal");
		try {
			expect((await call(daemon, "/api/inference/execute", {})).response.status).toBe(400);
			expect((await call(daemon, "/api/inference/execute", { prompt: "x", timeoutMs: 1000 })).response.status).toBe(
				200,
			);
		} finally {
			await stop(daemon);
			closeProvider();
		}
	});

	it("rejects an oversized provider response without returning provider data", async () => {
		const { daemon, closeProvider } = await start("large");
		try {
			const result = await call(daemon, "/api/inference/execute", { prompt: "large" });
			expect(result.response.status).toBe(502);
			expect(result.text).not.toContain("x".repeat(100));
		} finally {
			await stop(daemon);
			closeProvider();
		}
	});
});
