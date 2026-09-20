import { expect, it } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

// biome-ignore lint/suspicious/noUndeclaredEnvVars: test-only binary override
const bin =
	process.env.SIGNET_RUST_DAEMON_BIN ?? join(process.cwd(), "platform/rust-daemon/target/debug/signet-daemon");
const token = "stream-admin";

it("streams bounded OpenAI SSE with auth, validation, and cleanup", async () => {
	const upstream = Bun.serve({
		port: 0,
		async fetch(req) {
			if (new URL(req.url).pathname !== "/v1/chat/completions") return new Response("missing", { status: 404 });
			const body = await req.json();
			if (body.stream !== true) return Response.json({ error: "stream required" }, { status: 400 });
			const encoder = new TextEncoder();
			const stream = new ReadableStream({
				start(controller) {
					for (const text of ["hello ", "world"])
						controller.enqueue(
							encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`),
						);
					controller.enqueue(encoder.encode("data: [DONE]\n\n"));
					controller.close();
				},
			});
			return new Response(stream, { headers: { "content-type": "text/event-stream" } });
		},
	});
	const workspace = mkdtempSync(join(tmpdir(), "signet-stream-"));
	const port = 40000 + Math.floor(Math.random() * 1000);
	const child = Bun.spawn([bin], {
		env: {
			...process.env,
			SIGNET_PATH: workspace,
			SIGNET_BIND: "127.0.0.1",
			SIGNET_PORT: String(port),
			SIGNET_API_KEY: token,
			SIGNET_OPENAI_BASE_URL: `http://127.0.0.1:${upstream.port}`,
			SIGNET_OPENAI_MODEL: "mock",
		},
		stdout: "ignore",
		stderr: "pipe",
	});
	const origin = `http://127.0.0.1:${port}`;
	try {
		for (let i = 0; i < 160; i++) {
			try {
				if ((await fetch(`${origin}/health/ready`)).ok) break;
			} catch {}
			await Bun.sleep(25);
		}
		const headers = {
			authorization: `Bearer ${token}`,
			"x-signet-agent": "agent-a",
			"content-type": "application/json",
		};
		const denied = await fetch(`${origin}/api/inference/stream`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ prompt: "x" }),
		});
		expect(denied.status).toBe(401);
		const response = await fetch(`${origin}/api/inference/stream`, {
			method: "POST",
			headers,
			body: JSON.stringify({ prompt: "x" }),
		});
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("text/event-stream");
		const text = await response.text();
		expect(text).toContain('"content":"hello "');
		expect(text).toContain('"content":"world"');
		expect(text).toContain("data: [DONE]");
		expect(
			(
				await fetch(`${origin}/api/inference/stream`, {
					method: "POST",
					headers,
					body: JSON.stringify({ prompt: "x", messages: "bad" }),
				})
			).status,
		).toBe(400);
	} finally {
		child.kill("SIGTERM");
		await child.exited;
		upstream.stop(true);
		rmSync(workspace, { recursive: true, force: true });
	}
});
