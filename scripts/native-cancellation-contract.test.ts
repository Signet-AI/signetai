import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const binary = join(import.meta.dir, "../platform/rust-daemon/target/debug/signet-daemon");
async function start(workspace: string, port: number) {
	const proc = Bun.spawn([binary], {
		env: { ...process.env, SIGNET_PATH: workspace, SIGNET_PORT: String(port), SIGNET_MODE: "local" },
		stdout: "ignore",
		stderr: "pipe",
	});
	for (let i = 0; i < 80; i++) {
		try {
			if ((await fetch(`http://127.0.0.1:${port}/health/ready`)).ok) return proc;
		} catch {}
		await Bun.sleep(50);
	}
	proc.kill();
	throw new Error("native daemon did not start");
}
const call = (port: number, body: unknown, agent = "cancel-agent") =>
	fetch(`http://127.0.0.1:${port}/api/testing/cancellation`, {
		method: "POST",
		headers: { "content-type": "application/json", "x-signet-agent-id": agent },
		body: JSON.stringify(body),
	});

test("cancellation has durable unknown outcomes, fenced replay, and restart visibility", async () => {
	const workspace = await mkdtemp(join(tmpdir(), "signet-cancel-"));
	const port = 3967;
	let proc = await start(workspace, port);
	try {
		const begun = (await (
			await call(port, { action: "begin", operationId: "op-1", content: "durable" })
		).json()) as Record<string, unknown>;
		expect(begun).toMatchObject({ outcome: "committed", operationId: "op-1" });
		expect(
			((await (await call(port, { action: "cancel", operationId: "queued-op" })).json()) as Record<string, unknown>)
				.outcome,
		).toBe("cancelled");
		expect(
			(
				(await (
					await call(port, {
						action: "begin",
						operationId: "op-unknown",
						content: "uncertain",
						fault: "commit_before_reply",
					})
				).json()) as Record<string, unknown>
			).outcome,
		).toBe("unknown");
		expect(
			((await (await call(port, { action: "get", operationId: "op-unknown" })).json()) as Record<string, unknown>)
				.outcome,
		).toBe("unknown");
		proc.kill();
		await proc.exited;
		proc = await start(workspace, port);
		expect(await (await call(port, { action: "get", operationId: "op-1" })).json()).toMatchObject({
			outcome: "committed",
			content: "durable",
		});
		expect(await (await call(port, { action: "get", operationId: "op-unknown" })).json()).toMatchObject({
			outcome: "unknown",
		});
		expect(
			await (await call(port, { action: "begin", operationId: "op-2", content: "replacement" })).json(),
		).toMatchObject({ outcome: "committed" });
	} finally {
		proc.kill();
		await proc.exited.catch(() => {});
		await rm(workspace, { recursive: true, force: true });
	}
});
