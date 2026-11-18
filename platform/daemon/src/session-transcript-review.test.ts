import { afterEach, beforeEach, expect, test, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { resolveWorkspaceLayout, runMigrations } from "@signet/core";
import { Database } from "bun:sqlite";
import { logger } from "./logger";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "./db-accessor";
import * as runtime from "./db-owner-runtime";
import { DbOwnerError } from "./db-owner-client";
import { deleteSessionTranscript, updateTranscriptLifecycle } from "./session-transcript-lifecycle";
import {
	admitSessionTranscriptInDb,
	commitCompactionSummary,
	getStoredSessionTranscriptInfoAsync,
	updateTranscriptLifecycleInTx,
	upsertSessionTranscriptAsync,
	deleteSessionTranscriptOwned,
} from "./session-transcripts";
import { bypassSession, isSessionBypassed } from "./session-tracker";
import { writeCanonicalTranscriptFromSnapshot } from "./transcript-capture";
import { canonicalTranscriptPath } from "./transcript-jsonl";
import { writeSummaryArtifact } from "./memory-lineage";
import { normalizeSessionTranscript } from "./transcript-normalization";
import { redactTranscriptFileBatch } from "./session-transcript-files";

let root = "";
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "transcript-review-"));
	mkdirSync(join(root, "memory"));
	process.env.SIGNET_PATH = root;
	initDbAccessor(join(root, "memory", "memories.db"));
});
afterEach(async () => {
	await closeDbAccessor();
	rmSync(root, { recursive: true, force: true });
});

async function deleted(key: string, live = false): Promise<void> {
	await upsertSessionTranscriptAsync(
		key,
		"User: deleted turn",
		"claude-code",
		null,
		"review",
		"2020-01-01T00:00:00.000Z",
	);
	let result = await deleteSessionTranscript({
		agentId: "review",
		sessionKey: key,
		hard: false,
		changedBy: "test",
		...(live ? { live: { harness: "claude-code", project: null } } : {}),
	});
	for (let i = 0; result.status === "pending" && i < 20; i++)
		result = await deleteSessionTranscript({ agentId: "review", sessionKey: key, hard: false, changedBy: "test" });
	expect(result.status).toBe("complete");
}

test("deletion waits for admitted summary writers before reporting completion", async () => {
	const key = "blocked-summary";
	await upsertSessionTranscriptAsync(key, "User: evidence", "codex", null, "review", "2020-01-01T00:00:00.000Z");
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<string>();
	const writer = writeSummaryArtifact({
		agentId: "review",
		sessionKey: key,
		sessionId: key,
		project: null,
		harness: "codex",
		capturedAt: "2020-01-01T00:00:00.000Z",
		startedAt: null,
		endedAt: null,
		summary: "private summary evidence",
		provider: {
			name: "test",
			generate: async () => {
				entered.resolve();
				return release.promise;
			},
			available: async () => true,
		},
	}).then(
		() => null,
		(error: unknown) => error,
	);
	await entered.promise;
	let completed = false;
	const deletion = deleteSessionTranscript({ agentId: "review", sessionKey: key, hard: false, changedBy: "test" }).then(
		(result) => {
			completed = result.status === "complete";
			return result;
		},
	);
	try {
		await new Promise<void>((resolve) => setTimeout(resolve, 100));
		expect(completed).toBe(false);
	} finally {
		release.resolve("Private summary evidence was recorded.");
		await writer;
		await deletion;
	}
	let result = await deletion;
	for (let i = 0; result.status === "pending" && i < 20; i++)
		result = await deleteSessionTranscript({ agentId: "review", sessionKey: key, hard: false, changedBy: "test" });
	expect(result.status).toBe("complete");
	const rows = await getDbAccessor().withReadDbAsync((db) =>
		db.prepare("SELECT source_path FROM memory_artifacts WHERE agent_id = 'review' AND session_key = ?").all(key),
	);
	expect(rows).toEqual([]);
	const files = readdirSync(resolveWorkspaceLayout(root).transcripts, { recursive: true }).filter(
		(name): name is string => typeof name === "string" && name.endsWith(".md"),
	);
	for (const file of files)
		expect(readFileSync(join(resolveWorkspaceLayout(root).transcripts, file), "utf8")).not.toContain(
			"private summary evidence",
		);
});

