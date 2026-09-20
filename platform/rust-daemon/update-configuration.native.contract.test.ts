import { expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const bin = join(process.cwd(), "platform/rust-daemon/target/debug/signet-daemon");

it("exposes unsupported update lifecycle operations without mutating state", async () => {
	const dir = mkdtempSync(join(tmpdir(), "signet-update-contract-"));
	const port = 39280 + Math.floor(Math.random() * 100);
	const child = Bun.spawn([bin], {
		env: {
			...process.env,
			SIGNET_PATH: dir,
			SIGNET_BIND: "127.0.0.1",
			SIGNET_PORT: String(port),
			SIGNET_API_KEY: "update-contract-key",
		},
		stdout: "ignore",
		stderr: "ignore",
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
		const unauthorized = await fetch(`${origin}/api/update/config`);
		expect(unauthorized.status).toBe(401);
		const headers = { authorization: "Bearer update-contract-key" };
		const requests = [
			fetch(`${origin}/api/update/config`, { headers }),
			fetch(`${origin}/api/update/check`, { headers }),
			fetch(`${origin}/api/update/config`, {
				method: "POST",
				headers: { ...headers, "content-type": "application/json" },
				body: JSON.stringify({ autoInstall: true }),
			}),
			fetch(`${origin}/api/update/run`, { method: "POST", headers }),
		];
		const responses = await Promise.all(requests);
		for (const response of responses) {
			expect(response.status).toBe(501);
			expect(await response.json()).toMatchObject({ errorCode: "unsupported", restartRequired: false });
		}
	} finally {
		child.kill();
		await child.exited;
	}
});
