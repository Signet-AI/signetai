import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "../..");
const configuredBinary = Reflect.get(process.env, "SIGNET_RUST_DAEMON_BIN");
const bin =
	(typeof configuredBinary === "string" ? configuredBinary : undefined) ??
	join(root, "platform/rust-daemon/target/debug/signet-daemon");
const children: Bun.Subprocess[] = [];
const dirs: string[] = [];
const headers = { "content-type": "application/json", "x-signet-agent": "memory-contract-agent" };

async function stop(child: Bun.Subprocess): Promise<void> {
	if (child.exitCode !== null) return;
	child.kill("SIGTERM");
	if (await Promise.race([child.exited.then(() => true), Bun.sleep(1_000).then(() => false)])) return;
	child.kill("SIGKILL");
	await Promise.race([child.exited, Bun.sleep(1_000)]);
}
async function start(path: string) {
	expect(existsSync(bin)).toBe(true);
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
	const stderr = new Response(child.stderr).text();
	for (let i = 0; i < 240; i++) {
		if (child.exitCode !== null) break;
		try {
			if ((await fetch(`${origin}/health/ready`)).ok) return { child, origin };
		} catch {}
		await Bun.sleep(25);
	}
	await stop(child);
	throw new Error(`daemon readiness timeout: ${await stderr}`);
}

afterEach(async () => {
	for (const child of children.splice(0)) await stop(child);
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("native memory boundary preserves mutation/readback scope and supports bounded keyword search", async () => {
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
	const search = await fetch(`${daemon.origin}/api/memory/semantic-search`, {
		method: "POST",
		headers,
		body: JSON.stringify({ query: "native", limit: 10 }),
	});
	expect(search.status).toBe(200);
	const searchBody = await search.json();
	expect(searchBody).toMatchObject({ query: "native", method: "keyword" });
	expect(searchBody.results.some((item: { id: string }) => item.id === created.id)).toBe(true);
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