test.each([false, true])(
	"shorter replay is fenced without blacklisting a divergent prefix, canonicalOnly=%s",
	async (canonicalOnly) => {
		const key = `short-replay-${canonicalOnly}`;
		const identity = { basePath: root, agentId: "review", sessionKey: key, harness: `short-${canonicalOnly}` };
		if (canonicalOnly) {
			await writeCanonicalTranscriptFromSnapshot({
				...identity,
				transcript: "User: A\nAssistant: B",
				rawTranscript: "User: A\nAssistant: B",
				capturedAt: "2020-01-01T00:00:00.000Z",
			});
		} else {
			await upsertSessionTranscriptAsync(
				key,
				"User: A\nAssistant: B",
				identity.harness,
				null,
				"review",
				"2020-01-01T00:00:00.000Z",
			);
		}
		let result = await deleteSessionTranscript({
			agentId: "review",
			sessionKey: key,
			hard: false,
			changedBy: "test",
			...(canonicalOnly ? { live: { harness: identity.harness, project: null } } : {}),
		});
		for (let i = 0; result.status === "pending" && i < 20; i++)
			result = await deleteSessionTranscript({ agentId: "review", sessionKey: key, hard: false, changedBy: "test" });
		expect(result.status).toBe("complete");
		await updateTranscriptLifecycle({ agentId: "review", sessionKey: key, action: "end" });
		await updateTranscriptLifecycle({ agentId: "review", sessionKey: key, action: "start" });
		await upsertSessionTranscriptAsync(key, "User: A", identity.harness, null, "review", new Date().toISOString());
		expect(await getStoredSessionTranscriptInfoAsync(key, "review")).toBeUndefined();
		expect(
			await writeCanonicalTranscriptFromSnapshot({
				...identity,
				transcript: "User: A",
				rawTranscript: "User: A",
				capturedAt: new Date().toISOString(),
			}),
		).toBeNull();
		await upsertSessionTranscriptAsync(
			key,
			"User: A\nUser: C",
			identity.harness,
			null,
			"review",
			new Date().toISOString(),
		);
		expect((await getStoredSessionTranscriptInfoAsync(key, "review"))?.content).toBe("User: A\nUser: C");
	},
);

test("lease expiry returns retryable pending while a slow summary writer drains", async () => {
	const key = "slow-summary";
	await upsertSessionTranscriptAsync(key, "User: evidence", "codex", null, "review", "2020-01-01T00:00:00.000Z");
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<string>();
	const writer = writeSummaryArtifact({
		agentId: "review",
		sessionKey: key,
		sessionId: key,
		project: null,
		harness: "codex",
		capturedAt: "2020-01-01T00:00:00.000Z",
		startedAt: null,
		endedAt: null,
		summary: "slow summary",
		provider: {
			name: "test",
			available: async () => true,
			generate: async () => {
				entered.resolve();
				return release.promise;
			},
		},
	});
	await entered.promise;
	try {
		expect(
			await deleteSessionTranscript({ agentId: "review", sessionKey: key, hard: false, changedBy: "test" }),
		).toMatchObject({ status: "pending", pendingReason: expect.stringContaining("lease") });
	} finally {
		release.resolve("A slow summary was recorded.");
		await writer;
	}
	expect(
		await deleteSessionTranscript({ agentId: "review", sessionKey: key, hard: false, changedBy: "test" }),
	).toMatchObject({ status: "complete" });
}, 30_000);

test("journal allocation follows the last owner high-water despite a backward clock", async () => {
	const key = "owner-high-water";
	await deleted(key, true);
	const high = 8_000_000_000_000_000;
	await getDbAccessor().withWriteTxAsync((db) =>
		db
			.prepare(
				"UPDATE session_transcript_deletions SET lifecycle_intent_seq = ? WHERE agent_id = 'review' AND session_key = ?",
			)
			.run(high, key),
	);
	const status = await updateTranscriptLifecycle({ agentId: "review", sessionKey: key, action: "status" });
	expect(status).toMatchObject({ lifecycleIntentSeq: high });
	const clock = spyOn(Date, "now").mockReturnValue(1);
	const offline = spyOn(runtime, "dbOwnerTranscriptOperation").mockRejectedValueOnce(new Error("offline"));
	try {
		await expect(updateTranscriptLifecycle({ agentId: "review", sessionKey: key, action: "end" })).rejects.toThrow(
			"offline",
		);
	} finally {
		clock.mockRestore();
		offline.mockRestore();
	}
	expect(await updateTranscriptLifecycle({ agentId: "review", sessionKey: key, action: "start" })).toMatchObject({
		generation: 2,
		bypassed: false,
	});
});

test("completing deletion invalidates only DB-registered pending temps for the same file", async () => {
	const path = join(root, "shared.jsonl");
	const first = JSON.stringify({ agent_id: "review", session_key: "temp-a", content: "first" }) + "\n";
	const second = JSON.stringify({ agent_id: "review", session_key: "temp-b", content: "second" }) + "\n";
	writeFileSync(path, first + second);
	const pending = await redactTranscriptFileBatch({
		basePath: root,
		path,
		agentId: "review",
		sessionKey: "temp-b",
		generation: 1,
		checkpoint: null,
	});
	const checkpoint = JSON.stringify(pending.checkpoint);
	await getDbAccessor().withWriteTxAsync((db) => {
		for (const key of ["temp-a", "temp-b"]) {
			db.prepare(
				"INSERT INTO session_transcript_deletions (agent_id,session_key,watermark,phase) VALUES ('review',?,'2020-01-01','files')",
			).run(key);
			db.prepare(
				"INSERT INTO session_transcript_delete_files (agent_id,session_key,generation,path,checkpoint) VALUES ('review',?,1,?,?)",
			).run(key, path, key === "temp-b" ? checkpoint : null);
		}
	});
	expect(
		await deleteSessionTranscript({ agentId: "review", sessionKey: "temp-a", hard: false, changedBy: "test" }),
	).toMatchObject({ status: "complete" });
	expect(readFileSync(path, "utf8")).toBe(second);
	expect(readdirSync(root).filter((name) => name.includes(".delete-"))).toEqual([]);
	expect(
		await deleteSessionTranscript({ agentId: "review", sessionKey: "temp-b", hard: false, changedBy: "test" }),
	).toMatchObject({ status: "complete" });
	expect(readFileSync(path, "utf8")).toBe("");
});

