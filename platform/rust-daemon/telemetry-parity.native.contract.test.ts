/* biome-ignore-all lint/suspicious/noExplicitAny: dynamic telemetry contract payloads */
import { afterEach, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = process.cwd();
// biome-ignore lint/suspicious/noUndeclaredEnvVars: test-only binary override
const binary = process.env.SIGNET_RUST_DAEMON_BIN ?? join(root, "platform/rust-daemon/target/debug/signet-daemon");
const daemons: Array<{ child: Bun.Subprocess; workspace: string; stderr: string[] }> = [];

async function start() {
	const workspace = mkdtempSync(join(tmpdir(), "signet-telemetry-contract-"));
	mkdirSync(join(workspace, ".daemon"), { recursive: true });
	writeFileSync(
		join(workspace, ".daemon", "auth-secret"),
		Uint8Array.from({ length: 32 }, (_, i) => i + 1),
	);
	const port = 41000 + Math.floor(Math.random() * 1000);
	const stderr: string[] = [];
	const child = Bun.spawn([binary], {
		cwd: root,
		env: {
			...process.env,
			SIGNET_PATH: workspace,
			SIGNET_BIND: "127.0.0.1",
			SIGNET_PORT: String(port),
			SIGNET_API_KEY: "telemetry-admin",
		},
		stdout: "ignore",
		stderr: "pipe",
	});
	daemons.push({ child, workspace, stderr });
	void (async () => {
		const reader = child.stderr.getReader();
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
			if ((await fetch(`${origin}/health/ready`)).ok) return { origin, stderr };
		} catch {}
		await Bun.sleep(25);
	}
	throw new Error(`telemetry daemon readiness failed: ${stderr.join("")}`);
}

afterEach(async () => {
	for (const daemon of daemons.splice(0)) {
		daemon.child.kill("SIGTERM");
		await Promise.race([daemon.child.exited, Bun.sleep(1000)]);
		if (!daemon.child.killed) daemon.child.kill("SIGKILL");
		rmSync(daemon.workspace, { recursive: true, force: true });
	}
});

it("returns the current telemetry events envelope through the native daemon", async () => {
	const daemon = await start();
	const response = await fetch(`${daemon.origin}/api/telemetry/events?agent_id=agent-a&workspace=workspace-a&limit=1`, {
		headers: { "x-signet-api-key": "telemetry-admin", "x-signet-agent": "agent-a" },
	});
	expect(response.status).toBe(200);
	expect(await response.json()).toEqual({
		events: [],
		nextCursor: null,
		limit: 1,
		complete: true,
		enabled: true,
	});
});

it("preserves telemetry auth, scope, and malformed-limit boundaries", async () => {
	const daemon = await start();
	expect((await fetch(`${daemon.origin}/api/telemetry/events?agent_id=agent-a&workspace=workspace-a`)).status).toBe(
		401,
	);
	expect(
		(
			await fetch(`${daemon.origin}/api/telemetry/events?agent_id=agent-a&workspace=workspace-a&limit=0`, {
				headers: { "x-signet-api-key": "telemetry-admin", "x-signet-agent": "agent-a" },
			})
		).status,
	).toBe(400);
	expect(
		(
			await fetch(`${daemon.origin}/api/telemetry/events?agent_id=agent-a&workspace=workspace-a&limit=10001`, {
				headers: { "x-signet-api-key": "telemetry-admin", "x-signet-agent": "agent-a" },
			})
		).status,
	).toBe(400);
});
