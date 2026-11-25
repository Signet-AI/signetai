import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mock } from "bun:test";
import * as core from "../../../platform/core/dist/index";

const samples: Record<string, number[]> = { remember: [], "prompt-submit capture": [] };
let path = "remember";
let measuring = false;
const realHelper = core.compartmentForWrite;
mock.module("../../../platform/core/dist/index", () => ({
	...core,
	compartmentForWrite: (...args: Parameters<typeof realHelper>) => {
		const start = performance.now();
		const result = realHelper(...args);
		if (measuring) samples[path]?.push(performance.now() - start);
		return result;
	},
}));
const { txIngestEnvelope } = await import("../../../platform/daemon/src/transactions");
const { writeSessionTranscriptRow } = await import("../../../platform/daemon/src/session-transcripts");
const root = await mkdtemp(join(tmpdir(), "signet-l4-benchmark-"));
process.env.SIGNET_PATH = root;
process.env.SIGNET_WORKSPACE = root;
const { initDbAccessor, getDbAccessor, closeDbAccessor } = await import("../../../platform/daemon/src/db-accessor");
initDbAccessor(join(root, "signet.db"), { agentsDir: root });
const accessor = getDbAccessor();
await accessor.withWriteTxAsync((db) =>
	db.exec(
		"INSERT INTO users(id,username,display_name,role) VALUES('l4-bench-user','bench','Bench','member'); INSERT INTO classifications(id,name) VALUES('cls_l4_bench_agent','Bench agent'),('cls_l4_bench_session','Bench session'),('cls_l4_bench_source','Bench source'); INSERT INTO classification_assignments VALUES('agent','default','default','cls_l4_bench_agent','l4-bench-user','now'),('session','l4-bench-session','default','cls_l4_bench_session','l4-bench-user','now'),('source','l4-bench-source','default','cls_l4_bench_source','l4-bench-user','now')",
	),
);
const author = { userId: "l4-bench-user", credential: "session:benchmark" };
try {
	for (const name of Object.keys(samples)) {
		path = name;
		for (let i = 0; i < 250; i++) {
			measuring = i >= 50;
			await accessor.withWriteTxAsync((db) => {
				if (name === "remember") {
					txIngestEnvelope(db, {
						author,
						id: `bench-${i}`,
						content: `Classified benchmark evidence ${i}`,
						contentHash: `bench-hash-${i}`,
						who: "bench",
						why: null,
						project: null,
						importance: 0.5,
						type: "fact",
						tags: null,
						pinned: 0,
						sourceType: "user",
						sourceId: "l4-bench-source",
						sessionKey: "l4-bench-session",
						agentId: "default",
						createdAt: "2026-11-25T12:00:00.000Z",
					});
				} else {
					db.prepare("DELETE FROM session_transcripts WHERE session_key='l4-bench-session'").run();
					assert.equal(
						writeSessionTranscriptRow(db, {
							author,
							agentId: "default",
							sessionKey: "l4-bench-session",
							transcript: `User: Prompt evidence ${i}`,
							harness: "codex",
							project: null,
							append: true,
							capturedAt: "2026-11-25T12:00:00.000Z",
						}),
						"written",
					);
				}
			});
		}
		measuring = false;
		const timings = samples[name];
		assert(timings && timings.length >= 200, "real writer did not call timed helper");
		timings.sort((a, b) => a - b);
		const p95 = timings[Math.ceil(timings.length * 0.95) - 1];
		assert(p95 !== undefined);
		console.log(
			JSON.stringify({
				benchmark: "actual writer compartmentForWrite duration",
				path: name,
				runtime: `Bun ${Bun.version}`,
				platform: process.platform,
				arch: process.arch,
				sampleCount: timings.length,
				warmupWrites: 50,
				p95Ms: p95,
				httpLatencyIncluded: false,
			}),
		);
		assert(p95 < 1, `${name} helper p95 ${p95}ms exceeds 1ms`);
	}
	await accessor.withReadDbAsync((db) => {
		const row = db.prepare("SELECT author_user_id,compartment_id FROM memories WHERE id='bench-249'").get();
		assert.equal(row?.author_user_id, author.userId);
		assert.equal(typeof row?.compartment_id, "number");
		const transcript = db
			.prepare("SELECT speaker_user_id,compartment_id FROM session_transcripts WHERE session_key='l4-bench-session'")
			.get();
		assert.equal(transcript?.speaker_user_id, author.userId);
		assert.equal(typeof transcript?.compartment_id, "number");
	});
} finally {
	await closeDbAccessor();
	await rm(root, { recursive: true, force: true });
}
process.exit(0);
