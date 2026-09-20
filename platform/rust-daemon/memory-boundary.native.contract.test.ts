import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
// biome-ignore lint/suspicious/noUndeclaredEnvVars: test-only binary override
const bin = process.env.SIGNET_RUST_DAEMON_BIN ?? join(root, "platform/rust-daemon/target/debug/signet-daemon");
const children: Bun.Subprocess[] = [];
const dirs: string[] = [];
const headers = { "content-type": "application/json", "x-signet-agent": "memory-contract-agent" };
async function start(path: string) {
	const port = 46000 + Math.floor(Math.random() * 10000);
	const child = Bun.spawn([bin], {
		cwd: root,
		env: {
			...process.env,
			SIGNET_PATH: path,
			SIGNET_BIND: "127.0.0.1",
			SIGNET_PORT: String(port),
			SIGNET_AGENT_ID: "memory-contract-agent",
		},
		stdout: "ignore",
		stderr: "pipe",
	});
	children.push(child);
	const origin = `http://127.0.0.1:${port}`;
	for (let i = 0; i < 240; i++) {
		try {
			if ((await fetch(`${origin}/health/ready`)).ok) return { child, origin };
		} catch {}
		await Bun.sleep(25);
	}
	throw new Error(`daemon readiness timeout: ${await new Response(child.stderr).text()}`);
}
afterEach(async () => {
	for (const child of children.splice(0)) child.kill("SIGTERM");
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("native memory boundary preserves mutation/readback scope and rejects semantic providers explicitly", async () => {
	const dir = mkdtempSync("/mnt/work/hermes-scratch/memory-contract-");
	dirs.push(dir);
	let daemon = await start(dir);
	const note = await fetch(`${daemon.origin}/api/memory/native-note`, {
		method: "POST",
		headers,
		body: JSON.stringify({ content: "bounded native memory", provenance: { source: "contract" } }),
	});
	expect(note.status).toBe(200);
	const created = (await note.json()) as { id: string; recorded: boolean };
	expect(created.recorded).toBe(true);
	const modified = await fetch(`${daemon.origin}/api/memory/modify/${created.id}`, {
		method: "POST",
		headers,
		body: JSON.stringify({ content: "updated native memory" }),
	});
	expect(modified.status).toBe(200);
	expect(await modified.json()).toMatchObject({ id: created.id, content: "updated native memory" });
	const feedback = await fetch(`${daemon.origin}/api/memory/feedback/${created.id}`, {
		method: "POST",
		headers,
		body: JSON.stringify({ rating: "positive", note: "useful" }),
	});
	expect(feedback.status).toBe(200);
	expect(await feedback.json()).toMatchObject({ recorded: 1, memoryId: created.id, rating: "positive" });
	const timeline = await fetch(`${daemon.origin}/api/memory/timeline/${created.id}`, { headers });
	expect(timeline.status).toBe(200);
	expect((await timeline.json()).items.length).toBeGreaterThanOrEqual(3);
	const unsupported = await fetch(`${daemon.origin}/api/memory/semantic-search`, {
		method: "POST",
		headers,
		body: JSON.stringify({ query: "native" }),
	});
	expect(unsupported.status).toBe(501);
	const tombstone = await fetch(`${daemon.origin}/api/memories/${created.id}/tombstone`, {
		method: "POST",
		headers,
		body: "{}",
	});
	expect(tombstone.status).toBe(200);
	daemon.child.kill("SIGTERM");
	await daemon.child.exited;
	daemon = await start(dir);
	expect((await fetch(`${daemon.origin}/api/memory/timeline/${created.id}`, { headers })).status).toBe(200);
});
