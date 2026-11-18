import { afterAll, beforeAll, expect, test, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "./db-accessor";
import * as runtime from "./db-owner-runtime";
import { DbOwnerError } from "./db-owner-client";
import { deleteSessionTranscript, updateTranscriptLifecycle } from "./session-transcript-lifecycle";
import {
	admitSessionTranscriptInDb,
	getStoredSessionTranscriptInfoAsync,
	updateTranscriptLifecycleInTx,
	upsertSessionTranscriptAsync,
	deleteSessionTranscriptOwned,
} from "./session-transcripts";
import { bypassSession, isSessionBypassed } from "./session-tracker";
import { writeCanonicalTranscriptFromSnapshot } from "./transcript-capture";
import { canonicalTranscriptPath } from "./transcript-jsonl";
import { normalizeSessionTranscript } from "./transcript-normalization";

let root = "";
beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), "transcript-review-"));
	mkdirSync(join(root, "memory"));
	process.env.SIGNET_PATH = root;
	initDbAccessor(join(root, "memory", "memories.db"));
});
afterAll(async () => {
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
	expect(existsSync(directory) ? readdirSync(directory).filter((name) => name.endsWith(".json")) : []).toEqual([]);
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
});

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
