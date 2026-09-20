import { expect, test } from "bun:test";
import { spawn } from "node:child_process";

// biome-ignore lint/suspicious/noUndeclaredEnvVars: contract binary is supplied by the test runner
const binary = process.env.SIGNET_NATIVE_BIN;

test("native git config route is process reachable", async () => {
	if (!binary) throw new Error("SIGNET_NATIVE_BIN is required");
	const port = 39882;
	const workspace = `/tmp/signet-git-config-contract-${process.pid}`;
	const child = spawn(binary, [], {
		env: {
			...process.env,
			SIGNET_PATH: workspace,
			SIGNET_BIND: "127.0.0.1",
			SIGNET_PORT: String(port),
			SIGNET_API_KEY: "contract-key",
		},
	});
	try {
		for (let i = 0; i < 50; i++) {
			try {
				await fetch(`http://127.0.0.1:${port}/health/live`);
				break;
			} catch {
				await Bun.sleep(100);
			}
		}
		const response = await fetch(`http://127.0.0.1:${port}/api/git/config`, {
			headers: { "x-signet-api-key": "contract-key" },
		});
		expect(response.status).toBe(200);
		expect((await response.json()).remote).toBe("origin");
	} finally {
		child.kill("SIGTERM");
	}
});