test("an intent at or behind the owner high-water logs the hashed key and both sequences", () => {
	const db = new Database(":memory:");
	const warn = spyOn(logger, "warn").mockImplementation(() => {});
	try {
		runMigrations(db);
		db.prepare(
			"INSERT INTO session_transcript_deletions (agent_id,session_key,watermark,lifecycle_intent_seq) VALUES ('review','skip-intent','2020-01-01',42)",
		).run();
		updateTranscriptLifecycleInTx(db, {
			agentId: "review",
			sessionKey: "skip-intent",
			action: "status",
			intents: [{ seq: 41, action: "end", at: "2020-01-01" }],
		});
		expect(warn).toHaveBeenCalledWith("transcripts", expect.stringContaining("Skipped lifecycle intent"), {
			keyHash: expect.stringMatching(/^[0-9a-f]{64}$/),
			intentSeq: 41,
			ownerSeq: 42,
		});
	} finally {
		warn.mockRestore();
		db.close();
	}
});

test("receipt count remains authoritative when positional rows extend past its boundary", async () => {
	const key = "receipt-count";
	await upsertSessionTranscriptAsync(
		key,
		"User: first\nUser: second",
		"codex",
		null,
		"review",
		"2020-01-01T00:00:00.000Z",
	);
	await deleteSessionTranscript({ agentId: "review", sessionKey: key, hard: false, changedBy: "test" });
	await updateTranscriptLifecycle({ agentId: "review", sessionKey: key, action: "start" });
	await getDbAccessor().withWriteTxAsync((db) =>
		db
			.prepare("INSERT INTO session_transcript_deleted_positions VALUES ('review',?,1,'row',3,'uncommitted-prefix')")
			.run(key),
	);
	await upsertSessionTranscriptAsync(
		key,
		"User: first\nUser: second\nUser: fresh",
		"codex",
		null,
		"review",
		new Date().toISOString(),
	);
	expect((await getStoredSessionTranscriptInfoAsync(key, "review"))?.content).toBe("User: fresh");
});

test("partial deletion reimports the same source fingerprint and retains its new suffix", async () => {
	const { signetExportV1Adapter } = await import("./transcript-import-adapter");
	const { buildCompletedTranscriptCommit, commitCompletedTranscriptBatchInTx } = await import(
		"./transcript-import-commit"
	);
	const commit = buildCompletedTranscriptCommit(
		signetExportV1Adapter.parse({
			source: "signet",
			id: "partial-source",
			agent_id: "review",
			session_key: "partial-source",
			harness: "codex",
			project: null,
			timestamp: new Date(Date.now() + 60_000).toISOString(),
			message_count: 2,
			messages: [
				{ role: "user", content: "old" },
				{ role: "assistant", content: "post-watermark turn" },
			],
		}),
		{ agentId: "review", sourceId: "source-partial", sourceRecordId: "record-partial" },
	);
	const apply = () => getDbAccessor().withWriteTxAsync((db) => commitCompletedTranscriptBatchInTx(db, [commit]));
	expect(await apply()).toMatchObject([{ outcome: "imported" }]);
	await upsertSessionTranscriptAsync(
		commit.canonicalKey,
		"User: old",
		"codex",
		null,
		"review",
		"2020-01-01T00:00:00.000Z",
	);
	let result = await deleteSessionTranscript({
		agentId: "review",
		sessionKey: commit.canonicalKey,
		hard: false,
		changedBy: "test",
	});
	for (let i = 0; result.status === "pending" && i < 20; i++)
		result = await deleteSessionTranscript({
			agentId: "review",
			sessionKey: commit.canonicalKey,
			hard: false,
			changedBy: "test",
		});
	expect(result.status).toBe("complete");
	await updateTranscriptLifecycle({ agentId: "review", sessionKey: commit.canonicalKey, action: "start" });
	expect(await apply()).toMatchObject([{ outcome: "imported" }]);
	expect(
		JSON.parse((await getStoredSessionTranscriptInfoAsync(commit.canonicalKey, "review"))?.content ?? "null"),
	).toEqual([{ role: "assistant", content: "post-watermark turn" }]);
	const identity = await getDbAccessor().withReadDbAsync((db) =>
		db
			.prepare(
				"SELECT conversation_fingerprint,content_hash FROM transcript_import_conversations WHERE agent_id = ? AND external_identity = ?",
			)
			.get(commit.agentId, commit.externalIdentity),
	);
	expect(identity).toMatchObject({ conversation_fingerprint: commit.contentHash });
	expect(identity).not.toMatchObject({ content_hash: commit.contentHash });
});

