/* biome-ignore-all lint/suspicious/noExplicitAny: dynamic JSON contract payloads */
import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const bin =
	// biome-ignore lint/suspicious/noUndeclaredEnvVars: test-only binary override
	process.env.SIGNET_RUST_DAEMON_BIN ?? join(process.cwd(), "platform/rust-daemon/target/debug/signet-daemon");
const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const admin = `admin-${suffix}`;
const providerKey = `provider-${suffix}`;
type Seen = { url: string; authorization: string | null; body: any };
type Provider = { origin: string; seen: Seen[]; close: () => void };
type Daemon = { origin: string; child: ReturnType<typeof Bun.spawn>; workspace: string; stderr: string[] };

function provider(): Provider {
	const seen: Seen[] = [];
	const server = Bun.serve({
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			const bodyText = await request.text();
			let body: any = {};
			try {
				body = JSON.parse(bodyText);
			} catch {}
			seen.push({ url: url.pathname, authorization: request.headers.get("authorization"), body });
			if (url.pathname !== "/v1/chat/completions") return new Response("missing", { status: 404 });
			const content = body.messages?.[0]?.content;
			if (content === "timeout") await Bun.sleep(250);
			if (content === "upstream") return Response.json({ error: "provider-failure" }, { status: 429 });
			if (content === "malformed") return new Response("not-json", { status: 200 });
			return Response.json({ choices: [{ message: { role: "assistant", content: "recorded" } }] });
		},
	});
	return { origin: `http://127.0.0.1:${server.port}`, seen, close: () => server.stop(true) };
}

