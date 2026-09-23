/* biome-ignore-all lint/suspicious/noExplicitAny: native boundary JSON contract */
import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// biome-ignore lint/suspicious/noUndeclaredEnvVars: test-only binary override
const bin = process.env.SIGNET_RUST_DAEMON_BIN ?? join(import.meta.dir, "target/debug/signet-daemon");
const auth = "fixture-admin-authority";
async function start() {
	const workspace = mkdtempSync(join(tmpdir(), "signet-sessions-hooks-"));
	mkdirSync(join(workspace, ".daemon"), { recursive: true });
	const port = 39400 + Math.floor(Math.random() * 400);
	const child = Bun.spawn([bin], {
		cwd: workspace,
		env: {
			...process.env,
			SIGNET_PATH: workspace,
			SIGNET_BIND: "127.0.0.1",
			SIGNET_PORT: `${port}`,
			SIGNET_API_KEY: auth,
		},
		stdout: "ignore",
		stderr: "pipe",
	});
	const origin = `http://127.0.0.1:${port}`;
	for (let i = 0; i < 120; i++) {
		try {
			if ((await fetch(`${origin}/health/ready`)).ok) return { child, origin, workspace };
		} catch {}
		await Bun.sleep(25);
	}
	throw new Error("daemon did not become ready");
}
async function req(origin: string, path: string, init: RequestInit = {}, agent = "agent-a") {
	const response = await fetch(origin + path, {
		...init,
		headers: {
			authorization: `Bearer ${auth}`,
			"x-signet-agent": agent,
			"content-type": "application/json",
			...init.headers,
		},
	});
	const text = await response.text();
	let body: any = {};
	try {
		body = JSON.parse(text);
	} catch {}
	return { response, body, text };
}
describe("fresh Rust sessions/hooks boundary", () => {
	it("starts, lists, ends idempotently, persists receipts, isolates agents, and rejects unsupported streaming", async () => {
		if (!existsSync(bin)) throw new Error(`missing native daemon: ${bin}`);
		const d = await start();
		try {
			const started = await req(d.origin, "/api/sessions/start", {
				method: "POST",
				body: JSON.stringify({ sessionKey: "contract-session", harness: "bun" }),
			});
			expect(started.response.status).toBe(200);
			expect((await req(d.origin, "/api/sessions")).body.sessions.some((s: any) => s.key === "contract-session")).toBe(
				true,
			);
			const receipt = await req(d.origin, "/api/boundary/hooks/receipt", {
				method: "POST",
				body: JSON.stringify({
					receipt_id: "receipt-1",
					hook: "session-start",
					session_key: "contract-session",
					payload: { ok: true },
				}),
			});
			expect(receipt.response.status).toBe(200);
			expect((await req(d.origin, "/api/boundary/poll?session_key=contract-session")).body.data.receipts).toHaveLength(
				1,
			);
			expect((await req(d.origin, "/api/sessions", {}, "agent-b")).body.sessions).toEqual([]);
			expect((await req(d.origin, "/api/sessions/start", { method: "POST", body: "{" })).response.status).toBe(400);
			expect((await req(d.origin, "/api/boundary/events")).response.status).toBe(501);
			const ended = await req(d.origin, "/api/sessions/end", {
				method: "POST",
				body: JSON.stringify({ sessionKey: "contract-session" }),
			});
			expect(ended.response.status).toBe(200);
			const endedAgain = await req(d.origin, "/api/sessions/end", {
				method: "POST",
				body: JSON.stringify({ sessionKey: "contract-session" }),
			});
			expect(endedAgain.response.status).toBe(200);
		} finally {
			d.child.kill("SIGTERM");
			await d.child.exited;
			rmSync(d.workspace, { recursive: true, force: true });
		}
	});
});
