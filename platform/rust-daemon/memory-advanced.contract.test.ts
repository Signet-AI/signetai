import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = process.cwd();
const bin =
	process.env.SIGNET_RUST_DAEMON_BIN ??
	(existsSync(join(root, "target/debug/signet-daemon"))
		? join(root, "target/debug/signet-daemon")
		: join(root, "platform/rust-daemon/target/debug/signet-daemon"));
async function start(workspace: string, port: number) {
	const child = Bun.spawn([bin], {
		env: {
			...process.env,
			SIGNET_PATH: workspace,
			SIGNET_BIND: "127.0.0.1",
			SIGNET_PORT: String(port),
			SIGNET_AGENT_ID: "",
		},
		stdout: "ignore",
		stderr: "pipe",
	});
	const base = `http://127.0.0.1:${port}`;
	for (let i = 0; i < 200; i++) {
		try {
			if ((await fetch(`${base}/health/ready`)).ok) return { child, base };
		} catch {}
		await Bun.sleep(25);
	}
	child.kill();
	throw new Error("native daemon did not become ready");
}
async function stop(child: Bun.Subprocess) {
	child.kill("SIGTERM");
	await child.exited;
}

describe("fresh Rust advanced memory routes", () => {
	it("enforces scoped lifecycle, projections, persistence, and canonical supersession", async () => {
		if (!existsSync(bin)) throw new Error(`native daemon not found: ${bin}`);
		const workspace = mkdtempSync(join(tmpdir(), "signet-advanced-"));
		const port = 38991;
		let child: Bun.Subprocess | undefined;
		const headers = (agent: string) => ({ "content-type": "application/json", "x-signet-agent": agent });
		try {
			({ child } = await start(workspace, port));
			const base = `http://127.0.0.1:${port}`;
			const a = headers("agent-a"),
				b = headers("agent-b");
			const make = (h: HeadersInit, content: string) =>
				fetch(`${base}/api/memory/native-note`, { method: "POST", headers: h, body: JSON.stringify({ content }) });
			const first = await make(a, "first");
			expect(first.status).toBe(200);
			const firstId = (await first.json()).id as string;
			const second = await make(a, "second");
			expect(second.status).toBe(200);
			const secondId = (await second.json()).id as string;
			expect(
				(
					await fetch(`${base}/api/memory/feedback`, {
						method: "POST",
						headers: a,
						body: JSON.stringify({ memoryId: firstId, rating: "positive", note: "keep" }),
					})
				).status,
			).toBe(200);
			expect(
				(
					await fetch(`${base}/api/memory/modify`, {
						method: "POST",
						headers: a,
						body: JSON.stringify({ memoryId: firstId, content: "changed" }),
					})
				).status,
			).toBe(200);
			const supersede = await fetch(`${base}/api/memories/${firstId}/supersede`, {
				method: "POST",
				headers: a,
				body: JSON.stringify({ supersededBy: secondId, supersededReason: "newer" }),
			});
			expect(supersede.status).toBe(200);
			const superseded = await supersede.json();
			expect(superseded.supersededBy).toBe(secondId);
			expect(superseded.supersededAt).toBeString();
			expect(superseded.supersededReason).toBe("newer");
			const lineage = await fetch(`${base}/api/memory/${firstId}/lineage`, { headers: a });
			expect(lineage.status).toBe(200);
			expect((await lineage.json()).items.length).toBeGreaterThanOrEqual(3);
			const queue = await fetch(`${base}/api/memory/review-queue`, { headers: a });
			expect(queue.status).toBe(200);
			expect(Array.isArray((await queue.json()).items)).toBe(true);
			for (const url of [`${base}/api/memory/feedback`, `${base}/api/memory/forget`, `${base}/api/memory/modify`])
				expect((await fetch(url, { method: "POST", headers: a, body: "{}" })).status).toBeGreaterThanOrEqual(400);
			expect(
				(
					await fetch(`${base}/api/memory/feedback`, {
						method: "POST",
						headers: b,
						body: JSON.stringify({ memoryId: firstId, rating: "positive" }),
					})
				).status,
			).toBe(404);
			expect(
				(await fetch(`${base}/api/memories/not-an-id/tombstone`, { method: "POST", headers: a, body: "{}" })).status,
			).toBe(404);
			expect(
				(
					await fetch(`${base}/api/memories/${secondId}/tombstone`, {
						method: "POST",
						headers: a,
						body: JSON.stringify({ reason: "privacy" }),
					})
				).status,
			).toBe(200);
			await stop(child);
			child = undefined;
			({ child } = await start(workspace, port));
			expect((await fetch(`${base}/api/memory/${secondId}`, { headers: a })).status).toBe(404);
		} finally {
			if (child) await stop(child);
			rmSync(workspace, { recursive: true, force: true });
		}
	});
});
