/* biome-ignore-all lint/suspicious/noExplicitAny: native HTTP contract payloads */
import { expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const bin =
	// biome-ignore lint/suspicious/noUndeclaredEnvVars: test-only binary override
	process.env.SIGNET_RUST_DAEMON_BIN ?? join(process.cwd(), "platform/rust-daemon/target/debug/signet-daemon");
type D = { origin: string; child: ReturnType<typeof Bun.spawn>; root: string; stderr: string[] };
async function start(): Promise<D> {
	const root = mkdtempSync(join(tmpdir(), "signet-repair-parity-"));
	mkdirSync(join(root, ".daemon"), { recursive: true });
	writeFileSync(
		join(root, ".daemon", "auth-secret"),
		Uint8Array.from({ length: 32 }, (_, i) => i + 1),
	);
	const port = 39600 + Math.floor(Math.random() * 300);
	const stderr: string[] = [];
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
	for (let i = 0; i < 120; i++) {
		try {
			if ((await fetch(`${origin}/health/ready`)).ok) return { origin, child, root, stderr };
		} catch {}
		await Bun.sleep(25);
	}
	child.kill("SIGTERM");
	await child.exited;
	throw new Error(stderr.join(""));
}
async function req(d: D, path: string, init: RequestInit = {}) {
	const r = await fetch(d.origin + path, {
		...init,
		headers: {
			"x-signet-api-key": "repair-admin",
			"x-signet-agent": "repair-agent",
			"x-workspace-id": "repair-workspace",
			"content-type": "application/json",
			...init.headers,
		},
	});
	return { r, body: (await r.json()) as any };
}
it("requeues only scoped running jobs through the owner and reports cleanup", async () => {
	const d = await start();
	try {
		const submitted = await req(d, "/api/jobs", {
			method: "POST",
			body: JSON.stringify({ kind: "dreaming", payload: {} }),
		});
		expect(submitted.r.status).toBe(200);
		const id = submitted.body.id;
		const repaired = await req(d, "/api/repair/requeue-running", {
			method: "POST",
			body: JSON.stringify({ agentId: "repair-agent", workspaceId: "repair-workspace" }),
		});
		expect(repaired.r.status).toBe(200);
		expect(repaired.body).toMatchObject({
			action: "requeue_running",
			agentId: "repair-agent",
			workspaceId: "repair-workspace",
			requeued: 0,
		});
		const malformed = await req(d, "/api/repair/requeue-running", {
			method: "POST",
			headers: { "x-signet-agent-id": "other-agent" },
			body: JSON.stringify({ workspaceId: "repair-workspace" }),
		});
		expect(malformed.r.status).toBe(400);
		expect((await req(d, `/api/jobs/${id}?workspaceId=repair-workspace`)).r.status).toBe(200);
	} finally {
		d.child.kill("SIGTERM");
		expect(await d.child.exited).toBe(0);
		expect(d.stderr.join("")).not.toContain("repair-admin");
		rmSync(d.root, { recursive: true, force: true });
	}
});
