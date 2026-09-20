import { expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const bin = join(process.cwd(), "platform/rust-daemon/target/debug/signet-daemon");

it("serves the bounded static pipeline model registry", async () => {
	const dir = mkdtempSync(join(tmpdir(), "signet-pipeline-models-"));
	const port = 39400 + Math.floor(Math.random() * 100);
	const child = Bun.spawn([bin], {
		env: {
			...process.env,
			SIGNET_API_KEY: "pipeline-contract",
			SIGNET_PATH: dir,
			SIGNET_BIND: "127.0.0.1",
			SIGNET_PORT: String(port),
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	try {
		const origin = `http://127.0.0.1:${port}`;
		for (let i = 0; i < 100; i++) {
			try {
				if ((await fetch(`${origin}/health/ready`)).ok) break;
			} catch {}
			await Bun.sleep(25);
		}
		const auth = { Authorization: "Bearer pipeline-contract" };
		const denied = await fetch(`${origin}/api/pipeline/models`);
		expect(denied.status).toBe(401);
		const all = await fetch(`${origin}/api/pipeline/models?limit=100`, { headers: auth });
		const body = await all.json();
		expect(all.ok).toBe(true);
		expect(body.throttled).toBe(false);
		expect(body.models.length).toBeGreaterThan(20);
		expect(body.models[0]).toMatchObject({ id: "haiku", provider: "acpx", deprecated: false });
		const filtered = await fetch(`${origin}/api/pipeline/models?provider=codex&deprecated=false&limit=2`, {
			headers: auth,
		});
		const filteredBody = await filtered.json();
		expect(filteredBody.models).toHaveLength(2);
		expect(filteredBody.models.every((m: { provider: string }) => m.provider === "codex")).toBe(true);
		const grouped = await fetch(`${origin}/api/pipeline/models/by-provider?provider=anthropic`, { headers: auth });
		const groupedBody = await grouped.json();
		expect(Object.keys(groupedBody.models)).toEqual(["anthropic"]);
		expect(groupedBody.models.anthropic).toHaveLength(3);
		const refreshed = await fetch(`${origin}/api/pipeline/models/refresh`, { method: "POST", headers: auth });
		expect(refreshed.ok).toBe(true);
		expect((await refreshed.json()).throttled).toBe(false);
		expect((await fetch(`${origin}/api/pipeline/models?provider=unknown`, { headers: auth })).status).toBe(400);
		expect((await fetch(`${origin}/api/pipeline/models?limit=101`, { headers: auth })).status).toBe(400);
		expect((await fetch(`${origin}/api/pipeline/models?deprecated=wat`, { headers: auth })).status).toBe(400);
	} finally {
		child.kill();
		await child.exited;
	}
});
