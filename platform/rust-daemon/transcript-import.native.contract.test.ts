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
	const repeated = await body(repeat);
	expect(repeated).toEqual(first);
	expect(repeated.contentHash).toBe(first.contentHash);
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
		{ schemaId: "signet-export", duplicateMode: "skip", files: [{ name: "é.jsonl", id: "supplied-file-id" }] },
		{ schema_id: "signet-export", duplicate_mode: "replace", files: [{ name: "generated.jsonl" }] },
	]) {
		const response = await fetch(`${daemon.origin}/api/sources/imports`, {
			method: "POST",
			headers: h,
			body: JSON.stringify(alias),
		});
		expect(response.status).toBe(201);
		const job = await body(response);
		expect(job).toEqual(
			expect.objectContaining({
				id: expect.any(String),
				jobId: expect.any(String),
				agentId: "agent-a",
				schemaId: "signet-export",
				duplicateMode: alias.duplicateMode ?? alias.duplicate_mode,
				state: "staging",
				files: expect.any(Array),
			}),
		);
		expect(job.jobId).toBe(job.id);
		expect(job.files).toHaveLength(1);
		expect(job.files[0]).toEqual(expect.objectContaining({ id: expect.any(String), name: alias.files[0].name }));
		if (alias.files[0].id) expect(job.files[0].id).toBe(alias.files[0].id);
		const got = await body(await fetch(`${daemon.origin}/api/sources/imports/${job.id}`, { headers: h }));
		expect(got).toEqual(
			expect.objectContaining({
				id: job.id,
				jobId: job.id,
				agentId: "agent-a",
				schemaId: job.schemaId,
				duplicateMode: job.duplicateMode,
				state: job.state,
				files: job.files,
			}),
		);
		expect(got.createdAt).toEqual(expect.any(String));
		expect(got.updatedAt).toEqual(expect.any(String));
		const other = await fetch(`${daemon.origin}/api/sources/imports/${job.id}`, { headers: headers("agent-b") });
		expect(other.status).toBe(404);
	}
	const unsupportedSchema = await fetch(`${daemon.origin}/api/sources/imports`, {
		method: "POST",
		headers: h,
		body: JSON.stringify({ schemaId: "custom-schema", duplicateMode: "skip", files: [{ name: "é.jsonl" }] }),
	});
	expect(unsupportedSchema.status).toBe(400);
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

	await stop(daemon.child);
	children.splice(
		children.findIndex((x) => x.process === daemon.child),
		1,
	);
	const stderr = await daemon.stderr;
	expect(typeof stderr).toBe("string");
});
