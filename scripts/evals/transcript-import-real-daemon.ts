#!/usr/bin/env bun
/** Real-daemon acceptance eval for transcript import (#1814). */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { ensureUnifiedSchema } from "../../platform/core/src/migration";
import { runMigrations } from "../../platform/core/src/migrations/index";
import { createHash } from "node:crypto";

const root = await mkdtemp(join(tmpdir(), "signet-transcript-import-eval-"));
const port = 43000 + Math.floor(Math.random() * 1000);
const origin = `http://127.0.0.1:${port}`;
const agent = "eval-target-agent";
const foreignAgent = "embedded-foreign-agent";
const daemonScript = join(import.meta.dir, "../../platform/daemon/src/daemon.ts");
let daemon: ChildProcess | undefined;
const stdout: string[] = [],
	stderr: string[] = [];
const checks: Record<string, boolean> = {};
const details: Record<string, unknown> = {};

function record(ok: boolean, name: string, detail?: unknown) {
	checks[name] = ok;
	console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
	if (detail !== undefined) details[name] = detail;
	if (!ok) throw new Error(name);
}
function line(
	input: Partial<Record<string, unknown>> & {
		id: string;
		session_key: string;
		agent_id?: string;
		messages?: unknown[];
	},
) {
	const messages = input.messages ?? [
		{ role: "user", content: `  exact ${input.id}\nmultiline  ` },
		{ role: "assistant", content: "reply" },
	];
	return JSON.stringify({
		source: "signet",
		harness: input.harness ?? "claude",
		agent_id: input.agent_id ?? foreignAgent,
		session_key: input.session_key,
		project: input.project ?? "project-a",
		timestamp: input.timestamp ?? "2020-01-01T00:00:00.000Z",
		message_count: input.message_count ?? messages.length,
		messages,
		id: input.id,
	});
}
function corpus(count: number, prefix: string) {
	const rows: string[] = [];
	for (let i = 0; i < count; i++)
		rows.push(
			line({
				id: `${prefix}-${i}`,
				session_key: `${prefix}-session-${i}`,
				harness: i % 2 ? "codex" : "claude",
				project: i % 3 ? "project-a" : null,
				agent_id: i % 5 === 0 ? foreignAgent : `${foreignAgent}-${i}`,
			}),
		);
	return `${rows.join("\n")}\n`;
}
async function req(path: string, init?: RequestInit) {
	const r = await fetch(origin + path, { ...init, signal: AbortSignal.timeout(5000) });
	const text = await r.text();
	// biome-ignore lint/suspicious/noExplicitAny: dynamic daemon JSON envelope
	let body: any;
	try {
		body = JSON.parse(text);
	} catch {
		body = text;
	}
	return { status: r.status, body };
}
async function waitLive(child: ChildProcess) {
	const deadline = Date.now() + 30_000;
	for (; Date.now() < deadline; ) {
		if (child.exitCode !== null) throw new Error(`daemon exited ${child.exitCode}: ${stderr.slice(-10).join("")}`);
		try {
			if ((await fetch(`${origin}/health/live`, { signal: AbortSignal.timeout(1000) })).status === 200) return;
		} catch {}
		await Bun.sleep(100);
	}
	throw new Error("daemon did not become live");
}
async function start(env: Record<string, string> = {}) {
	daemon = spawn(process.execPath, [daemonScript], {
		cwd: join(import.meta.dir, "../.."),
		env: {
			...process.env,
			SIGNET_PATH: root,
			SIGNET_PORT: String(port),
			SIGNET_HOST: "127.0.0.1",
			SIGNET_BIND: "127.0.0.1",
			SIGNET_TELEMETRY_OPTOUT: "1",
			SIGNET_DAEMON_ENTRYPOINT: "1",
			SIGNET_AGENT_ID: agent,
			// Keep native watcher discovery inside this eval workspace. The daemon's
			// production defaults intentionally inspect the user's configured homes;
			// inheriting the evaluator's HOME would contaminate agent/source counts.
			HOME: root,
			USERPROFILE: root,
			HERMES_HOME: join(root, ".hermes"),
			XDG_CONFIG_HOME: join(root, ".config"),
			XDG_DATA_HOME: join(root, ".local", "share"),
			XDG_STATE_HOME: join(root, ".local", "state"),
			...env,
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	daemon.stdout?.on("data", (b) => {
		stdout.push(String(b));
		if (stdout.length > 100) stdout.shift();
	});
	daemon.stderr?.on("data", (b) => {
		stderr.push(String(b));
		if (stderr.length > 100) stderr.shift();
	});
	await waitLive(daemon);
}
async function stop(signal: NodeJS.Signals = "SIGKILL") {
	if (daemon && daemon.exitCode === null && daemon.signalCode === null) {
		daemon.kill(signal);
		for (let i = 0; i < 100 && daemon.exitCode === null && daemon.signalCode === null; i++) await Bun.sleep(50);
	}
}
async function status(jobId: string) {
	return (await req(`/api/sources/imports/${jobId}?agentId=${agent}`)).body;
}
async function waitCompleted(jobId: string) {
	for (let i = 0; i < 600; i++) {
		const j = await status(jobId);
		if (["completed", "completed_with_rejections", "cancelled"].includes(j.job.state)) return j;
		await Bun.sleep(100);
	}
	throw new Error(`job ${jobId} did not finish`);
}

try {
	await mkdir(join(root, ".daemon/logs"), { recursive: true });
	await mkdir(join(root, "memory"), { recursive: true });
	await writeFile(join(root, "agent.yaml"), "embedding:\n  provider: none\n");
	const setup = new Database(join(root, "memory", "memories.db"));
	ensureUnifiedSchema(setup as unknown as Parameters<typeof ensureUnifiedSchema>[0]);
	runMigrations(setup as unknown as Parameters<typeof runMigrations>[0]);
	setup.close(true);
	await start();
	const data = Buffer.from(corpus(1100, "stream").replaceAll("reply", "r".repeat(10_000)));
	record(data.length > 10 * 1024 ** 2, "larger-than-ordinary-request-limit");
	const created = await req("/api/sources/imports", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ files: [{ name: "large.jsonl" }] }),
	});
	record(created.status === 201, "create-windows-import", created.body);
	const jobId = created.body.jobId,
		fileId = created.body.files[0].id;
	const url = `/api/sources/imports/${jobId}/files/${fileId}`;
	const upload = async (offset: number) => {
		const chunk = data.subarray(offset, offset + 1024 ** 2);
		const response = await req(url, {
			method: "PATCH",
			headers: {
				"upload-offset": String(offset),
				"upload-length": String(data.length),
				"upload-checksum": createHash("sha256").update(chunk).digest("hex"),
			},
			body: chunk,
		});
		record(response.status === 200, `chunk-${offset}`, response.body);
	};
	await upload(0);
	await stop();
	await Bun.sleep(500);
	await start();
	record((await status(jobId)).files[0].upload_offset === 1024 ** 2, "restart-retains-offset");
	await upload(0);
	let worstHealthMs = 0;
	for (let offset = 1024 ** 2; offset < data.length; offset += 1024 ** 2) {
		await upload(offset);
		const before = performance.now();
		record((await req("/health/live")).status === 200, "health-during-upload");
		worstHealthMs = Math.max(worstHealthMs, performance.now() - before);
	}
	const finalized = await req(`${url}/finalize`, { method: "POST" });
	record(finalized.status === 201, "seal", finalized.body);
	const raw = await fetch(`${origin}${url}/content`);
	const hash = createHash("sha256");
	if (!raw.body) throw new Error("missing raw export");
	for await (const bytes of raw.body) hash.update(bytes);
	record(hash.digest("hex") === createHash("sha256").update(data).digest("hex"), "raw-export-exact");
	await req(`/api/sources/imports/${jobId}/start`, { method: "POST" });
	const paused = await req(`/api/sources/imports/${jobId}/pause`, { method: "POST" });
	record(paused.status === 200, "pause");
	await req(`/api/sources/imports/${jobId}/resume`, { method: "POST" });
	const done = await waitCompleted(jobId);
	record(done.job.imported === 1100 && done.job.pending === 0, "bounded-import-complete", done.job);
	const exported = await fetch(`${origin}/api/sources/imports/export/transcripts?limit=2`);
	const exportedRows = (await exported.text())
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	record(
		exportedRows.length === 2 && exportedRows[0].messages[0].content.startsWith("  exact"),
		"lossless-conversation-export",
	);
	record((await req(`${url}/content?agentId=foreign`)).status === 403, "scope-denied");
	const deleted = await req(`/api/sources/${finalized.body.sourceId}`, { method: "DELETE" });
	record(deleted.status === 200, "windows-source-delete", deleted.body);
	record((await req(`${url}/content`)).status !== 200, "deleted-evidence-inaccessible");
	details.worstHealthMs = worstHealthMs;
	record(worstHealthMs < 2000, "responsive-health");
	console.log(JSON.stringify({ ok: true, platform: process.platform, checks, details }, null, 2));
} catch (error) {
	console.error(
		JSON.stringify(
			{ ok: false, error: String(error), checks, details, stderr: stderr.slice(-12), stdout: stdout.slice(-8) },
			null,
			2,
		),
	);
	process.exitCode = 1;
} finally {
	await stop("SIGTERM");
	if (daemon && daemon.exitCode === null && daemon.signalCode === null) await stop();
	for (let attempt = 0; ; attempt++) {
		try {
			await rm(root, { recursive: true, force: true });
			break;
		} catch (error) {
			if (attempt === 20) {
				console.error("Eval cleanup failed:", error);
				process.exitCode = 1;
				break;
			}
			await Bun.sleep(100);
		}
	}
}