async function daemon(
	workspace: string,
	baseUrl: string,
	port = 39200 + Math.floor(Math.random() * 500),
): Promise<Daemon> {
	if (!existsSync(bin)) throw new Error(`missing native daemon: ${bin}`);
	mkdirSync(join(workspace, ".daemon"), { recursive: true });
	const stderr: string[] = [];
	const child = Bun.spawn([bin], {
		env: {
			...process.env,
			SIGNET_PATH: workspace,
			SIGNET_BIND: "127.0.0.1",
			SIGNET_PORT: String(port),
			SIGNET_API_KEY: admin,
			SIGNET_OPENAI_BASE_URL: baseUrl,
			SIGNET_OPENAI_MODEL: `model-${suffix}`,
			SIGNET_OPENAI_API_KEY: providerKey,
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
	const origin = `http://127.0.0.1:${port}`;
	for (let i = 0; i < 160; i++) {
		try {
			if ((await fetch(`${origin}/health/ready`)).ok) return { origin, child, workspace, stderr };
		} catch {}
		await Bun.sleep(25);
	}
	child.kill("SIGTERM");
	await child.exited;
	throw new Error(`daemon readiness failed; stderr: ${stderr.join("")}`);
}

async function call(d: Daemon, path: string, init: RequestInit = {}, agent = `agent-a-${suffix}`) {
	const response = await fetch(d.origin + path, {
		...init,
		headers: {
			authorization: `Bearer ${admin}`,
			"x-signet-agent": agent,
			"x-signet-workspace": `workspace-${suffix}`,
			"content-type": "application/json",
			...init.headers,
		},
	});
	const text = await response.text();
	let body: any = {};
	try {
		body = JSON.parse(text);
	} catch {}
	return { response, text, body };
}

async function stop(d: Daemon) {
	d.child.kill("SIGTERM");
	expect(await d.child.exited).toBe(0);
	expect(d.stderr.join("")).not.toContain(providerKey);
	expect(d.stderr.join("")).not.toContain(admin);
}

describe("fresh Rust inference route", () => {
	it("records provider contract, isolation, durable history, errors, explain, streaming, cancellation, and cleanup", async () => {
		const p = provider();
		const workspace = mkdtempSync(join(tmpdir(), "signet-inference-"));
		let d: Daemon | undefined;
		try {
			d = await daemon(workspace, p.origin);
			const status = await call(d, "/api/inference/status");
			expect(status.response.status).toBe(200);
			expect(status.body.provider).toBe("openai-compatible");
			expect((await call(d, "/api/inference/catalog")).body.providers).toContain("openai-compatible");

			const prompt = `prompt-${suffix}`;
			const ok = await call(d, "/api/inference/execute", {
				method: "POST",
				body: JSON.stringify({ model: `override-${suffix}`, prompt, messages: [{ role: "user", content: prompt }] }),
			});
			expect(ok.response.status).toBe(200);
			expect(p.seen.at(-1)).toMatchObject({ url: "/v1/chat/completions", authorization: `Bearer ${providerKey}` });
			expect(p.seen.at(-1)?.body).toEqual({
				model: `override-${suffix}`,
				messages: [{ role: "user", content: prompt }],
			});
			expect(ok.text).not.toContain(providerKey);
			expect(
				(
					await call(d, "/api/inference/execute", {
						method: "POST",
						body: JSON.stringify({ provider: `unsupported-${suffix}`, prompt }),
					})
				).response.status,
			).toBe(400);
			expect(
				(
					await call(d, "/api/inference/execute", {
						method: "POST",
						body: JSON.stringify({
							prompt: "timeout",
							timeout_ms: 10,
							messages: [{ role: "user", content: "timeout" }],
						}),
					})
				).response.status,
			).toBe(503);
			expect(
				(
					await call(d, "/api/inference/execute", {
						method: "POST",
						body: JSON.stringify({ prompt: "upstream", messages: [{ role: "user", content: "upstream" }] }),
					})
				).response.status,
			).toBe(502);
			expect(
				(
					await call(d, "/api/inference/execute", {
						method: "POST",
						body: JSON.stringify({ prompt: "malformed", messages: [{ role: "user", content: "malformed" }] }),
					})
				).response.status,
			).toBe(502);
			expect(
				(await call(d, "/api/inference/explain", { method: "POST", body: JSON.stringify({ prompt }) })).response.status,
			).toBe(200);
			expect(
				(await call(d, "/api/inference/stream", { method: "POST", body: JSON.stringify({ prompt }) })).response.status,
			).toBe(400);
			expect((await call(d, "/api/inference/execute", { method: "POST", body: "{" })).response.status).toBe(400);
			expect(
				(
					await call(d, "/api/inference/execute", {
						method: "POST",
						body: JSON.stringify({ prompt: "x".repeat(65_537) }),
					})
				).response.status,
			).toBe(400);
			expect(
				(await call(d, "/api/inference/execute", { method: "POST", body: JSON.stringify({ messages: "not-array" }) }))
					.response.status,
			).toBe(400);

			const historyA = await call(d, "/api/inference/history");
			expect(historyA.response.status).toBe(200);
			expect(historyA.body.summary.total).toBeGreaterThan(0);
			const requestId = historyA.body.events.find((event: any) => event.request_id)?.request_id;
			expect(requestId).toBeString();
			expect((await call(d, `/api/inference/requests/${requestId}`, { method: "DELETE" })).response.status).toBe(200);
			expect(
				(await call(d, `/api/inference/requests/${requestId}`, { method: "DELETE" }, `agent-b-${suffix}`)).response
					.status,
			).toBe(404);
			expect((await call(d, "/api/inference/history", {}, `agent-b-${suffix}`)).body.events).toEqual([]);
			await stop(d);
			d = await daemon(workspace, p.origin);
			expect((await call(d, "/api/inference/history")).body.summary.total).toBeGreaterThan(0);
			const file = readFileSync(join(workspace, "inference/history.jsonl"), "utf8");
			expect(file).toContain("cancel_requested");
		} finally {
			if (d) await stop(d);
			p.close();
			rmSync(workspace, { recursive: true, force: true });
		}
	});
});
