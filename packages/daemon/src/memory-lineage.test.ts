import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Tiktoken } from "js-tiktoken/lite";
import cl100k_base from "js-tiktoken/ranks/cl100k_base";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "./db-accessor";
import {
	MEMORY_PROJECTION_MAX_TOKENS,
	purgeCanonicalNoiseSessions,
	purgeCanonicalNoiseSessionsOnce,
	renderMemoryProjection,
	resetProjectionPurgeState,
	writeSummaryArtifact,
} from "./memory-lineage";

const tok = new Tiktoken(cl100k_base);

let dir = "";
let prev: string | undefined;

function resetWorkspace(): void {
	closeDbAccessor();
	resetProjectionPurgeState();
	rmSync(join(dir, "memory"), { recursive: true, force: true });
	mkdirSync(join(dir, "memory"), { recursive: true });
	initDbAccessor(join(dir, "memory", "memories.db"));
}

async function addSummary(input: {
	readonly sessionId: string;
	readonly project: string;
	readonly minutesAgo: number;
}): Promise<void> {
	const stamp = new Date(Date.now() - input.minutesAgo * 60_000).toISOString();
	await writeSummaryArtifact({
		agentId: "default",
		sessionId: input.sessionId,
		sessionKey: input.sessionId,
		project: input.project,
		harness: "codex",
		capturedAt: stamp,
		startedAt: stamp,
		endedAt: stamp,
		summary: `Resolved projection pressure for ${input.sessionId} in packages/daemon/src/memory-lineage.ts and verified deterministic ledger rendering stayed readable under load.`,
	});
}