test("filtered imports preserve system tool unknown roles and literal User lines", async () => {
	const key = "message-roles";
	await upsertSessionTranscriptAsync(key, "User: old", "codex", null, "review", "2020-01-01T00:00:00.000Z");
	await deleteSessionTranscript({ agentId: "review", sessionKey: key, hard: false, changedBy: "test" });
	await updateTranscriptLifecycle({ agentId: "review", sessionKey: key, action: "start" });
	const { signetExportV1Adapter } = await import("./transcript-import-adapter");
	const { buildCompletedTranscriptCommit, commitCompletedTranscriptBatchInTx } = await import(
		"./transcript-import-commit"
	);
	const kept = [
		{ role: "assistant", content: "retained reply" },
		{ role: "system", content: "system directive" },
		{ role: "tool", content: "result\nUser: literal output" },
		{ role: "unknown", content: "unclassified" },
	];
	const commit = buildCompletedTranscriptCommit(
		signetExportV1Adapter.parse({
			source: "signet",
			id: key,
			agent_id: "review",
			session_key: key,
			harness: "codex",
			project: null,
			timestamp: new Date().toISOString(),
			message_count: 5,
			messages: [{ role: "user", content: "old" }, ...kept],
		}),
		{ agentId: "review", sourceId: "source-roles", sourceRecordId: "record-roles" },
	);
	expect(
		await getDbAccessor().withWriteTxAsync((db) => commitCompletedTranscriptBatchInTx(db, [commit])),
	).toMatchObject([{ outcome: "imported" }]);
	expect(
		JSON.parse((await getStoredSessionTranscriptInfoAsync(commit.canonicalKey, "review"))?.content ?? "null"),
	).toEqual(kept);
});

test("journaled lifecycle intent survives restart and a backward clock", () => {
	const workspace = join(root, "restart-clock");
	mkdirSync(join(workspace, "memory"), { recursive: true });
	const module = (name: string): string => new URL(`./${name}.ts`, import.meta.url).href;
	const setup = `
		import { initDbAccessor, closeDbAccessor, getDbAccessor } from ${JSON.stringify(module("db-accessor"))};
		import { deleteSessionTranscript, updateTranscriptLifecycle } from ${JSON.stringify(module("session-transcript-lifecycle"))};
		import { upsertSessionTranscriptAsync } from ${JSON.stringify(module("session-transcripts"))};
		import { withTranscriptLifecycleIntents } from ${JSON.stringify(module("transcript-lifecycle-intents"))};
		import { dbOwnerTranscriptOperation, getDbOwnerForAccessor } from ${JSON.stringify(module("db-owner-runtime"))};
		initDbAccessor(process.env.SIGNET_PATH + "/memory/memories.db");
		const input = { agentId: "clock", sessionKey: "restart-clock" };
		const clock = Date.now;
	`;
	const phases = [
		`await upsertSessionTranscriptAsync(input.sessionKey, "User: old", "codex", null, input.agentId, "2020-01-01T00:00:00.000Z");
		await deleteSessionTranscript({ ...input, hard: false, changedBy: "test", live: { harness: "codex", project: null } });
		const owner = await getDbOwnerForAccessor(getDbAccessor());
		Date.now = () => clock() + 60_000;
		try { await withTranscriptLifecycleIntents({ ...input, action: "end" }, async () => { throw new Error("offline"); }); } catch (error) { if (error.message !== "offline") throw error; }
		Date.now = clock;
		await updateTranscriptLifecycle({ ...input, action: "status" });`,
		`Date.now = () => clock() - 60_000;
		try { await withTranscriptLifecycleIntents({ ...input, action: "start" }, async () => { Date.now = clock; throw new Error("offline"); }); } catch (error) { if (error.message !== "offline") throw error; }
		Date.now = clock;
		console.log(JSON.stringify(await updateTranscriptLifecycle({ ...input, action: "status" })));`,
	];
	for (const [index, phase] of phases.entries()) {
		const child = spawnSync(
			process.execPath,
			["--eval", `${setup}${phase}\nawait closeDbAccessor(); process.exit(0);`],
			{
				env: { ...process.env, SIGNET_PATH: workspace },
				encoding: "utf8",
				timeout: 20_000,
			},
		);
		expect(child.stderr).not.toContain("error:");
		expect(child.status).toBe(0);
		if (index === 1)
			expect(JSON.parse(child.stdout.trim().split("\n").at(-1) ?? "null")).toMatchObject({
				generation: 2,
				bypassed: false,
			});
	}
});

test("a rejected final artifact upsert removes the file and surfaces rejection", async () => {
	const key = "final-artifact-gate";
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<string>();
	const writer = writeSummaryArtifact({
		agentId: "review",
		sessionKey: key,
		sessionId: key,
		project: null,
		harness: "codex",
		capturedAt: "2020-01-01T00:00:00.000Z",
		startedAt: null,
		endedAt: null,
		summary: "final gate private summary",
		provider: {
			name: "test",
			generate: async () => {
				entered.resolve();
				return release.promise;
			},
			available: async () => true,
		},
	}).then(
		() => null,
		(error: unknown) => error,
	);
	await entered.promise;
	try {
		await getDbAccessor().withWriteTxAsync((db) =>
			db
				.prepare(
					"INSERT INTO session_transcript_deletions (agent_id,session_key,watermark,phase) VALUES ('review',?,'2021-01-01T00:00:00.000Z','files')",
				)
				.run(key),
		);
	} finally {
		release.resolve("The private summary was recorded.");
	}
	expect(await writer).toBeInstanceOf(Error);
	const directory = resolveWorkspaceLayout(root).transcripts;
	for (const file of readdirSync(directory, { recursive: true })) {
		if (typeof file === "string" && file.endsWith(".md"))
			expect(readFileSync(join(directory, file), "utf8")).not.toContain("final gate private summary");
	}
	expect(
		await getDbAccessor().withReadDbAsync((db) =>
			db
				.prepare(
					"SELECT source_path FROM memory_artifacts WHERE agent_id = 'review' AND session_key = ? AND source_kind = 'summary'",
				)
				.all(key),
		),
	).toEqual([]);
});

