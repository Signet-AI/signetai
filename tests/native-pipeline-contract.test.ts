import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const binary = join(import.meta.dir, "../platform/rust-daemon/target/debug/signet-daemon");
async function start(workspace: string, port: number) {
	const proc = Bun.spawn([binary], {
		env: { ...process.env, SIGNET_PATH: workspace, SIGNET_PORT: String(port) },
		stdout: "ignore",
		stderr: "ignore",
	});
	for (let i = 0; i < 50; i++) {
		try {
			if ((await fetch(`http://127.0.0.1:${port}/health/ready`)).ok) return proc;
		} catch {}
		await Bun.sleep(50);
	}
	proc.kill();
	throw new Error("native daemon did not start");
}
const api = (port: number, path: string, agent: string, init: RequestInit = {}) =>
	fetch(`http://127.0.0.1:${port}${path}`, {
		...init,
		headers: { "content-type": "application/json", "x-signet-agent-id": agent, ...(init.headers ?? {}) },
	});

test("pipeline and dreaming state are durable and scoped", async () => {
	const workspace = await mkdtemp(join(tmpdir(), "signet-pipeline-"));
	const port = 3951;
	let proc = await start(workspace, port);
	try {
		expect((await api(port, "/api/pipeline/status", "a")).status).toBe(200);
		expect(await (await api(port, "/api/pipeline/pause", "a", { method: "POST" })).json()).toMatchObject({
			paused: true,
		});
		expect(await (await api(port, "/api/pipeline/status", "b")).json()).toMatchObject({ paused: false });
		expect((await api(port, "/api/dream/trigger", "a", { method: "POST", body: "{" })).status).toBe(400);
		expect(
			await (
				await api(port, "/api/dream/trigger", "b", { method: "POST", body: JSON.stringify({ reason: "test" }) })
			).json(),
		).toMatchObject({ state: "queued", agentId: "b" });
		proc.kill();
		await proc.exited;
		proc = await start(workspace, port);
		expect(await (await api(port, "/api/pipeline/status", "a")).json()).toMatchObject({ paused: true });
		expect(await (await api(port, "/api/dream/passes/active", "b")).json()).toMatchObject({
			agentId: "b",
			passes: [{ state: "queued" }],
		});
		expect((await api(port, "/api/dream/trigger", "b", { method: "POST", body: "{" })).status).toBe(400);
	} finally {
		proc.kill();
		await proc.exited.catch(() => {});
		await rm(workspace, { recursive: true, force: true });
	}
});
