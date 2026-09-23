import { existsSync, rmSync } from "node:fs";
const binary = process.env.SIGNET_RUST_DAEMON_BIN;
if (!binary || !existsSync(binary)) throw new Error("native Rust binary is required");
const workspace = (await Bun.$`mktemp -d`).text();
const path = (await workspace).trim();
const port = 39700;
const child = Bun.spawn([binary], {
	env: {
		HOME: path,
		PATH: "/usr/bin:/bin",
		SIGNET_MODE: "local",
		SIGNET_PATH: path,
		SIGNET_BIND: "127.0.0.1",
		SIGNET_PORT: String(port),
	},
	stdout: "ignore",
	stderr: "pipe",
});
const origin = `http://127.0.0.1:${port}`;
try {
	for (let i = 0; i < 100; i++) {
		try {
			if ((await fetch(`${origin}/health/ready`)).ok) break;
		} catch {}
		await Bun.sleep(100);
	}
	const response = await fetch(`${origin}/api/dream/status`, {
		headers: { "x-signet-agent": "memorybench", "x-workspace-id": "memorybench" },
	});
	if (!response.ok)
		throw new Error(`Rust Dreaming contract is not implemented: /api/dream/status returned ${response.status}`);
	const body = (await response.json()) as { native?: boolean; scope?: string; restart_persistent?: boolean };
	if (body.native !== true || body.scope !== "memorybench" || body.restart_persistent !== true)
		throw new Error("Dreaming contract is incomplete");
} finally {
	child.kill("SIGTERM");
	await child.exited;
	rmSync(path, { recursive: true, force: true });
}