test("compaction summaries isolate agents sharing a key and timestamp", async () => {
	const now = new Date().toISOString();
	for (const agentId of ["summary-a", "summary-b"]) {
		expect(
			await commitCompactionSummary(getDbAccessor(), {
				agentId,
				sessionKey: "shared-compaction",
				harness: "codex",
				project: null,
				summary: agentId,
				summaryId: `memory-${agentId}`,
				now,
			}),
		).toBe(true);
	}
	const rows = await getDbAccessor().withReadDbAsync((db) =>
		db
			.prepare(
				"SELECT agent_id,content FROM session_summaries WHERE session_key = 'shared-compaction' ORDER BY agent_id",
			)
			.all(),
	);
	expect(rows).toEqual([
		{ agent_id: "summary-a", content: "summary-a" },
		{ agent_id: "summary-b", content: "summary-b" },
	]);
});

test("pending deletion remembers an explicit start until cleanup completes", async () => {
	await getDbAccessor().withWriteTxAsync(async (db) => {
		db.prepare(
			"INSERT INTO session_transcript_deletions (agent_id,session_key,watermark,phase,ended,blocked) VALUES ('review','pending-start','2020-01-01T00:00:00.000Z','files',1,1)",
		).run();
		updateTranscriptLifecycleInTx(db, { agentId: "review", sessionKey: "pending-start", action: "start" });
		const result = await deleteSessionTranscriptOwned(
			db,
			{ basePath: root, agentId: "review", sessionKey: "pending-start", hard: false, changedBy: "test" },
			root,
			(op) => op(),
			Date.now() + 2000,
		);
		expect(result.status).toBe("complete");
		expect(
			admitSessionTranscriptInDb(db, {
				agentId: "review",
				sessionKey: "pending-start",
				live: true,
				capturedAt: new Date().toISOString(),
			}),
		).toBe(true);
	});
});

test("an end cancels a start still waiting for deletion cleanup", async () => {
	await getDbAccessor().withWriteTxAsync(async (db) => {
		db.prepare(
			"INSERT INTO session_transcript_deletions (agent_id,session_key,watermark,phase,ended,blocked) VALUES ('review','pending-ended','2020-01-01T00:00:00.000Z','files',1,1)",
		).run();
		updateTranscriptLifecycleInTx(db, { agentId: "review", sessionKey: "pending-ended", action: "start" });
		updateTranscriptLifecycleInTx(db, { agentId: "review", sessionKey: "pending-ended", action: "end" });
		await deleteSessionTranscriptOwned(
			db,
			{ basePath: root, agentId: "review", sessionKey: "pending-ended", hard: false, changedBy: "test" },
			root,
			(op) => op(),
			Date.now() + 2000,
		);
		expect(
			admitSessionTranscriptInDb(db, {
				agentId: "review",
				sessionKey: "pending-ended",
				live: true,
				capturedAt: new Date().toISOString(),
			}),
		).toBe(false);
	});
});

test("status does not clear a user bypass after key reuse", async () => {
	await deleted("user-bypass");
	await updateTranscriptLifecycle({ agentId: "review", sessionKey: "user-bypass", action: "start" });
	bypassSession("user-bypass", { allowUnknown: true }, "review");
	await updateTranscriptLifecycle({ agentId: "review", sessionKey: "user-bypass", action: "status" });
	expect(isSessionBypassed("user-bypass", "review")).toBe(true);
});

test("an end intent survives owner timeout and is applied before a later start", async () => {
	await deleted("timeout-end", true);
	const failure = spyOn(runtime, "dbOwnerTranscriptOperation").mockRejectedValueOnce(
		new DbOwnerError("DB_OWNER_DEADLINE", "test deadline"),
	);
	try {
		await expect(
			updateTranscriptLifecycle({ agentId: "review", sessionKey: "timeout-end", action: "end" }),
		).rejects.toThrow("test deadline");
	} finally {
		failure.mockRestore();
	}
	expect(
		await updateTranscriptLifecycle({ agentId: "review", sessionKey: "timeout-end", action: "start" }),
	).toMatchObject({ generation: 2, bypassed: false });
});

test("a resumed snapshot stores only new undated records in the row and canonical file", async () => {
	await deleted("resume-records");
	await updateTranscriptLifecycle({ agentId: "review", sessionKey: "resume-records", action: "start" });
	const transcript = "User: deleted turn\nAssistant: new reply";
	await upsertSessionTranscriptAsync(
		"resume-records",
		transcript,
		"claude-code",
		null,
		"review",
		new Date().toISOString(),
	);
	expect((await getStoredSessionTranscriptInfoAsync("resume-records", "review"))?.content).toBe("Assistant: new reply");
	const output = await writeCanonicalTranscriptFromSnapshot({
		basePath: root,
		agentId: "review",
		harness: "claude-code",
		sessionKey: "resume-records",
		rawTranscript: transcript,
		transcript,
		capturedAt: new Date().toISOString(),
	});
	expect(output).toBe("Assistant: new reply");
	const records = readFileSync(canonicalTranscriptPath(root, "claude-code"), "utf8");
	expect(records).not.toContain("deleted turn");
	expect(records).toContain("new reply");
});

