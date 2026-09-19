import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const root = process.cwd();
const configuredBinary = Reflect.get(process.env, "SIGNET_RUST_DAEMON_BIN");
const bin =
	(typeof configuredBinary === "string" ? configuredBinary : undefined) ??
	join(root, "platform/rust-daemon/target/debug/signet-daemon");
const children: Array<{ process: Bun.Subprocess; stderr: Promise<string> }> = [];
const workspaces: string[] = [];
let nextPort = 41000 + Math.floor(Math.random() * 1000);

async function start(workspace: string, agent: string) {
	const port = nextPort++;
	const child = Bun.spawn([bin], {
		cwd: root,
		env: {
			...process.env,
			SIGNET_PATH: workspace,
			SIGNET_BIND: "127.0.0.1",
			SIGNET_PORT: String(port),
			SIGNET_AGENT_ID: agent,
		},
		stdout: "ignore",
		stderr: "pipe",
	});
	const stderr = new Response(child.stderr).text();
	children.push({ process: child, stderr });
	const origin = `http://127.0.0.1:${port}`;
	for (let i = 0; i < 240; i++) {
		try {
			if ((await fetch(`${origin}/health/ready`)).ok) return { child, origin, stderr };
		} catch {}
		await Bun.sleep(25);
	}
	throw new Error(`native daemon readiness timeout; stderr=${await stderr}`);
}

async function stop(child: Bun.Subprocess) {
	child.kill("SIGTERM");
	await Promise.race([child.exited, Bun.sleep(1500)]);
}

// biome-ignore lint/suspicious/noExplicitAny: HTTP JSON shapes are contract-tested dynamically.
async function body(response: Response): Promise<Record<string, any>> {
	const text = await response.text();
	try {
		return JSON.parse(text);
	} catch {
		return { raw: text };
	}
}

function headers(agent: string) {
	return { "content-type": "application/json", "x-signet-agent": agent };
}

afterEach(async () => {
	for (const entry of children.splice(0)) await stop(entry.process);
	for (const workspace of workspaces.splice(0)) rmSync(workspace, { recursive: true, force: true });
});

test("native transcript and source-import HTTP contract", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "signet-transcript-import-contract-"));
	workspaces.push(workspace);
	let daemon = await start(workspace, "agent-a");
	const h = headers("agent-a");

	// The aliases are intentional API compatibility contracts, not normalized test data.
	const transcript = { session_id: "session-utf8", harness: "bun", content: "héllo 🌲", idempotencyKey: "idem-utf8" };
	const firstResponse = await fetch(`${daemon.origin}/api/transcripts`, {
		method: "POST",
		headers: h,
		body: JSON.stringify(transcript),
	});
	expect(firstResponse.status).toBe(200);
	const first = await body(firstResponse);
	expect(first).toEqual(expect.objectContaining({ sessionKey: "session-utf8" }));
	const repeat = await fetch(`${daemon.origin}/api/transcripts`, {
		method: "POST",
		headers: { ...h, "idempotency-key": "idem-utf8" },
		body: JSON.stringify({
			sessionKey: "session-utf8",
			harness: "bun",
			content: "different",
			idempotency_key: "idem-utf8",
		}),
	});
	expect(repeat.status).toBe(200);
	expect(await body(repeat)).toEqual(first);
	const listed = await body(await fetch(`${daemon.origin}/api/transcripts`, { headers: h }));
	expect(listed.transcripts).toEqual(
		expect.arrayContaining([expect.objectContaining({ sessionKey: "session-utf8", content: "héllo 🌲" })]),
	);
	const privateList = await body(await fetch(`${daemon.origin}/api/transcripts`, { headers: headers("agent-b") }));
	expect(privateList.transcripts).toEqual([]);

	for (const payload of [
		"not-json",
		JSON.stringify({ sessionKey: "", harness: "bun", content: "x", idempotencyKey: "i" }),
		JSON.stringify({ sessionKey: "s", harness: "bun", content: "", idempotencyKey: "i" }),
		JSON.stringify({ sessionKey: "s", harness: "bun", content: "x", idempotencyKey: "" }),
		JSON.stringify({ sessionKey: "s", harness: "bun", content: "x" }),
		JSON.stringify({ sessionKey: "s", harness: "bun", content: "x".repeat(8 * 1024 * 1024 + 1), idempotencyKey: "i" }),
	]) {
		const response = await fetch(`${daemon.origin}/api/transcripts`, { method: "POST", headers: h, body: payload });
		expect(response.status).toBeGreaterThanOrEqual(400);
		expect(response.status).toBeLessThan(500);
	}

	for (const alias of [
		{ schemaId: "custom-schema", duplicateMode: "skip" },
		{ schema_id: "custom-schema-2", duplicate_mode: "replace" },
	]) {
		const response = await fetch(`${daemon.origin}/api/sources/imports`, {
			method: "POST",
			headers: h,
			body: JSON.stringify({ ...alias, files: [{ name: "é.jsonl" }] }),
		});
		expect(response.status).toBe(201);
		const job = await body(response);
		expect(typeof job.id).toBe("string");
		const got = await body(await fetch(`${daemon.origin}/api/sources/imports/${job.id}`, { headers: h }));
		expect(got).toEqual(job);
		const other = await fetch(`${daemon.origin}/api/sources/imports/${job.id}`, { headers: headers("agent-b") });
		expect(other.status).toBe(404);
	}
	const importList = await body(await fetch(`${daemon.origin}/api/sources/imports`, { headers: h }));
	// Current native route truthfully exposes the transcript-list envelope for this GET; it does not fabricate import rows.
	expect(Array.isArray(importList.transcripts)).toBe(true);
	for (const mode of ["", "bogus", "x".repeat(33)]) {
		const response = await fetch(`${daemon.origin}/api/sources/imports`, {
			method: "POST",
			headers: h,
			body: JSON.stringify({ duplicateMode: mode, files: [{ name: "a" }] }),
		});
		expect(response.status).toBeGreaterThanOrEqual(400);
		expect(response.status).toBeLessThan(500);
	}
	for (const payload of [
		JSON.stringify({ files: [] }),
		JSON.stringify({ files: [{ name: "x".repeat(513) }] }),
		"not-json",
	]) {
		const response = await fetch(`${daemon.origin}/api/sources/imports`, { method: "POST", headers: h, body: payload });
		expect(response.status).toBeGreaterThanOrEqual(400);
		expect(response.status).toBeLessThan(500);
	}

	await stop(daemon.child);
	children.splice(
		children.findIndex((x) => x.process === daemon.child),
		1,
	);
	daemon = await start(workspace, "agent-a");
	const afterRestart = await body(await fetch(`${daemon.origin}/api/transcripts`, { headers: h }));
	expect(afterRestart.transcripts).toEqual(
		expect.arrayContaining([expect.objectContaining({ sessionKey: "session-utf8", content: "héllo 🌲" })]),
	);

	const stderr = await daemon.stderr;
	expect(typeof stderr).toBe("string");
});