describe("memory-lineage", () => {
	beforeAll(() => {
		prev = process.env.SIGNET_PATH;
		dir = mkdtempSync(join(tmpdir(), "signet-memory-lineage-"));
		process.env.SIGNET_PATH = dir;
		writeFileSync(
			join(dir, "agent.yaml"),
			`memory:
  pipelineV2:
    enabled: false
`,
		);
		resetWorkspace();
	});

	beforeEach(() => {
		resetWorkspace();
	});

	afterAll(() => {
		closeDbAccessor();
		rmSync(dir, { recursive: true, force: true });
		if (prev === undefined) {
			delete process.env.SIGNET_PATH;
			return;
		}
		process.env.SIGNET_PATH = prev;
	});

	it("filters /tmp artifact sessions from the ledger and clips older rows within budget", async () => {
		for (let i = 0; i < 220; i++) {
			await addSummary({
				sessionId: `real-${i}`,
				project: "/home/nicholai/signet/signetai",
				minutesAgo: i,
			});
		}
		for (let i = 0; i < 40; i++) {
			await addSummary({
				sessionId: `tmp-${i}`,
				project: "/tmp/signetai",
				minutesAgo: i + 500,
			});
		}

		const rendered = renderMemoryProjection("default").content;

		expect(rendered).toContain("## Session Ledger (Last 30 Days)");
		expect(rendered).toContain("older ledger rows clipped:");
		expect(rendered).not.toContain("/tmp/signetai");
		expect(tok.encode(rendered).length).toBeLessThanOrEqual(MEMORY_PROJECTION_MAX_TOKENS);
	});

	it("runs projection purge at most once per workspace state", async () => {
		await addSummary({
			sessionId: "drop-once",
			project: "/tmp/signetai",
			minutesAgo: 1,
		});

		expect(purgeCanonicalNoiseSessionsOnce("default", "test cleanup")).toBe(1);
		expect(purgeCanonicalNoiseSessionsOnce("default", "test cleanup")).toBe(0);
	});

	it("tombstones existing temp-session artifacts without touching real sessions", async () => {
		await addSummary({
			sessionId: "keep-me",
			project: "/home/nicholai/signet/signetai",
			minutesAgo: 1,
		});
		await addSummary({
			sessionId: "drop-me",
			project: "/tmp/signetai",
			minutesAgo: 2,
		});

		const removed = purgeCanonicalNoiseSessions("default", "test cleanup");

		expect(removed).toBe(1);

		const rows = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare(
						`SELECT project, session_token
						 FROM memory_artifacts
						 WHERE source_kind = 'summary'
						 ORDER BY project ASC`,
					)
					.all() as Array<{ project: string | null; session_token: string }>,
		);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.project).toBe("/home/nicholai/signet/signetai");

		const tombstones = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare(`SELECT reason FROM memory_artifact_tombstones`)
					.all() as Array<{ reason: string }>,
		);
		expect(tombstones).toEqual([{ reason: "test cleanup" }]);
	});

	it("removes canonical noise artifact files after tombstoning them", async () => {
		await addSummary({
			sessionId: "drop-file",
			project: "/tmp/signetai",
			minutesAgo: 1,
		});

		const row = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare(
						`SELECT source_path
						 FROM memory_artifacts
						 WHERE session_id = ? AND source_kind = 'summary'`,
					)
					.get("drop-file") as { source_path: string },
		);
		expect(existsSync(join(dir, row.source_path))).toBe(true);

		expect(purgeCanonicalNoiseSessions("default", "test cleanup")).toBe(1);
		expect(existsSync(join(dir, row.source_path))).toBe(false);
	});

	it("writeSummaryArtifact is idempotent when called twice for the same session", async () => {
		const stamp = new Date().toISOString();
		const base = {
			agentId: "default",
			sessionId: "idem-test",
			sessionKey: "idem-test",
			project: "/home/user/project",
			harness: "codex",
			capturedAt: stamp,
			startedAt: stamp,
			endedAt: stamp,
		};

		const first = await writeSummaryArtifact({
			...base,
			summary: "First summary content for the session.",
		});
		expect(first.summaryPath).toBeTruthy();

		const second = await writeSummaryArtifact({
			...base,
			summary: "Completely different content from a retry.",
		});
		expect(second.summaryPath).toBe(first.summaryPath);

		const rows = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare(
						`SELECT COUNT(*) AS count FROM memory_artifacts WHERE session_id = ? AND source_kind = 'summary'`,
					)
					.get("idem-test") as { count: number },
		);
		expect(rows.count).toBe(1);
	});

	it("keeps canonical sessions when any artifact row carries a real project", () => {
		const now = new Date().toISOString();
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO memory_artifacts (
					agent_id, source_path, source_sha256, source_kind, session_id,
					session_key, session_token, project, harness, captured_at,
					started_at, ended_at, manifest_path, source_node_id,
					memory_sentence, memory_sentence_quality, content, updated_at
				) VALUES (?, ?, ?, 'summary', ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 'ok', ?, ?)`,
			).run(
				"default",
				"memory/mixed-one.md",
				"sha-mixed-one",
				"tmp-mixed",
				null,
				"tok-mixed",
				null,
				"test",
				now,
				null,
				null,
				null,
				"noise sentence",
				"noise content",
				now,
			);
			db.prepare(
				`INSERT INTO memory_artifacts (
					agent_id, source_path, source_sha256, source_kind, session_id,
					session_key, session_token, project, harness, captured_at,
					started_at, ended_at, manifest_path, source_node_id,
					memory_sentence, memory_sentence_quality, content, updated_at
				) VALUES (?, ?, ?, 'transcript', ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 'ok', ?, ?)`,
			).run(
				"default",
				"memory/mixed-two.md",
				"sha-mixed-two",
				"real-mixed",
				"real-mixed",
				"tok-mixed",
				"/home/nicholai/signet/signetai",
				"codex",
				now,
				null,
				null,
				null,
				"real sentence",
				"real content",
				now,
			);
		});

		expect(purgeCanonicalNoiseSessions("default", "test cleanup")).toBe(0);

		const count = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare(`SELECT COUNT(*) AS count FROM memory_artifacts WHERE session_token = ?`)
					.get("tok-mixed") as { count: number },
		);
		expect(count.count).toBe(2);
	});
});
