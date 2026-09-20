import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
// biome-ignore lint/suspicious/noUndeclaredEnvVars: test-only binary override
const bin = process.env.SIGNET_RUST_DAEMON_BIN ?? join(root, "platform/rust-daemon/target/debug/signet-daemon");
const children: Bun.Subprocess[] = [];
const dirs: string[] = [];
const headers = { "content-type": "application/json", "x-signet-agent": "semantic-contract-agent" };
async function start(path: string) {
	const port = 47000 + Math.floor(Math.random() * 1000);
	const child = Bun.spawn([bin], {
		cwd: root,
		env: {
			...process.env,
			SIGNET_PATH: path,
			SIGNET_BIND: "127.0.0.1",
			SIGNET_PORT: String(port),
			SIGNET_AGENT_ID: "semantic-contract-agent",
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
	for (const child of children.splice(0)) {
		child.kill("SIGTERM");
		await child.exited;
	}
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("semantic search is bounded, agent-scoped, durable, and rejects malformed queries", async () => {
	const dir = mkdtempSync("/mnt/work/hermes-scratch/semantic-search-");
	dirs.push(dir);
	let daemon = await start(dir);
	const save = await fetch(`${daemon.origin}/api/memory/native-note`, {
		method: "POST",
		headers,
		body: JSON.stringify({ content: "native semantic parity needle" }),
	});
	expect(save.status).toBe(200);
	const id = (await save.json()).id as string;
	const found = await fetch(`${daemon.origin}/api/memory/semantic-search`, {
		method: "POST",
		headers,
		body: JSON.stringify({ query: "semantic parity", limit: 1 }),
	});
	expect(found.status).toBe(200);
	expect(await found.json()).toMatchObject({ query: "semantic parity", method: "keyword", meta: { totalReturned: 1 } });
	const empty = await fetch(`${daemon.origin}/api/memory/semantic-search`, {
		method: "POST",
		headers,
		body: JSON.stringify({ query: "   " }),
	});
	expect(empty.status).toBe(400);
	const oversized = await fetch(`${daemon.origin}/api/memory/semantic-search`, {
		method: "POST",
		headers,
		body: JSON.stringify({ query: "needle", limit: 101 }),
	});
	expect(oversized.status).toBe(400);
	const other = await fetch(`${daemon.origin}/api/memory/semantic-search`, {
		method: "POST",
		headers: { ...headers, "x-signet-agent": "other-agent" },
		body: JSON.stringify({ query: "needle" }),
	});
	expect(other.status).toBe(200);
	expect((await other.json()).meta.totalReturned).toBe(0);
	daemon.child.kill("SIGTERM");
	await daemon.child.exited;
	daemon = await start(dir);
	const afterRestart = await fetch(`${daemon.origin}/api/memory/semantic-search`, {
		method: "POST",
		headers,
		body: JSON.stringify({ query: "needle" }),
	});
	expect(afterRestart.status).toBe(200);
	expect((await afterRestart.json()).results.some((row: { id: string }) => row.id === id)).toBe(true);
});
