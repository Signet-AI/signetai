import { expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const binary =
	process.env.SIGNET_RUST_DAEMON_BIN ?? join(process.cwd(), "platform/rust-daemon/target/debug/signet-daemon");

it("accepts session event aliases, durably lists hook receipts, and rejects live streaming explicitly", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "signet-hooks-v3-"));
	const port = 39250 + Math.floor(Math.random() * 100);
	const child = Bun.spawn([binary], {
		env: { ...process.env, SIGNET_PATH: workspace, SIGNET_BIND: "127.0.0.1", SIGNET_PORT: String(port) },
		stdout: "ignore",
		stderr: "ignore",
	});
	const origin = `http://127.0.0.1:${port}`;
	const headers = { "content-type": "application/json", "x-signet-agent-id": "hooks-v3" };
	try {
		for (let i = 0; i < 120; i++) {
			try {
				if ((await fetch(`${origin}/health/ready`)).ok) break;
			} catch {}
			await Bun.sleep(25);
		}
		const start = await fetch(`${origin}/api/hooks/session_start`, {
			method: "POST",
			headers,
			body: JSON.stringify({ sessionId: "alias-session", harness: "bun" }),
		});
		expect(start.status).toBe(200);
		const receipt = await fetch(`${origin}/api/hooks/receipt`, {
			method: "POST",
			headers,
			body: JSON.stringify({
				receipt_id: "r1",
				hook: "UserPromptSubmit",
				session_id: "alias-session",
				payload: { text: "hello" },
			}),
		});
		expect(receipt.status).toBe(200);
		const listed = await fetch(`${origin}/api/hooks/events/alias-session`, {
			headers: { "x-signet-agent-id": "hooks-v3" },
		});
		expect(listed.status).toBe(200);
		expect(((await listed.json()) as { events: unknown[] }).events.length).toBeGreaterThan(0);
		const live = await fetch(`${origin}/api/boundary/events`, { headers: { "x-signet-agent-id": "hooks-v3" } });
		expect(live.status).toBe(501);
		expect((await live.json()) as { code: string }).toEqual(expect.objectContaining({ code: "unsupported" }));
	} finally {
		child.kill();
		await child.exited;
		rmSync(workspace, { recursive: true, force: true });
	}
});