test("positional replay removes only the deleted prefix, not repeated new turns", async () => {
	for (const replay of [true, false]) {
		const key = `repeated-ok-${replay}`;
		await upsertSessionTranscriptAsync(key, "User: old\nUser: ok", "codex", null, "review", "2020-01-01T00:00:00.000Z");
		await deleteSessionTranscript({ agentId: "review", sessionKey: key, hard: false, changedBy: "test" });
		await updateTranscriptLifecycle({ agentId: "review", sessionKey: key, action: "start" });
		const transcript = replay ? "User: old\nUser: ok\nUser: ok" : "User: ok";
		await upsertSessionTranscriptAsync(key, transcript, "codex", null, "review", new Date().toISOString());
		expect((await getStoredSessionTranscriptInfoAsync(key, "review"))?.content).toBe("User: ok");
		expect(
			await writeCanonicalTranscriptFromSnapshot({
				basePath: root,
				agentId: "review",
				harness: "codex",
				sessionKey: key,
				rawTranscript: transcript,
				transcript,
				capturedAt: new Date().toISOString(),
			}),
		).toBe("User: ok");
	}
});

test("successive deletions retain positional receipts without rejecting new live duplicates", async () => {
	const key = "successive-prefix";
	const lifecycle = (action: "start" | "end") =>
		updateTranscriptLifecycle({ agentId: "review", sessionKey: key, action });
	await upsertSessionTranscriptAsync(key, "User: first", "codex", null, "review", "2020-01-01T00:00:00.000Z");
	await deleteSessionTranscript({ agentId: "review", sessionKey: key, hard: false, changedBy: "test" });
	expect(await lifecycle("start")).toMatchObject({ generation: 2 });
	await upsertSessionTranscriptAsync(
		key,
		"User: first\nAssistant: second",
		"codex",
		null,
		"review",
		new Date().toISOString(),
	);
	await lifecycle("end");
	const { appendCanonicalLiveTranscriptTurns } = await import("./transcript-capture");
	expect(
		await appendCanonicalLiveTranscriptTurns({
			basePath: root,
			agentId: "review",
			sessionKey: key,
			harness: "codex",
			userMessage: "late after end",
		}),
	).toBe(false);
	await deleteSessionTranscript({ agentId: "review", sessionKey: key, hard: false, changedBy: "test" });
	expect(await lifecycle("start")).toMatchObject({ generation: 3 });
	await upsertSessionTranscriptAsync(
		key,
		"User: first\nAssistant: second\nUser: first",
		"codex",
		null,
		"review",
		new Date().toISOString(),
	);
	expect((await getStoredSessionTranscriptInfoAsync(key, "review"))?.content).toBe("User: first");
	expect(
		await appendCanonicalLiveTranscriptTurns({
			basePath: root,
			agentId: "review",
			sessionKey: key,
			harness: "codex",
			userMessage: "first",
		}),
	).toBe(true);
});

test("normal lifecycle sessions leave no intent journal files", async () => {
	for (let i = 0; i < 5; i++) {
		await updateTranscriptLifecycle({ agentId: "normal", sessionKey: `session-${i}`, action: "start" });
		await updateTranscriptLifecycle({ agentId: "normal", sessionKey: `session-${i}`, action: "end" });
	}
	const directory = join(root, ".daemon", "transcript-lifecycle-intents");
	expect(existsSync(directory) ? readdirSync(directory) : []).toEqual([]);
});

test("legacy session-id-only artifacts are discovered and removed only for the owning agent", async () => {
	const path = join(root, "legacy-only.md");
	writeFileSync(path, "---\nagent_id: review\nsession_id: legacy-only\n---\nUser: legacy evidence\n");
	await upsertSessionTranscriptAsync(
		"legacy-only",
		"User: legacy evidence",
		"claude-code",
		null,
		"review",
		"2020-01-01T00:00:00.000Z",
	);
	await getDbAccessor().withWriteTxAsync((db) => {
		for (const agent of ["review", "unrelated"])
			db.prepare(
				"INSERT INTO memory_artifacts (agent_id,source_path,source_sha256,source_kind,session_id,session_token,captured_at,content,updated_at) VALUES (?,?,?,'transcript','legacy-only','token','2020-01-01','legacy evidence','2020-01-01')",
			).run(agent, "legacy-only.md", "hash");
	});
	let result = await deleteSessionTranscript({
		agentId: "review",
		sessionKey: "legacy-only",
		hard: false,
		changedBy: "test",
	});
	for (let i = 0; result.status === "pending" && i < 20; i++)
		result = await deleteSessionTranscript({
			agentId: "review",
			sessionKey: "legacy-only",
			hard: false,
			changedBy: "test",
		});
	expect(result.status).toBe("complete");
	expect(existsSync(path)).toBe(false);
	const rows = await getDbAccessor().withReadDbAsync((db) =>
		db.prepare("SELECT agent_id FROM memory_artifacts WHERE source_path='legacy-only.md'").all(),
	);
	expect(rows).toEqual([{ agent_id: "unrelated" }]);
});

