import { expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const bin = join(process.cwd(), "platform/rust-daemon/target/debug/signet-daemon");

it("serves reflection list and today envelopes", async () => {
	const dir = mkdtempSync(join(tmpdir(), "signet-reflections-contract-"));
	const port = 39280 + Math.floor(Math.random() * 100);
	const child = Bun.spawn([bin], {
		env: { ...process.env, SIGNET_PATH: dir, SIGNET_BIND: "127.0.0.1", SIGNET_PORT: String(port) },
		stdout: "ignore",
		stderr: "pipe",
	});
	try {
		const origin = `http://127.0.0.1:${port}`;
		for (let i = 0; i < 100; i++) {
			try {
				if ((await fetch(`${origin}/health/ready`)).ok) break;
			} catch {
				/* starting */
			}
			await Bun.sleep(25);
		}
		const headers = { "x-signet-agent-id": "reflection-contract" };
		const list = await fetch(`${origin}/api/reflections?limit=1`, { headers });
		expect(list.status).toBe(200);
		expect(await list.json()).toEqual({ reflections: [] });
		const today = await fetch(`${origin}/api/reflections/today`, { headers });
		expect(today.status).toBe(200);
		expect(await today.json()).toMatchObject({ reflection: null, reflections: [] });
	} finally {
		child.kill();
		await child.exited;
	}
});
