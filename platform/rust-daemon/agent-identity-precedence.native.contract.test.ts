import { expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const bin =
	// biome-ignore lint/suspicious/noUndeclaredEnvVars: test-only binary override
	process.env.SIGNET_RUST_DAEMON_BIN ?? join(process.cwd(), "platform/rust-daemon/target/debug/signet-daemon");
const secret = Uint8Array.from({ length: 32 }, (_, i) => (i * 37 + 11) & 0xff);
const admin = "fixture-admin-authority";

it("rejects conflicting agent aliases and preserves consistent workspace scope", async () => {
	if (!existsSync(bin)) throw new Error(`missing native daemon: ${bin}`);
	const workspace = mkdtempSync(join(tmpdir(), "signet-agent-identity-"));
	mkdirSync(join(workspace, ".daemon"), { recursive: true });
	writeFileSync(join(workspace, ".daemon", "auth-secret"), secret);
	const port = 39600 + Math.floor(Math.random() * 200);
	const { SIGNET_AGENT_ID: _ignoredAgent, ...environment } = process.env;
	const child = Bun.spawn([bin], {
		env: {
			...environment,
			SIGNET_PATH: workspace,
			SIGNET_BIND: "127.0.0.1",
			SIGNET_PORT: String(port),
			SIGNET_API_KEY: admin,
		},
		stdout: "ignore",
		stderr: "pipe",
	});
	const origin = `http://127.0.0.1:${port}`;
	try {
		let ready = false;
		for (let i = 0; i < 120; i++) {
			try {
				if ((await fetch(`${origin}/health/ready`)).ok) {
					ready = true;
					break;
				}
			} catch {}
			await Bun.sleep(25);
		}
		if (!ready) {
			const stderr = await new Response(child.stderr).text();
			throw new Error(`daemon readiness timeout: ${stderr}`);
		}
		const conflicting = await fetch(`${origin}/api/knowledge/entities?agent_id=agent-query&workspace_id=workspace-a`, {
			headers: {
				authorization: `Bearer ${admin}`,
				"x-signet-agent-id": "agent-header-id",
				"x-signet-agent": "agent-header",
			},
		});
		expect(conflicting.status).toBe(400);
		expect(await conflicting.text()).toContain("conflicting agent identities");

		const consistent = await fetch(
			`${origin}/api/knowledge/entities?agent_id=agent-consistent&workspace_id=workspace-a`,
			{
				headers: {
					authorization: `Bearer ${admin}`,
					"x-signet-agent-id": "agent-consistent",
					"x-signet-agent": "agent-consistent",
				},
			},
		);
		expect(consistent.status).toBe(200);
		expect(await consistent.json()).toEqual({ items: [], limit: 50, offset: 0 });
	} finally {
		child.kill("SIGTERM");
		const exited = await Promise.race([
			child.exited,
			new Promise<null>((resolve) => setTimeout(() => resolve(null), 1_000)),
		]);
		if (exited === null) {
			child.kill("SIGKILL");
			await child.exited;
		}
		rmSync(workspace, { recursive: true, force: true });
	}
});