test("inline transcript deletion uses the write handle rather than the read facade", async () => {
	await upsertSessionTranscriptAsync(
		"inline-write",
		"User: inline",
		"claude-code",
		null,
		"review",
		"2020-01-01T00:00:00.000Z",
	);
	const accessor = getDbAccessor();
	const read = await accessor.withReadDbAsync((db) => db);
	const scoped = {
		close: (): void => {},
		withReadDb: <T>(fn: (db: typeof read) => T): T => fn({ prepare: read.prepare.bind(read) }),
		withReadDbAsync: accessor.withReadDbAsync.bind(accessor),
		withWriteDbAsync: accessor.withWriteDbAsync.bind(accessor),
		withWriteTxAsync: accessor.withWriteTxAsync.bind(accessor),
	};
	const prior = process.env.SIGNET_DB_OWNER_WORKER;
	process.env.SIGNET_DB_OWNER_WORKER = "1";
	let owner: Awaited<ReturnType<typeof runtime.getDbOwnerForAccessor>>;
	try {
		owner = await runtime.getDbOwnerForAccessor(scoped);
	} finally {
		if (prior === undefined) delete process.env.SIGNET_DB_OWNER_WORKER;
		else process.env.SIGNET_DB_OWNER_WORKER = prior;
	}
	const result = await owner.submit(
		{
			kind: "session_transcript_delete",
			input: { basePath: root, agentId: "review", sessionKey: "inline-write", hard: false, changedBy: "test" },
		},
		{ operation: "test.inline-delete", lane: "write", deadlineMs: 2000 },
	).result;
	expect(result).toMatchObject({ status: "complete" });
	expect(await getStoredSessionTranscriptInfoAsync("inline-write", "review")).toBeUndefined();
});

test("canonical-only records leave a scoped positional prefix that rejects replay", async () => {
	const identity = {
		basePath: root,
		agentId: "canonical-owner",
		harness: "canonical-hash",
		sessionKey: "canonical-only",
		rawTranscript: "User: canonical secret",
		transcript: "User: canonical secret",
		capturedAt: "2020-01-01T00:00:00.000Z",
	};
	await writeCanonicalTranscriptFromSnapshot(identity);
	let result = await deleteSessionTranscript({
		agentId: identity.agentId,
		sessionKey: identity.sessionKey,
		hard: false,
		changedBy: "test",
		live: { harness: identity.harness, project: null },
	});
	for (let i = 0; result.status === "pending" && i < 20; i++)
		result = await deleteSessionTranscript({
			agentId: identity.agentId,
			sessionKey: identity.sessionKey,
			hard: false,
			changedBy: "test",
		});
	expect(result.status).toBe("complete");
	await updateTranscriptLifecycle({ agentId: identity.agentId, sessionKey: identity.sessionKey, action: "end" });
	await updateTranscriptLifecycle({ agentId: identity.agentId, sessionKey: identity.sessionKey, action: "start" });
	const replay = "User: canonical secret\nAssistant: fresh after canonical";
	expect(
		await writeCanonicalTranscriptFromSnapshot({
			...identity,
			rawTranscript: replay,
			transcript: replay,
			capturedAt: new Date().toISOString(),
		}),
	).toBe("Assistant: fresh after canonical");
	await upsertSessionTranscriptAsync(
		identity.sessionKey,
		"User: canonical secret",
		"canonical-hash",
		null,
		"different-owner",
		new Date().toISOString(),
	);
	expect((await getStoredSessionTranscriptInfoAsync(identity.sessionKey, "different-owner"))?.content).toBe(
		"User: canonical secret",
	);
});

test("deletion completes beyond 65536 records without a hash receipt limit", async () => {
	const transcript = Array.from({ length: 65537 }, (_, i) => `User: bounded record ${i}`).join("\n");
	await upsertSessionTranscriptAsync(
		"hash-budget",
		transcript,
		"bounded-hashes",
		null,
		"review",
		"2020-01-01T00:00:00.000Z",
	);
	let result = await deleteSessionTranscript({
		agentId: "review",
		sessionKey: "hash-budget",
		hard: false,
		changedBy: "test",
	});
	for (let i = 0; result.status === "pending" && i < 20; i++)
		result = await deleteSessionTranscript({
			agentId: "review",
			sessionKey: "hash-budget",
			hard: false,
			changedBy: "test",
		});
	expect(result.status).toBe("complete");
	expect(await getStoredSessionTranscriptInfoAsync("hash-budget", "review")).toBeUndefined();
}, 60_000);

test.each([true, false])("reimport admits repeated new turns with replay=%s", async (replay) => {
	const key = `resume-import-${replay}`;
	await upsertSessionTranscriptAsync(
		key,
		"User: old\nUser: ok",
		"claude-code",
		null,
		"review",
		"2020-01-01T00:00:00.000Z",
	);
	await deleteSessionTranscript({ agentId: "review", sessionKey: key, hard: false, changedBy: "test" });
	await updateTranscriptLifecycle({ agentId: "review", sessionKey: key, action: "start" });
	const { signetExportV1Adapter } = await import("./transcript-import-adapter");
	const { buildCompletedTranscriptCommit, commitCompletedTranscriptBatchInTx } = await import(
		"./transcript-import-commit"
	);
	const messages = (replay ? ["old", "ok", "ok"] : ["ok"]).map((content) => ({ role: "user", content }));
	const commit = buildCompletedTranscriptCommit(
		signetExportV1Adapter.parse({
			source: "signet",
			id: key,
			harness: "claude-code",
			agent_id: "review",
			session_key: key,
			project: null,
			timestamp: new Date().toISOString(),
			message_count: messages.length,
			messages,
		}),
		{ agentId: "review", sourceId: "fixture-source", sourceRecordId: `fixture-record-${replay}` },
	);
	const result = await getDbAccessor().withWriteTxAsync((db) => commitCompletedTranscriptBatchInTx(db, [commit]));
	expect(result).toMatchObject([{ outcome: "imported" }]);
	expect((await getStoredSessionTranscriptInfoAsync(commit.canonicalKey, "review"))?.content).toBe(
		JSON.stringify([{ role: "user", content: "ok" }]),
	);
});

