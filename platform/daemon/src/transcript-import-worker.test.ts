import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, mkdir, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	appendCanonical,
	startTranscriptImportWorker,
	purgeTranscriptImportFilesystem,
} from "./transcript-import-worker";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "./db-accessor";
import { createJob, createOwnerTranscriptImportStore } from "./transcript-import-store";
import type { ImportStore, ImportStoreOperation } from "./transcript-import-store";
import type { InventoryRecord } from "./transcript-import-inventory";

type TestRow = { id: string; source_id: string; status: string; [key: string]: unknown };
type TestCommit = { sourceId: string; sourceRecordId: string; canonicalId: string; canonicalKey: string };

const valid = (id: string) =>
	JSON.stringify({
		source: "signet",
		id,
		harness: "h",
		agent_id: "embedded",
		session_key: id,
		project: null,
		timestamp: "2024-01-01T00:00:00Z",
		message_count: 2,
		messages: [
			{ role: "system", content: " exact\n" },
			{ role: "user", content: ` ${id} ` },
		],
	});

test("worker inventories, rereads, appends canonical evidence, and is replay-safe", async () => {
	const root = await mkdtemp(join(tmpdir(), "signet-import-worker-"));
	const source = "source-a";
	await mkdir(join(root, "imports", "transcripts", source), { recursive: true });
	await writeFile(
		join(root, "imports", "transcripts", source, "source.jsonl"),
		`${valid("one")}\nnot-json\n${valid("two")}\n`,
	);
	const records: TestRow[] = [];
	let commitAttempts = 0;
	const store: ImportStore = {
		run: async <T>(op: ImportStoreOperation) => {
			if (op.operation === "list" && op.payload.view === "work") return [{ id: "job", state: "queued" }] as T;
			if (op.operation === "lease") return { id: "job", state: "running" } as T;
			if (op.operation === "list" && op.payload.view === "files")
				return [
					{
						id: "file",
						job_id: "job",
						source_id: source,
						managed_path: `imports/transcripts/${source}/source.jsonl`,
						checkpoint_byte_offset: 0,
						checkpoint_ordinal: 0,
						state: records.length ? "completed" : "ready",
					},
				] as T;
			if (op.operation === "record_batch") {
				for (const r of op.payload.records as InventoryRecord[])
					records.push({
						...r,
						id: `record-${r.ordinal}`,
						file_id: "file",
						job_id: "job",
						source_id: source,
						status: r.status,
					});
				return undefined as T;
			}
			if (op.operation === "list" && op.payload.view === "pending")
				return records.filter((r) => r.status === "pending") as T;
			if (op.operation === "commit") {
				commitAttempts++;
				if (commitAttempts === 1) throw new Error("injected crash after filesystem append");
				for (const c of op.payload.commits as TestCommit[]) {
					const r = records.find((x) => x.source_id === c.sourceId && x.status === "pending");
					if (r) r.status = "imported";
				}
				return (op.payload.commits as TestCommit[]).map((c) => ({
					outcome: "imported",
					canonicalId: c.canonicalId,
					sessionKey: c.canonicalKey,
				})) as T;
			}
			if (op.operation === "file_complete" || op.operation === "finalize" || op.operation === "recover")
				return undefined as T;
			if (op.operation === "reject") {
				const r = records.find((x) => x.id === op.payload.recordId);
				if (r) r.status = "rejected";
				return undefined as T;
			}
			return [] as T;
		},
	};
	try {
		const worker = startTranscriptImportWorker({ store, agentId: "agent-a", workspaceRoot: root, pollMs: 1 });
		await new Promise((resolve) => setTimeout(resolve, 40));
		await worker.stop();
		expect(records.filter((r) => r.status === "pending")).toHaveLength(0);
		expect(records.filter((r) => r.status === "rejected")).toHaveLength(1);
		const canonicalFiles = await readdir(join(root, "transcripts"));
		expect(canonicalFiles.filter((name) => name.endsWith(".jsonl"))).toHaveLength(1);
		const canonical = await (await import("node:fs/promises")).readFile(
			join(root, "transcripts", canonicalFiles.find((name) => name.endsWith(".jsonl")) as string),
			"utf8",
		);
		expect(canonical.trim().split("\n")).toHaveLength(2);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("canonical append removes a lock whose recorded owner process is gone", async () => {
	const root = await mkdtemp(join(tmpdir(), "signet-import-stale-lock-"));
	try {
		const { signetExportV1Adapter } = await import("./transcript-import-adapter");
		const { buildCompletedTranscriptCommit } = await import("./transcript-import-commit");
		const commit = buildCompletedTranscriptCommit(signetExportV1Adapter.parse(JSON.parse(valid("stale-lock"))), {
			agentId: "agent-a",
			sourceId: "source-a",
			sourceRecordId: "record-a",
		});
		const digest = (await import("node:crypto")).createHash("sha256").update("agent-a\0h").digest("hex").slice(0, 24);
		const lock = join(root, "transcripts", `${digest}.jsonl.lock`);
		await mkdir(lock, { recursive: true });
		await writeFile(join(lock, "owner"), "99999999\\n");
		await appendCanonical(root, "agent-a", "h", [commit]);
		expect(await readdir(join(root, "transcripts"))).toContain(`${digest}.jsonl`);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("owner store persists inventory and terminal counters in the migrated database", async () => {
	const root = await mkdtemp(join(tmpdir(), "signet-import-owner-"));
	const dbPath = join(root, "memory", "memories.db");
	await mkdir(join(root, "memory"), { recursive: true });
	const oldOwner = process.env.SIGNET_DB_OWNER_WORKER;
	process.env.SIGNET_DB_OWNER_WORKER = "1";
	closeDbAccessor();
	initDbAccessor(dbPath, { agentsDir: root });
	const agentId = "owner-agent";
	const jobId = "owner-job";
	const source = "owner-source";
	try {
		const store = createOwnerTranscriptImportStore();
		await createJob(store, { jobId, agentId });
		await getDbAccessor().withWriteTxAsync((db) => {
			db.prepare("UPDATE source_import_jobs SET state = 'queued' WHERE id = ? AND agent_id = ?").run(jobId, agentId);
		});
		await getDbAccessor().withWriteTxAsync((db) => {
			db.prepare(
				"INSERT INTO source_import_files (id, job_id, source_id, agent_id, ordinal, name, managed_path, state) VALUES (?, ?, ?, ?, 0, 'source.jsonl', ?, 'ready')",
			).run("owner-file", jobId, source, agentId, `imports/transcripts/${source}/source.jsonl`);
		});
		await mkdir(join(root, "imports", "transcripts", source), { recursive: true });
		await writeFile(join(root, "imports", "transcripts", source, "source.jsonl"), `${valid("owner")}\n`);
		const worker = startTranscriptImportWorker({ store, agentId, workspaceRoot: root, pollMs: 1 });
		await new Promise((resolve) => setTimeout(resolve, 100));
		await worker.stop();
		const state = await getDbAccessor().withReadDbAsync(
			(db) =>
				db
					.prepare("SELECT state, imported, pending FROM source_import_jobs WHERE id = ? AND agent_id = ?")
					.get(jobId, agentId) as { state: string; imported: number; pending: number },
		);
		const checkpoint = await getDbAccessor().withReadDbAsync(
			(db) =>
				db
					.prepare("SELECT checkpoint_ordinal, record_count FROM source_import_files WHERE id = ? AND agent_id = ?")
					.get("owner-file", agentId) as { checkpoint_ordinal: number; record_count: number },
		);
		expect(state).toEqual({ state: "completed", imported: 1, pending: 0 });
		expect(checkpoint).toEqual({ checkpoint_ordinal: 1, record_count: 1 });
	} finally {
		closeDbAccessor();
		if (oldOwner === undefined) Reflect.deleteProperty(process.env, "SIGNET_DB_OWNER_WORKER");
		else process.env.SIGNET_DB_OWNER_WORKER = oldOwner;
		await rm(root, { recursive: true, force: true });
	}
});

test("migrated DB crash recovery finalizes pending records after filesystem write without duplicate canonical evidence", async () => {
	const root = await mkdtemp(join(tmpdir(), "signet-import-fs-before-db-recovery-"));
	const dbPath = join(root, "memory", "memories.db");
	const oldOwner = process.env.SIGNET_DB_OWNER_WORKER;
	process.env.SIGNET_DB_OWNER_WORKER = "1";
	closeDbAccessor();
	await mkdir(join(root, "memory"), { recursive: true });
	initDbAccessor(dbPath, { agentsDir: root });
	const store = createOwnerTranscriptImportStore();
	const jobId = "crash-job";
	const fileId = "crash-file";
	const sourceId = "import:crash-source";
	const agentId = "crash-agent";
	const raw = valid("crash");
	try {
		await createJob(store, { jobId, agentId });
		await getDbAccessor().withWriteTxAsync((db) => {
			db.prepare(
				"UPDATE source_import_jobs SET state = 'running', total = 1, pending = 0, lease_token = 'stale', lease_expires_at = datetime('now','+5 minutes') WHERE id = ?",
			).run(jobId);
			db.prepare(
				"INSERT INTO source_import_files (id,job_id,source_id,agent_id,ordinal,name,managed_path,state,record_count,checkpoint_ordinal,checkpoint_byte_offset) VALUES (?,?,?,?,0,'crash.jsonl',?,'completed',1,1,?)",
			).run(
				fileId,
				jobId,
				sourceId,
				agentId,
				`imports/transcripts/${sourceId}/source.jsonl`,
				Buffer.byteLength(`${raw}\n`),
			);
			db.prepare(
				"INSERT INTO source_import_records (id,job_id,file_id,source_id,agent_id,ordinal,line_number,byte_offset,byte_length,raw_hash,status) VALUES (?,?,?,?,?,?,?,?,?,?, 'pending')",
			).run(`${jobId}:${fileId}:1`, jobId, fileId, sourceId, agentId, 1, 1, 0, Buffer.byteLength(raw), "raw-hash");
		});
		await mkdir(join(root, "imports", "transcripts", sourceId), { recursive: true });
		await writeFile(join(root, "imports", "transcripts", sourceId, "source.jsonl"), `${raw}\n`);
		const parsed = JSON.parse(raw);
		const { signetExportV1Adapter } = await import("./transcript-import-adapter");
		const { buildCompletedTranscriptCommit, canonicalTranscriptLine } = await import("./transcript-import-commit");
		const commit = buildCompletedTranscriptCommit(signetExportV1Adapter.parse(parsed), {
			agentId,
			sourceId,
			sourceRecordId: `${jobId}:${fileId}:1`,
			sourcePath: `imports/transcripts/${sourceId}/source.jsonl`,
		});
		await mkdir(join(root, "transcripts"), { recursive: true });
		await writeFile(join(root, "transcripts", "canonical.jsonl"), canonicalTranscriptLine(commit));
		const worker = startTranscriptImportWorker({ store, agentId, workspaceRoot: root, pollMs: 1 });
		await new Promise((resolve) => setTimeout(resolve, 100));
		await worker.stop();
		const state = await getDbAccessor().withReadDbAsync(
			(db) =>
				db.prepare("SELECT state, imported, pending, lease_token FROM source_import_jobs WHERE id = ?").get(jobId) as {
					state: string;
					imported: number;
					pending: number;
					lease_token: string | null;
				},
		);
		const counts = await getDbAccessor().withReadDbAsync(
			(db) =>
				db
					.prepare("SELECT status, COUNT(*) AS count FROM source_import_records WHERE job_id = ? GROUP BY status")
					.all(jobId) as Array<{ status: string; count: number }>,
		);
		const canonical = await (await import("node:fs/promises")).readFile(
			join(root, "transcripts", "canonical.jsonl"),
			"utf8",
		);
		expect(state).toEqual({ state: "completed", imported: 1, pending: 0, lease_token: null });
		expect(counts).toEqual([{ status: "imported", count: 1 }]);
		expect(canonical.trim().split("\n")).toHaveLength(1);
	} finally {
		closeDbAccessor();
		if (oldOwner === undefined) Reflect.deleteProperty(process.env, "SIGNET_DB_OWNER_WORKER");
		else process.env.SIGNET_DB_OWNER_WORKER = oldOwner;
		await rm(root, { recursive: true, force: true });
	}
});
test("filesystem purge removes only the selected agent source and staged data", async () => {
	const root = await mkdtemp(join(tmpdir(), "signet-import-purge-"));
	try {
		await mkdir(join(root, "imports", "transcripts", "source-a"), { recursive: true });
		await writeFile(join(root, "imports", "transcripts", "source-a", "source.jsonl"), "staged");
		await mkdir(join(root, "transcripts"), { recursive: true });
		await writeFile(
			join(root, "transcripts", "aggregate.jsonl"),
			`${[
				JSON.stringify({ id: "a", agent_id: "agent-a", source_id: "source-a" }),
				JSON.stringify({ id: "b", agent_id: "agent-b", source_id: "source-a" }),
				JSON.stringify({ id: "c", agent_id: "agent-a", source_id: "source-b" }),
			].join("\n")}\n`,
		);
		const outside = join(root, "escape-marker");
		await writeFile(outside, "keep");
		await purgeTranscriptImportFilesystem(root, "../../escape-marker");
		expect(await Bun.file(outside).exists()).toBe(true);
		await purgeTranscriptImportFilesystem(root, "source-a", "agent-a");
		expect(await readdir(join(root, "imports", "transcripts"))).toEqual([]);
		const aggregate = await (await import("node:fs/promises")).readFile(
			join(root, "transcripts", "aggregate.jsonl"),
			"utf8",
		);
		expect(aggregate).toContain('"id":"b"');
		expect(aggregate).not.toContain('"id":"a"');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("filesystem purge removes the ledger-reserved managed upload path", async () => {
	const root = await mkdtemp(join(tmpdir(), "signet-import-managed-purge-"));
	try {
		const managedPath = "imports/transcripts/job/file/source.jsonl";
		await mkdir(join(root, "imports", "transcripts", "job", "file"), { recursive: true });
		await writeFile(join(root, managedPath), "staged");
		await purgeTranscriptImportFilesystem(root, "import:job:file", "agent-a", [managedPath]);
		expect(await Bun.file(join(root, managedPath)).exists()).toBe(false);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("canonical purge waits for an in-flight append and removes its source without resurrection", async () => {
	const root = await mkdtemp(join(tmpdir(), "signet-import-purge-race-"));
	try {
		const { buildCompletedTranscriptCommit, canonicalTranscriptLine } = await import("./transcript-import-commit");
		const { signetExportV1Adapter } = await import("./transcript-import-adapter");
		const make = (id: string, sourceId: string) =>
			buildCompletedTranscriptCommit(signetExportV1Adapter.parse(JSON.parse(valid(id))), {
				agentId: "agent-a",
				sourceId,
				sourceRecordId: id,
			});
		const old = make("old", "source-a");
		const next = make("next", "source-a");
		const keep = make("keep", "source-b");
		const digest = (await import("node:crypto")).createHash("sha256").update("agent-a\0h").digest("hex").slice(0, 24);
		const canonicalPath = join(root, "transcripts", `${digest}.jsonl`);
		await mkdir(join(root, "transcripts"), { recursive: true });
		await writeFile(canonicalPath, `${canonicalTranscriptLine(old)}${canonicalTranscriptLine(keep)}`);

		let enteredResolve!: () => void;
		const entered = new Promise<void>((resolve) => {
			enteredResolve = resolve;
		});
		let releaseResolve!: () => void;
		const release = new Promise<void>((resolve) => {
			releaseResolve = resolve;
		});
		const append = appendCanonical(root, "agent-a", "h", [next], async () => {
			enteredResolve();
			await release;
		});
		await entered;
		const purge = purgeTranscriptImportFilesystem(root, "source-a", "agent-a");
		await new Promise((resolve) => setTimeout(resolve, 25));
		releaseResolve();
		await Promise.all([append, purge]);

		const lines = (await Bun.file(canonicalPath).text())
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { id: string });
		expect(lines.map((line) => line.id)).toEqual([keep.recordId]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("active pause and cancel controls clear the lease at the checkpoint", async () => {
	const root = await mkdtemp(join(tmpdir(), "signet-import-controls-"));
	const oldOwner = process.env.SIGNET_DB_OWNER_WORKER;
	process.env.SIGNET_DB_OWNER_WORKER = "1";
	closeDbAccessor();
	await mkdir(join(root, "memory"), { recursive: true });
	initDbAccessor(join(root, "memory", "memories.db"), { agentsDir: root });
	const store = createOwnerTranscriptImportStore();
	try {
		for (const [jobId, control, expectedState] of [
			["pause-job", "pause", "paused"],
			["cancel-job", "cancel", "cancelled"],
		] as const) {
			await createJob(store, { jobId, agentId: "agent-a" });
			await getDbAccessor().withWriteTxAsync((db) =>
				db
					.prepare(
						"UPDATE source_import_jobs SET state = 'running', lease_token = 'lease-a', control_request = ? WHERE id = ?",
					)
					.run(control, jobId),
			);
			if (control === "pause") {
				await getDbAccessor().withWriteTxAsync((db) => {
					db.prepare(
						"INSERT INTO source_import_files (id,job_id,source_id,agent_id,ordinal,name,managed_path,state) VALUES ('pause-file','pause-job','pause-source','agent-a',0,'source.jsonl','imports/transcripts/pause-source/source.jsonl','completed')",
					).run();
					db.prepare(
						"INSERT INTO source_import_records (id,job_id,file_id,source_id,agent_id,ordinal,line_number,byte_offset,byte_length,raw_hash,status) VALUES ('pause-record','pause-job','pause-file','pause-source','agent-a',1,1,0,1,'hash','pending')",
					).run();
				});
			}
			await store.run({
				kind: "source_import",
				operation: "control",
				agentId: "agent-a",
				jobId,
				payload: { apply: true, generation: 0, leaseToken: "lease-a" },
			});
			const row = await getDbAccessor().withReadDbAsync((db) =>
				db.prepare("SELECT state, lease_token FROM source_import_jobs WHERE id = ?").get(jobId),
			);
			expect(row).toEqual({ state: expectedState, lease_token: null });
			if (control === "pause") {
				const pending = await getDbAccessor().withReadDbAsync((db) =>
					db.prepare("SELECT status, rejection_code FROM source_import_records WHERE id = 'pause-record'").get(),
				);
				expect(pending).toEqual({ status: "pending", rejection_code: null });
			}
		}
	} finally {
		closeDbAccessor();
		if (oldOwner === undefined) Reflect.deleteProperty(process.env, "SIGNET_DB_OWNER_WORKER");
		else process.env.SIGNET_DB_OWNER_WORKER = oldOwner;
		await rm(root, { recursive: true, force: true });
	}
});

test("stale finalize cannot complete a job after its lease generation changes", async () => {
	const root = await mkdtemp(join(tmpdir(), "signet-import-stale-finalize-"));
	const oldOwner = process.env.SIGNET_DB_OWNER_WORKER;
	process.env.SIGNET_DB_OWNER_WORKER = "1";
	closeDbAccessor();
	await mkdir(join(root, "memory"), { recursive: true });
	initDbAccessor(join(root, "memory", "memories.db"), { agentsDir: root });
	const store = createOwnerTranscriptImportStore();
	try {
		await createJob(store, { jobId: "stale-job", agentId: "agent-a" });
		await getDbAccessor().withWriteTxAsync((db) =>
			db
				.prepare(
					"UPDATE source_import_jobs SET state = 'running', generation = 1, lease_token = 'new-lease' WHERE id = 'stale-job'",
				)
				.run(),
		);
		await expect(
			store.run({
				kind: "source_import",
				operation: "finalize",
				agentId: "agent-a",
				jobId: "stale-job",
				payload: { generation: 0, leaseToken: "old-lease" },
			}),
		).rejects.toThrow("precondition");
		const row = await getDbAccessor().withReadDbAsync((db) =>
			db.prepare("SELECT state, generation, lease_token FROM source_import_jobs WHERE id = 'stale-job'").get(),
		);
		expect(row).toEqual({ state: "running", generation: 1, lease_token: "new-lease" });
	} finally {
		closeDbAccessor();
		if (oldOwner === undefined) Reflect.deleteProperty(process.env, "SIGNET_DB_OWNER_WORKER");
		else process.env.SIGNET_DB_OWNER_WORKER = oldOwner;
		await rm(root, { recursive: true, force: true });
	}
});

test("store refuses to finalize while pending records remain", async () => {
	const root = await mkdtemp(join(tmpdir(), "signet-import-pending-finalize-"));
	const oldOwner = process.env.SIGNET_DB_OWNER_WORKER;
	process.env.SIGNET_DB_OWNER_WORKER = "1";
	closeDbAccessor();
	await mkdir(join(root, "memory"), { recursive: true });
	initDbAccessor(join(root, "memory", "memories.db"), { agentsDir: root });
	const store = createOwnerTranscriptImportStore();
	try {
		await createJob(store, { jobId: "pending-finalize-job", agentId: "agent-a" });
		await getDbAccessor().withWriteTxAsync((db) => {
			db.prepare(
				"UPDATE source_import_jobs SET state = 'running', pending = 1, lease_token = 'lease-a' WHERE id = 'pending-finalize-job'",
			).run();
			db.prepare(
				"INSERT INTO source_import_files (id, job_id, source_id, agent_id, ordinal, name, managed_path, state) VALUES ('pending-finalize-file', 'pending-finalize-job', 'pending-source', 'agent-a', 0, 'source.jsonl', 'imports/transcripts/pending-source/source.jsonl', 'completed')",
			).run();
			db.prepare(
				"INSERT INTO source_import_records (id, job_id, file_id, source_id, agent_id, ordinal, line_number, byte_offset, byte_length, raw_hash, status) VALUES ('pending-finalize-record', 'pending-finalize-job', 'pending-finalize-file', 'pending-source', 'agent-a', 1, 1, 0, 1, 'hash', 'pending')",
			).run();
		});
		await expect(
			store.run({
				kind: "source_import",
				operation: "finalize",
				agentId: "agent-a",
				jobId: "pending-finalize-job",
				payload: { generation: 0, leaseToken: "lease-a" },
			}),
		).rejects.toThrow("precondition");
		const row = await getDbAccessor().withReadDbAsync((db) =>
			db.prepare("SELECT state, pending, lease_token FROM source_import_jobs WHERE id = 'pending-finalize-job'").get(),
		);
		expect(row).toEqual({ state: "running", pending: 1, lease_token: "lease-a" });
	} finally {
		closeDbAccessor();
		if (oldOwner === undefined) Reflect.deleteProperty(process.env, "SIGNET_DB_OWNER_WORKER");
		else process.env.SIGNET_DB_OWNER_WORKER = oldOwner;
		await rm(root, { recursive: true, force: true });
	}
});

test("source purge audit attempts retain source identity after import ledgers are removed", async () => {
	const root = await mkdtemp(join(tmpdir(), "signet-import-audit-tombstone-"));
	const dbPath = join(root, "memory", "memories.db");
	const oldOwner = process.env.SIGNET_DB_OWNER_WORKER;
	process.env.SIGNET_DB_OWNER_WORKER = "1";
	closeDbAccessor();
	await mkdir(join(root, "memory"), { recursive: true });
	initDbAccessor(dbPath, { agentsDir: root });
	const store = createOwnerTranscriptImportStore();
	try {
		await createJob(store, { jobId: "audit-job", agentId: "audit-agent" });
		await getDbAccessor().withWriteTxAsync((db) => {
			db.prepare(
				"INSERT INTO source_import_files (id,job_id,source_id,agent_id,ordinal,name,managed_path,state) VALUES ('audit-file','audit-job','audit-source','audit-agent',0,'source.jsonl','imports/transcripts/audit-source/source.jsonl','completed')",
			).run();
			db.prepare(
				"INSERT INTO source_import_records (id,job_id,file_id,source_id,agent_id,ordinal,line_number,byte_offset,byte_length,raw_hash,status) VALUES ('audit-record','audit-job','audit-file','audit-source','audit-agent',1,1,0,1,'hash','pending')",
			).run();
		});
		await store.run({
			kind: "source_import",
			operation: "reject",
			agentId: "audit-agent",
			jobId: "audit-job",
			payload: { recordId: "audit-record", code: "malformed" },
		});
		const attempt = await getDbAccessor().withReadDbAsync(
			(db) =>
				db
					.prepare("SELECT source_id, outcome FROM source_import_record_attempts WHERE record_id = ?")
					.get("audit-record") as {
					source_id: string;
					outcome: string;
				},
		);
		expect(attempt).toEqual({ source_id: "audit-source", outcome: "rejected" });
	} finally {
		closeDbAccessor();
		if (oldOwner === undefined) Reflect.deleteProperty(process.env, "SIGNET_DB_OWNER_WORKER");
		else process.env.SIGNET_DB_OWNER_WORKER = oldOwner;
		await rm(root, { recursive: true, force: true });
	}
});

test("staged mutations are rejected before canonical commit", async () => {
	const root = await mkdtemp(join(tmpdir(), "signet-import-staged-mutation-"));
	const source = "mutable-source";
	const stagedPath = join(root, "imports", "transcripts", source, "source.jsonl");
	const raw = `${valid("mutation")}\n`;
	const originalHash = createHash("sha256").update(raw, "utf8").digest("hex");
	await mkdir(join(root, "imports", "transcripts", source), { recursive: true });
	await writeFile(stagedPath, raw);
	let mutated = false;
	let done = false;
	let recovery: Readonly<Record<string, unknown>> | undefined;
	let commitCalled = false;
	const store: ImportStore = {
		run: async <T>(op: ImportStoreOperation) => {
			if (op.operation === "recover") {
				if (typeof op.payload.error === "string") {
					recovery = op.payload;
					done = true;
				}
				return undefined as T;
			}
			if (op.operation === "list" && op.payload.view === "work")
				return (done ? [] : [{ id: "mutation-job", state: "queued", generation: 0 }]) as T;
			if (op.operation === "lease")
				return { id: "mutation-job", state: "running", generation: 0, lease_token: "mutation-lease" } as T;
			if (op.operation === "list" && op.payload.view === "status")
				return [
					{
						id: "mutation-job",
						state: "running",
						generation: 0,
						lease_token: "mutation-lease",
						control_request: null,
					},
				] as T;
			if (op.operation === "list" && op.payload.view === "files")
				return [
					{
						id: "mutation-file",
						job_id: "mutation-job",
						source_id: source,
						managed_path: `imports/transcripts/${source}/source.jsonl`,
						checkpoint_byte_offset: 0,
						checkpoint_ordinal: 0,
						state: "ready",
						size_bytes: Buffer.byteLength(raw),
						content_hash: originalHash,
					},
				] as T;
			if (op.operation === "record_batch") {
				if (!mutated) {
					mutated = true;
					await writeFile(stagedPath, raw.replace("exact", "EXACT"));
				}
				return undefined as T;
			}
			if (op.operation === "commit") {
				commitCalled = true;
				return [] as T;
			}
			return undefined as T;
		},
	};
	try {
		const worker = startTranscriptImportWorker({ store, agentId: "agent-a", workspaceRoot: root, pollMs: 1 });
		await new Promise((resolve) => setTimeout(resolve, 80));
		await worker.stop();
		expect(recovery).toMatchObject({ retryable: false, error: "staged source hash changed", fileId: "mutation-file" });
		expect(commitCalled).toBe(false);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("owner recovery retries a transient startup failure before polling work", async () => {
	let recoverAttempts = 0;
	const store: ImportStore = {
		run: async <T>(op: ImportStoreOperation) => {
			if (op.operation === "recover") {
				recoverAttempts++;
				if (recoverAttempts === 1) throw new Error("database owner unavailable");
				return undefined as T;
			}
			if (op.operation === "list" && op.payload.view === "work") return [] as T;
			return undefined as T;
		},
	};
	const worker = startTranscriptImportWorker({ store, agentId: "agent-a", pollMs: 1 });
	await new Promise((resolve) => setTimeout(resolve, 320));
	await worker.stop();
	expect(recoverAttempts).toBeGreaterThanOrEqual(2);
});

test("callback failure is durably requeued instead of finalizing the import", async () => {
	const root = await mkdtemp(join(tmpdir(), "signet-import-callback-failure-"));
	const source = "callback-source";
	const raw = `${valid("callback")}\n`;
	await mkdir(join(root, "imports", "transcripts", source), { recursive: true });
	await writeFile(join(root, "imports", "transcripts", source, "source.jsonl"), raw);
	const records: TestRow[] = [];
	let fileComplete = false;
	let done = false;
	let finalized = false;
	let recovery: Readonly<Record<string, unknown>> | undefined;
	const store: ImportStore = {
		run: async <T>(op: ImportStoreOperation) => {
			if (op.operation === "recover") {
				if (typeof op.payload.error === "string") {
					recovery = op.payload;
					done = true;
				}
				return undefined as T;
			}
			if (op.operation === "list" && op.payload.view === "work")
				return (done ? [] : [{ id: "callback-job", state: "queued", generation: 0 }]) as T;
			if (op.operation === "lease")
				return { id: "callback-job", state: "running", generation: 0, lease_token: "callback-lease" } as T;
			if (op.operation === "list" && op.payload.view === "status")
				return [
					{
						id: "callback-job",
						state: "running",
						generation: 0,
						lease_token: "callback-lease",
						control_request: null,
					},
				] as T;
			if (op.operation === "list" && op.payload.view === "files")
				return [
					{
						id: "callback-file",
						job_id: "callback-job",
						source_id: source,
						managed_path: `imports/transcripts/${source}/source.jsonl`,
						checkpoint_byte_offset: 0,
						checkpoint_ordinal: 0,
						state: fileComplete ? "completed" : "ready",
					},
				] as T;
			if (op.operation === "record_batch") {
				for (const record of op.payload.records as InventoryRecord[])
					records.push({
						...record,
						id: `callback-record-${record.ordinal}`,
						file_id: "callback-file",
						job_id: "callback-job",
						source_id: source,
						status: record.status,
					});
				return undefined as T;
			}
			if (op.operation === "file_complete") {
				fileComplete = true;
				return undefined as T;
			}
			if (op.operation === "list" && op.payload.view === "pending")
				return records.filter((record) => record.status === "pending") as T;
			if (op.operation === "commit") {
				for (const commit of op.payload.commits as TestCommit[]) {
					const record = records.find((candidate) => candidate.id === commit.sourceRecordId);
					if (record) record.status = "imported";
				}
				return (op.payload.commits as TestCommit[]).map((commit) => ({
					outcome: "imported",
					canonicalId: commit.canonicalId,
					sessionKey: commit.canonicalKey,
				})) as T;
			}
			if (op.operation === "finalize") {
				finalized = true;
				return undefined as T;
			}
			return undefined as T;
		},
	};
	try {
		const worker = startTranscriptImportWorker({
			store,
			agentId: "agent-a",
			workspaceRoot: root,
			pollMs: 1,
			onBatch: async () => {
				throw new Error("dreaming callback failed");
			},
		});
		await new Promise((resolve) => setTimeout(resolve, 100));
		await worker.stop();
		expect(recovery).toMatchObject({ retryable: true, error: "dreaming callback failed", fileId: "callback-file" });
		expect(finalized).toBe(false);
		expect(records.filter((record) => record.status === "imported")).toHaveLength(1);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
