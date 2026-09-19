import { afterAll, beforeAll, describe, expect, test } from "bun:test";

const root = import.meta.dir;
const binary = `${root}/target/debug/signet-daemon`;
const workspace = `${root}/.telemetry-contract-${process.pid}`;
const port = 43000 + (process.pid % 1000);
let child: ReturnType<typeof Bun.spawn>;

async function waitFor(url: string) {
	for (let i = 0; i < 100; i++) {
		try {
			const response = await fetch(url);
			if (response.status > 0) return response;
		} catch {}
		await Bun.sleep(25);
	}
	throw new Error("daemon did not start");
}

describe("fresh Rust telemetry boundary", () => {
	beforeAll(async () => {
		child = Bun.spawn([binary], {
			cwd: root,
			env: {
				PATH: process.env.PATH ?? "",
				SIGNET_PATH: workspace,
				SIGNET_BIND: "127.0.0.1",
				SIGNET_PORT: String(port),
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		await waitFor(`http://127.0.0.1:${port}/health/live`);
	});
	afterAll(async () => {
		child.kill("SIGTERM");
		await child.exited;
		await Bun.$`rm -rf ${workspace}`;
	});
	test("denies unauthenticated telemetry and exposes no fabricated providers", async () => {
		const events = await fetch(`http://127.0.0.1:${port}/api/telemetry/events`);
		expect(events.status).toBe(401);
		const health = await fetch(`http://127.0.0.1:${port}/api/telemetry/health`);
		expect(health.status).toBe(401);
	});
});
