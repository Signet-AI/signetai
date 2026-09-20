/* biome-ignore-all lint/suspicious/noExplicitAny: native HTTP contract payloads */
import { expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const bin = Bun.env.SIGNET_RUST_DAEMON_BIN ?? join(process.cwd(), "platform/rust-daemon/target/debug/signet-daemon");

it("accepts established repair workspace aliases and rejects conflicts", async () => {
	const root = mkdtempSync(join(tmpdir(), "signet-repair-alias-"));
	mkdirSync(join(root, ".daemon"), { recursive: true });
	writeFileSync(
		join(root, ".daemon", "auth-secret"),
		Uint8Array.from({ length: 32 }, (_, i) => i + 1),
	);
	const port = 39800 + Math.floor(Math.random() * 100);
	const child = Bun.spawn([bin], {
		env: {
			...process.env,
			SIGNET_PATH: root,
			SIGNET_BIND: "127.0.0.1",
			SIGNET_PORT: String(port),
			SIGNET_API_KEY: "repair-admin",
		},
		stdout: "ignore",
		stderr: "pipe",
	});
	const stderr: string[] = [];
	const reader = child.stderr.getReader();
	void (async () => {
		const decoder = new TextDecoder();
		for (;;) {
			const n = await reader.read();
			if (n.done) break;
			stderr.push(decoder.decode(n.value));
		}
	})();
	const origin = `http://127.0.0.1:${port}`;
	try {
		for (let i = 0; i < 120; i++) {
			try {
				if ((await fetch(`${origin}/health/ready`)).ok) break;
			} catch {}
			await Bun.sleep(25);
		}
		const request = (headers: Record<string, string> = {}, body?: unknown) =>
			fetch(`${origin}/api/repair/requeue-running`, {
				method: "POST",
				headers: { "x-signet-api-key": "repair-admin", "x-signet-agent": "repair-agent", ...headers },
				...(body === undefined
					? {}
					: {
							body: JSON.stringify(body),
							headers: {
								"content-type": "application/json",
								"x-signet-api-key": "repair-admin",
								"x-signet-agent": "repair-agent",
								...headers,
							},
						}),
			});
		for (const headers of [{ "x-signet-workspace-id": "repair-workspace" }, { "x-workspace-id": "repair-workspace" }]) {
			expect((await request(headers)).status).toBe(200);
		}
		expect((await request({}, { workspaceId: "repair-workspace" })).status).toBe(200);
		expect((await request({}, { workspace_id: "repair-workspace" })).status).toBe(200);
		expect((await request({ "x-workspace-id": "one", "x-signet-workspace-id": "two" })).status).toBe(400);
		expect((await request({ "x-workspace-id": "one" }, { workspaceId: "two" })).status).toBe(400);
		expect(stderr.join("")).not.toContain("repair-admin");
	} finally {
		child.kill("SIGTERM");
		expect(await child.exited).toBe(0);
		rmSync(root, { recursive: true, force: true });
	}
});
