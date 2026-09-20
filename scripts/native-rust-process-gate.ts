import { existsSync, rmSync } from "node:fs";
const binary = process.env.SIGNET_RUST_DAEMON_BIN;
if (!binary || !existsSync(binary))
	throw new Error("SIGNET_RUST_DAEMON_BIN is required; refusing TypeScript/source fallback");
const workspace = await Bun.$`mktemp -d`.text();
const port = 38680 + Math.floor(Math.random() * 1000);
const env = {
	HOME: workspace.trim(),
	PATH: "/usr/bin:/bin",
	SIGNET_PATH: workspace.trim(),
	SIGNET_BIND: "127.0.0.1",
	SIGNET_PORT: String(port),
	SIGNET_API_KEY: "",
};
const child = Bun.spawn([binary], { env, stdout: "ignore", stderr: "pipe" });
const origin = `http://127.0.0.1:${port}`;
try {
	for (let i = 0; i < 120; i++) {
		try {
			if ((await fetch(`${origin}/health/ready`)).ok) break;
		} catch {}
		await Bun.sleep(100);
		if (child.exitCode !== null) throw new Error(`native process exited ${child.exitCode}`);
	}
	if (!(await fetch(`${origin}/health/live`)).ok) throw new Error("native liveness failed");
	if (process.platform === "linux") {
		const before = Number((await Bun.file(`/proc/${child.pid}/stat`).text()).split(" ")[13]);
		await Bun.sleep(1000);
		const after = Number((await Bun.file(`/proc/${child.pid}/stat`).text()).split(" ")[13]);
		if (after - before > 20) throw new Error(`idle CPU exceeded gate: ${after - before} ticks`);
	}
} finally {
	child.kill("SIGTERM");
	await child.exited;
	rmSync(workspace.trim(), { recursive: true, force: true });
}
