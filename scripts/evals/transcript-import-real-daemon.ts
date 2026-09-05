#!/usr/bin/env bun
/** Real-daemon acceptance eval for transcript import (#1814). */
import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdir, mkdtemp, readdir, readlink, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { ensureUnifiedSchema } from "../../platform/core/src/migration";
import { runMigrations } from "../../platform/core/src/migrations/index";
import { TRANSCRIPT_IMPORT_SUPPORTED_PLATFORMS } from "../../platform/daemon/src/transcript-import-safe-fs";

if (!(TRANSCRIPT_IMPORT_SUPPORTED_PLATFORMS as readonly string[]).includes(process.platform)) {
	console.log(
		JSON.stringify({
			skipped: true,
			code: "transcript_import_unsupported_platform",
			platform: process.platform,
			supportedPlatforms: TRANSCRIPT_IMPORT_SUPPORTED_PLATFORMS,
		}),
	);
	process.exit(0);
}

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
	for (let i = 0; i < 300; i++) {
		if (child.exitCode !== null) throw new Error(`daemon exited ${child.exitCode}: ${stderr.slice(-10).join("")}`);
		try {
			if ((await req("/health/live")).status === 200) return;
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
			HERMES_HOME: join(root, ".hermes"),
			XDG_CONFIG_HOME: join(root, ".config"),
			XDG_DATA_HOME: join(root, ".local", "share"),
			XDG_STATE_HOME: join(root, ".local", "state"),
			...env,
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	daemon.stdout?.on("data", (b) => stdout.push(String(b)));
	daemon.stderr?.on("data", (b) => stderr.push(String(b)));
	await waitLive(daemon);
}
async function stop(signal: NodeJS.Signals = "SIGKILL") {
	if (daemon && daemon.exitCode === null && daemon.signalCode === null) {
		daemon.kill(signal);
		for (let i = 0; i < 100 && daemon.exitCode === null && daemon.signalCode === null; i++) await Bun.sleep(50);
	}
}
async function waitForFailpoint(marker: string, expectedExit: number): Promise<void> {
	for (let i = 0; i < 1200; i++) {
		let seen = false;
		try {
			await access(join(root, ".daemon", marker));
			seen = true;
		} catch {
			// The process may exit immediately after creating the durable marker.
		}
		if (seen && daemon?.exitCode === expectedExit) return;
		if (daemon?.exitCode !== null && daemon?.exitCode !== expectedExit)
			throw new Error(`failpoint exited before marker: ${daemon?.exitCode}`);
		await Bun.sleep(100);
	}
	throw new Error(`failpoint marker/readback not observed: ${marker}`);
}
async function status(jobId: string) {
	return (await req(`/api/sources/imports/${jobId}?agentId=${agent}`)).body;
}
async function importFile(text: string, name: string) {
	const job = (
		await req(`/api/sources/imports?agentId=${agent}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ schemaId: "signet-export", files: [{ name }] }),
		})
	).body;
	const fileId = (job.files?.[0] as { id: string } | undefined)?.id;
	if (!fileId) throw new Error("import job did not reserve an upload file");
	const uploaded = await req(`/api/sources/imports/${job.jobId}/files/${fileId}?agentId=${agent}`, {
		method: "PUT",
		headers: { "content-type": "application/jsonl", "x-file-name": name },
		body: text,
	});
	record(uploaded.status === 201, `upload-${name}`, uploaded.body);
	record(
		(await req(`/api/sources/imports/${job.jobId}/start?agentId=${agent}`, { method: "POST" })).status === 200,
		`start-${name}`,
	);
	return { jobId: job.jobId, sourceId: uploaded.body.sourceId };
}
function dbRows(sql: string, params: unknown[] = []) {
	const db = new Database(join(root, "memory", "memories.db"), { readonly: true });
	try {
		// biome-ignore lint/suspicious/noExplicitAny: bun sqlite returns dynamic rows
		return db.query(sql).all(...params) as any[];
	} finally {
		db.close();
	}
}
function dbOne(sql: string, params: unknown[] = []) {
	return dbRows(sql, params)[0] ?? {};
}
async function waitCompleted(jobId: string) {
	for (let i = 0; i < 600; i++) {
		const j = await status(jobId);
		if (["completed", "completed_with_rejections", "cancelled"].includes(j.job.state)) return j;
		await Bun.sleep(100);
	}
	throw new Error(`job ${jobId} did not finish`);
}
async function waitForDatabaseOwnershipRelease(): Promise<void> {
	const dbPath = join(root, "memory", "memories.db");
	for (let i = 0; i < 200; i++) {
		const holders: string[] = [];
		for (const entry of await readdir("/proc")) {
			if (!/^\d+$/.test(entry)) continue;
			try {
				let ownsByOpenFile = false;
				for (const fd of await readdir(`/proc/${entry}/fd`)) {
					try {
						const target = await readlink(`/proc/${entry}/fd/${fd}`);
						if (target === dbPath || target === `${dbPath} (deleted)`) {
							ownsByOpenFile = true;
							break;
						}
					} catch {
						// The descriptor can close between enumeration and readback.
					}
				}
				if (ownsByOpenFile) holders.push(entry);
			} catch {
				// The process can exit between /proc enumeration and readback.
			}
		}
		if (holders.length === 0) return;
		await Bun.sleep(50);
	}
	throw new Error("database ownership was not released within 10 seconds");
}

try {
	await mkdir(join(root, ".daemon/logs"), { recursive: true });
	await mkdir(join(root, "memory"), { recursive: true });
	await writeFile(join(root, "agent.yaml"), "embedding:\n  provider: none\n");
	const setupDb = new Database(join(root, "memory", "memories.db"));
	try {
		ensureUnifiedSchema(setupDb as unknown as Parameters<typeof ensureUnifiedSchema>[0]);
		runMigrations(setupDb as unknown as Parameters<typeof runMigrations>[0]);
	} finally {
		setupDb.close();
	}
	await start({ SIGNET_TRANSCRIPT_IMPORT_FAILPOINT: "inventory" });
	const mixed = corpus(2200, "large").replaceAll("reply", "r".repeat(5000));
	record(Buffer.byteLength(mixed) > 10 * 1_048_576, "upload-exceeds-ordinary-body-limit");
	const first = await importFile(mixed, "large.jsonl");
	await waitForFailpoint("transcript-import-inventory-failpoint-fired", 87);
	record(daemon?.exitCode === 87, "kill-during-inventory", { exit: daemon?.exitCode });
	await waitForDatabaseOwnershipRelease();
	await start();
	const firstDone = await waitCompleted(first.jobId);
	record(firstDone.job.imported === 2200, "inventory-restart-imported", firstDone.job);
	record(firstDone.job.pending === 0, "inventory-restart-zero-pending");

	const replay = await importFile(mixed, "replay.jsonl");
	const replayDone = await waitCompleted(replay.jobId);
	record(replayDone.job.duplicate === 2200, "exact-replay-duplicates", replayDone.job);
	const invalid = `${[
		line({ id: "unknown-role", session_key: "bad-1", messages: [{ role: "wat", content: "x" }], message_count: 1 }),
		line({ id: "count-mismatch", session_key: "bad-2", message_count: 9 }),
		"{not-json}",
		"   ",
		"",
		line({ id: "blank-content", session_key: "bad-3", messages: [{ role: "user", content: "" }], message_count: 1 }),
		line({
			id: "oversize",
			session_key: "bad-4",
			messages: [{ role: "user", content: "x".repeat(4 * 1024 * 1024 + 1) }],
			message_count: 1,
		}),
	].join("\n")}\n`;
	const rejected = await importFile(invalid, "rejections.jsonl");
	const rejectedDone = await waitCompleted(rejected.jobId);
	record(rejectedDone.job.rejected === 5, "exact-rejection-count", rejectedDone.job);
	record(rejectedDone.job.pending === 0, "rejection-zero-pending", rejectedDone.job);

	await stop();
	await waitForDatabaseOwnershipRelease();
	await start({ SIGNET_TRANSCRIPT_IMPORT_FAILPOINT: "after-fs-before-db" });
	const crash = await importFile(corpus(40, "crash"), "crash.jsonl");
	await waitForFailpoint("transcript-import-failpoint-fired", 86);
	record(daemon?.exitCode === 86, "fs-before-db-failpoint", { exit: daemon?.exitCode, stderr: stderr.slice(-5) });
	await waitForDatabaseOwnershipRelease();
	await start();
	const crashDone = await waitCompleted(crash.jobId);
	record(crashDone.job.imported === 40, "fs-replay-imported", crashDone.job);
	const importedSessions = dbOne(
		"SELECT COUNT(*) count FROM session_transcripts WHERE agent_id = ? AND source_id IS NOT NULL",
		[agent],
	).count;
	const importedIds = dbOne(
		"SELECT COUNT(DISTINCT session_key) count FROM session_transcripts WHERE agent_id = ? AND source_id IS NOT NULL",
		[agent],
	).count;
	record(importedSessions === importedIds, "no-duplicate-session-record-ids", { importedSessions, importedIds });
	const foreign = dbOne("SELECT COUNT(*) count FROM session_transcripts WHERE agent_id = ?", [foreignAgent]).count;
	record(foreign === 0, "embedded-agent-does-not-escape-scope", foreign);
	const old = dbOne("SELECT COUNT(*) count FROM session_transcripts WHERE agent_id = ? AND created_at LIKE '2020-%'", [
		agent,
	]).count;
	record(old > 0, "historical-timestamps-preserved", old);
	const canonicalFiles = (await readdir(join(root, "transcripts"))).filter((n) => n.endsWith(".jsonl"));
	record(canonicalFiles.length >= 2, "canonical-harness-files", canonicalFiles);

	const reconciliation = await req(`/api/sources/imports/${first.jobId}/reconciliation?agentId=${agent}`);
	record(reconciliation.status === 200, "reconciliation-route", reconciliation.body);
	const reconRows = reconciliation.body.reconciliation ?? [];
	const totals = dbOne("SELECT COUNT(*) count FROM source_import_records WHERE job_id = ?", [first.jobId]).count;
	const terminal = dbOne(
		"SELECT COUNT(*) count FROM source_import_records WHERE job_id = ? AND status IN ('imported','duplicate','rejected')",
		[first.jobId],
	).count;
	record(totals === terminal, "exact-reconciliation-equation", { totals, terminal });
	const healthTimes: number[] = [];
	for (let i = 0; i < 20; i++) {
		const t = performance.now();
		record((await req("/health/live")).status === 200, `health-${i}`);
		healthTimes.push(performance.now() - t);
	}
	healthTimes.sort((a, b) => a - b);
	details.healthP95Ms = Math.round(healthTimes[Math.floor(healthTimes.length * 0.95)] ?? 0);
	record((details.healthP95Ms as number) < 500, "health-bounded", details.healthP95Ms);
	const pendingBefore = dbOne(
		"SELECT COUNT(*) count FROM source_import_records WHERE agent_id = ? AND status = 'pending'",
		[agent],
	).count;
	record(pendingBefore === 0, "zero-pending", pendingBefore);
	const sourceRowsBefore = dbOne(
		"SELECT COUNT(*) count FROM session_transcripts WHERE agent_id = ? AND source_id = ?",
		[agent, first.sourceId],
	).count;
	record(sourceRowsBefore > 0, "source-owned-session-rows", sourceRowsBefore);
	const removed = await req(`/api/sources/${encodeURIComponent(first.sourceId)}?agentId=${agent}`, {
		method: "DELETE",
	});
	record(removed.status === 200, "source-remove", removed.body);
	const after = dbOne("SELECT COUNT(*) count FROM session_transcripts WHERE agent_id = ? AND source_id = ?", [
		agent,
		first.sourceId,
	]).count;
	record(after === 0, "source-purge-session-rows", after);
	const tombstone = dbOne(
		"SELECT COUNT(*) count FROM source_import_record_attempts WHERE agent_id = ? AND source_id = ?",
		[agent, first.sourceId],
	).count;
	record(tombstone > 0, "audit-tombstones-retained", tombstone);
	details.jobs = [firstDone.job, replayDone.job, rejectedDone.job, crashDone.job];
	details.reconciliation = reconRows;
	const result = { verdict: "pass", checks, details, workspace: root, port };
	console.log(JSON.stringify(result, null, 2));
} catch (error) {
	const result = {
		verdict: "fail",
		error: error instanceof Error ? error.message : String(error),
		checks,
		details,
		workspace: root,
		port,
		stderr: stderr.slice(-20),
		stdout: stdout.slice(-20),
	};
	console.log(JSON.stringify(result, null, 2));
	process.exitCode = 1;
} finally {
	await stop("SIGTERM");
	await stop("SIGKILL");
	await rm(root, { recursive: true, force: true });
}
