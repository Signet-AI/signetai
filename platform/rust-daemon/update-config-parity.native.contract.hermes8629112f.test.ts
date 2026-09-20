import { expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const bin = join(process.cwd(), "platform/rust-daemon/target/debug/signet-daemon");

it("serves authenticated bounded update config parity and leaves discovery unsupported", async () => {
	const dir = mkdtempSync(join(tmpdir(), "signet-update-parity-"));
	const port = 41000 + Math.floor(Math.random() * 1000);
	const child = Bun.spawn([bin], {
		env: {
			...process.env,
			SIGNET_PATH: dir,
			SIGNET_BIND: "127.0.0.1",
			SIGNET_PORT: String(port),
			SIGNET_API_KEY: "update-parity-key",
		},
		stdout: "ignore",
		stderr: "pipe",
	});
	const origin = `http://127.0.0.1:${port}`;
	const auth = { authorization: "Bearer update-parity-key" };
	try {
		for (let i = 0; i < 120; i++) {
			try {
				if ((await fetch(`${origin}/health/ready`)).ok) break;
			} catch {
				/* starting */
			}
			await Bun.sleep(25);
		}
		expect((await fetch(`${origin}/api/update/config`)).status).toBe(401);
		const initial = await fetch(`${origin}/api/update/config`, { headers: auth });
		expect(initial.status).toBe(200);
		expect(await initial.json()).toMatchObject({
			autoInstall: false,
			checkInterval: 21600,
			channel: "stable",
			minInterval: 300,
			maxInterval: 604800,
		});
		const saved = await fetch(`${origin}/api/update/config`, {
			method: "POST",
			headers: { ...auth, "content-type": "application/json" },
			body: JSON.stringify({ auto_install: true, check_interval: 600, channel: "next" }),
		});
		expect(saved.status).toBe(200);
		expect((await saved.json()).config).toMatchObject({ autoInstall: true, checkInterval: 600, channel: "nightly" });
		expect(readFileSync(join(dir, "agent.yaml"), "utf8")).toContain("channel: nightly");
		for (const body of [
			{ checkInterval: 299 },
			{ check_interval: 604801 },
			{ channel: "beta" },
			{ autoInstall: "maybe" },
		]) {
			const response = await fetch(`${origin}/api/update/config`, {
				method: "POST",
				headers: { ...auth, "content-type": "application/json" },
				body: JSON.stringify(body),
			});
			expect(response.status).toBe(400);
		}
		const malformed = await fetch(`${origin}/api/update/config`, {
			method: "POST",
			headers: { ...auth, "content-type": "application/json" },
			body: "{",
		});
		expect([400, 422]).toContain(malformed.status);
		const check = await fetch(`${origin}/api/update/check`, { headers: auth });
		expect(check.status).toBe(501);
		expect(await check.json()).toMatchObject({ success: false, errorCode: "unsupported", operation: "update check" });
	} finally {
		child.kill("SIGTERM");
		await Promise.race([child.exited, Bun.sleep(1000).then(() => child.kill("SIGKILL"))]);
		if (child.stderr) await new Response(child.stderr).text();
		rmSync(dir, { recursive: true, force: true });
	}
});