test("legacy-only mixed provenance is marked stale without touching pinned memories", async () => {
	await upsertSessionTranscriptAsync(
		"legacy-mixed",
		"User: source",
		"mixed",
		null,
		"review",
		"2020-01-01T00:00:00.000Z",
	);
	await getDbAccessor().withWriteTxAsync((db) => {
		for (const pinned of [0, 1]) {
			const id = `legacy-mixed-${pinned}`;
			db.prepare(
				"INSERT INTO memories (id,content,type,agent_id,source_id,source_type,created_at,updated_at,pinned) VALUES (?,'mixed evidence','fact','review','legacy-mixed','transcript','2020-01-01','2020-01-01',?)",
			).run(id, pinned);
			db.prepare(
				"INSERT INTO derived_memory_sources (derived_memory_id,source_kind,source_id,agent_id,created_at) VALUES (?,'artifact','unrelated-source','review','2020-01-01')",
			).run(id);
		}
	});
	let result = await deleteSessionTranscript({
		agentId: "review",
		sessionKey: "legacy-mixed",
		hard: false,
		changedBy: "test",
	});
	for (let i = 0; result.status === "pending" && i < 20; i++)
		result = await deleteSessionTranscript({
			agentId: "review",
			sessionKey: "legacy-mixed",
			hard: false,
			changedBy: "test",
		});
	expect(result.status).toBe("complete");
	const rows = await getDbAccessor().withReadDbAsync((db) =>
		db.prepare("SELECT pinned,stale_at,source_id FROM memories WHERE id LIKE 'legacy-mixed-%' ORDER BY pinned").all(),
	);
	expect(rows[0]).toMatchObject({ pinned: 0, source_id: null, stale_at: expect.any(String) });
	expect(rows[1]).toMatchObject({ pinned: 1, source_id: null, stale_at: null });
});

test("post-watermark records survive a matching deleted prefix", async () => {
	const key = "fresh-dated-prefix";
	const transcript = "User: hello\nAssistant: hi";
	await upsertSessionTranscriptAsync(key, transcript, "claude-code", null, "review", "2020-01-01T00:00:00.000Z");
	await deleteSessionTranscript({ agentId: "review", sessionKey: key, hard: false, changedBy: "test" });
	await updateTranscriptLifecycle({ agentId: "review", sessionKey: key, action: "start" });
	const timestamp = new Date(Date.now() + 1000).toISOString();
	const raw = [
		{ role: "user", content: "hello", timestamp },
		{ role: "assistant", content: "hi", timestamp },
		{ role: "user", content: "more", timestamp },
	]
		.map((record) => JSON.stringify(record))
		.join("\n");
	await upsertSessionTranscriptAsync(
		key,
		normalizeSessionTranscript("claude-code", raw),
		"claude-code",
		null,
		"review",
		timestamp,
		getDbAccessor(),
		{ rawTranscript: raw },
	);
	expect((await getStoredSessionTranscriptInfoAsync(key, "review"))?.content).toBe(
		"User: hello\nAssistant: hi\nUser: more",
	);
});

test("record timestamps reject pre-watermark replay even when content has changed", async () => {
	await deleted("resume-dated");
	await updateTranscriptLifecycle({ agentId: "review", sessionKey: "resume-dated", action: "start" });
	const raw = [
		JSON.stringify({
			type: "user",
			timestamp: "2020-01-01T00:00:00.000Z",
			message: { role: "user", content: "old changed content" },
		}),
		JSON.stringify({
			type: "assistant",
			timestamp: new Date().toISOString(),
			message: { role: "assistant", content: "fresh dated reply" },
		}),
	].join("\n");
	await upsertSessionTranscriptAsync(
		"resume-dated",
		normalizeSessionTranscript("claude-code", raw),
		"claude-code",
		null,
		"review",
		new Date().toISOString(),
		getDbAccessor(),
		{ rawTranscript: raw },
	);
	expect((await getStoredSessionTranscriptInfoAsync("resume-dated", "review"))?.content).toBe(
		"Assistant: fresh dated reply",
	);
	const output = await writeCanonicalTranscriptFromSnapshot({
		basePath: root,
		agentId: "review",
		harness: "claude-code",
		sessionKey: "resume-dated",
		rawTranscript: raw,
		transcript: normalizeSessionTranscript("claude-code", raw),
		capturedAt: new Date().toISOString(),
	});
	expect(output).toBe("Assistant: fresh dated reply");
	expect(readFileSync(canonicalTranscriptPath(root, "claude-code"), "utf8")).not.toContain("old changed content");
});
