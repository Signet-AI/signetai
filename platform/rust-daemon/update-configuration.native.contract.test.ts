import { expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const bin = join(process.cwd(), "platform/rust-daemon/target/debug/signet-daemon");

it("matches the authenticated bounded update configuration contract", async () => {
	const dir = mkdtempSync(join(tmpdir(), "signet-update-contract-"));
	const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
	const port = probe.port;
	probe.stop();
	const child = Bun.spawn([bin], {
		env: {
			...process.env,
			SIGNET_PATH: dir,
			SIGNET_BIND: "127.0.0.1",
			SIGNET_PORT: String(port),
			SIGNET_API_KEY: "update-contract-key",
		},
		stdout: "ignore",
		stderr: "pipe",
	});
	const origin = `http://127.0.0.1:${port}`;
	const headers = { authorization: "Bearer update-contract-key" };
	const write = (body: unknown) =>
		fetch(`${origin}/api/update/config`, {
			method: "POST",
			headers: { ...headers, "content-type": "application/json" },
			body: JSON.stringify(body),
		});
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
		const initial = await fetch(`${origin}/api/update/config`, { headers });
		expect(initial.status).toBe(200);
		expect(await initial.json()).toMatchObject({
			autoInstall: false,
			checkInterval: 21600,
			channel: "stable",
			minInterval: 300,
			maxInterval: 604800,
		});

		const saved = await write({ auto_install: true, check_interval: 600, channel: "next" });
		expect(saved.status).toBe(200);
		expect((await saved.json()).config).toMatchObject({ autoInstall: true, checkInterval: 600, channel: "nightly" });
		expect(readFileSync(join(dir, "agent.yaml"), "utf8")).toContain("channel: nightly");
		expect((await (await fetch(`${origin}/api/update/config`, { headers })).json()).channel).toBe("nightly");

		for (const [channel, canonical] of [
			["latest", "stable"],
			["next", "nightly"],
		] as const) {
			const response = await write({ channel });
			expect(response.status).toBe(200);
			expect((await response.json()).config.channel).toBe(canonical);
		}
		for (const body of [
			{ checkInterval: 299 },
			{ check_interval: 604801 },
			{ checkInterval: "not-a-number" },
			{ channel: "beta" },
			{ autoInstall: "maybe" },
		]) {
			expect((await write(body)).status).toBe(400);
		}
		const malformed = await fetch(`${origin}/api/update/config`, {
			method: "POST",
			headers: { ...headers, "content-type": "application/json" },
			body: "{",
		});
		expect([400, 422]).toContain(malformed.status);

		const check = await fetch(`${origin}/api/update/check`, { headers });
		expect(check.status).toBe(501);
		expect(await check.json()).toMatchObject({
			errorCode: "unsupported",
			operation: "update check",
			restartRequired: false,
		});
		const run = await fetch(`${origin}/api/update/run`, { method: "POST", headers });
		expect(run.status).toBe(501);
		expect(await run.json()).toMatchObject({
			errorCode: "unsupported",
			operation: "package update",
			restartRequired: false,
		});
	} finally {
		child.kill("SIGTERM");
		await Promise.race([child.exited, Bun.sleep(1000).then(() => child.kill("SIGKILL"))]);
		if (child.stderr) await new Response(child.stderr).text();
		rmSync(dir, { recursive: true, force: true });
	}
});
