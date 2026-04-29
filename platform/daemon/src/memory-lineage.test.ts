import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Tiktoken } from "js-tiktoken/lite";
import cl100k_base from "js-tiktoken/ranks/cl100k_base";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "./db-accessor";
import {
	MEMORY_PROJECTION_MAX_TOKENS,
	purgeCanonicalNoiseSessions,
	purgeCanonicalNoiseSessionsOnce,
	reindexMemoryArtifacts,
	renderMemoryProjection,
	resetProjectionPurgeState,
	writeSummaryArtifact,
} from "./memory-lineage";
import { NATIVE_MEMORY_BRIDGE_SOURCE_NODE_ID } from "./native-memory-constants";

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
		summary: `Resolved projection pressure for ${input.sessionId} in platform/daemon/src/memory-lineage.ts and verified deterministic ledger rendering stayed readable under load.`,
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
			Reflect.deleteProperty(process.env, "SIGNET_PATH");
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

		const rendered = (await renderMemoryProjection("default")).content;

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
			(db) => db.prepare("SELECT reason FROM memory_artifact_tombstones").all() as Array<{ reason: string }>,
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

	it("writeSummaryArtifact is idempotent for identical content and rejects content mutation", async () => {
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
			summary: "First summary content for the session.",
		});
		expect(second.summaryPath).toBe(first.summaryPath);

		await expect(
			writeSummaryArtifact({
				...base,
				summary: "Completely different content from a retry.",
			}),
		).rejects.toThrow("Refusing to mutate immutable artifact");

		const rows = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare(`SELECT COUNT(*) AS count FROM memory_artifacts WHERE session_id = ? AND source_kind = 'summary'`)
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
				db.prepare("SELECT COUNT(*) AS count FROM memory_artifacts WHERE session_token = ?").get("tok-mixed") as {
					count: number;
				},
		);
		expect(count.count).toBe(2);
	});

	describe("reindexMemoryArtifacts incremental", () => {
		it("first boot: empty cache + empty DB → full scan", async () => {
			await addSummary({ sessionId: "scan-a", project: "/home/nicholai/signet/signetai", minutesAgo: 1 });
			await addSummary({ sessionId: "scan-b", project: "/home/nicholai/signet/signetai", minutesAgo: 2 });

			getDbAccessor().withWriteTx((db) => {
				db.prepare("DELETE FROM memory_artifacts WHERE agent_id = ?").run("default");
			});

			await reindexMemoryArtifacts("default");

			const count = getDbAccessor().withReadDb(
				(db) =>
					db.prepare("SELECT COUNT(*) AS count FROM memory_artifacts WHERE agent_id = ?").get("default") as {
						count: number;
					},
			);
			expect(count.count).toBe(4);
		});

		it("second call with no mtime change → no-op", async () => {
			await addSummary({ sessionId: "no-op", project: "/home/nicholai/signet/signetai", minutesAgo: 1 });

			await reindexMemoryArtifacts("default");

			const before = getDbAccessor().withReadDb(
				(db) =>
					db
						.prepare(
							`SELECT source_path, updated_at
							 FROM memory_artifacts
							 WHERE agent_id = ?
							 ORDER BY source_path ASC`,
						)
						.all("default") as Array<{ source_path: string; updated_at: string }>,
			);

			await Bun.sleep(5);
			await reindexMemoryArtifacts("default");

			const after = getDbAccessor().withReadDb(
				(db) =>
					db
						.prepare(
							`SELECT source_path, updated_at
							 FROM memory_artifacts
							 WHERE agent_id = ?
							 ORDER BY source_path ASC`,
						)
						.all("default") as Array<{ source_path: string; updated_at: string }>,
			);

			expect(after).toEqual(before);
		});

		it("does not trust editable source_path frontmatter during canonical reindex", async () => {
			await addSummary({ sessionId: "spoof-source", project: "/home/nicholai/signet/signetai", minutesAgo: 1 });
			const row = getDbAccessor().withReadDb(
				(db) =>
					db
						.prepare(
							`SELECT source_path
							 FROM memory_artifacts
							 WHERE agent_id = ? AND session_id = ? AND source_kind = 'summary'`,
						)
						.get("default", "spoof-source") as { source_path: string },
			);
			const artifactPath = join(dir, row.source_path);
			writeFileSync(
				artifactPath,
				readFileSync(artifactPath, "utf8").replace(
					"\n---\n",
					`\nsource_path: memory/spoofed-summary.md\nsource_node_id: ${NATIVE_MEMORY_BRIDGE_SOURCE_NODE_ID}\n---\n`,
				),
			);
			getDbAccessor().withWriteTx((db) => {
				db.prepare("DELETE FROM memory_artifacts WHERE agent_id = ?").run("default");
			});

			await reindexMemoryArtifacts("default");

			const rows = getDbAccessor().withReadDb(
				(db) =>
					db
						.prepare(
							`SELECT source_path, source_node_id
							 FROM memory_artifacts
							 WHERE agent_id = ?
							 ORDER BY source_path ASC`,
						)
						.all("default") as Array<{ source_path: string; source_node_id: string | null }>,
			);
			expect(rows.some((candidate) => candidate.source_path === "memory/spoofed-summary.md")).toBe(false);
			expect(
				rows.some((candidate) => candidate.source_path === row.source_path && candidate.source_node_id === null),
			).toBe(true);
		});

		it("new file added → picked up on next call", async () => {
			await addSummary({ sessionId: "new-file-a", project: "/home/nicholai/signet/signetai", minutesAgo: 1 });
			await reindexMemoryArtifacts("default");

			const baseline = getDbAccessor().withReadDb(
				(db) =>
					db.prepare("SELECT COUNT(*) AS count FROM memory_artifacts WHERE agent_id = ?").get("default") as {
						count: number;
					},
			);

			await addSummary({ sessionId: "new-file-b", project: "/home/nicholai/signet/signetai", minutesAgo: 2 });
			getDbAccessor().withWriteTx((db) => {
				db.prepare("DELETE FROM memory_artifacts WHERE session_id = ?").run("new-file-b");
			});

			await reindexMemoryArtifacts("default");

			const after = getDbAccessor().withReadDb(
				(db) =>
					db.prepare("SELECT COUNT(*) AS count FROM memory_artifacts WHERE agent_id = ?").get("default") as {
						count: number;
					},
			);

			expect(after.count).toBe(baseline.count + 2);
		});

		it("scoped reindex does not delete rows for another agent with the same source_path", async () => {
			const stamp = new Date(Date.now() - 60_000).toISOString();
			await writeSummaryArtifact({
				agentId: "other-agent",
				sessionId: "other-agent-session",
				sessionKey: "other-agent-session",
				project: "/home/nicholai/signet/signetai",
				harness: "codex",
				capturedAt: stamp,
				startedAt: stamp,
				endedAt: stamp,
				summary:
					"Resolved projection pressure for other-agent-session in platform/daemon/src/memory-lineage.ts and verified scoped reindex deletes stayed isolated.",
			});

			const before = getDbAccessor().withReadDb(
				(db) =>
					db.prepare("SELECT COUNT(*) AS count FROM memory_artifacts WHERE agent_id = ?").get("other-agent") as {
						count: number;
					},
			);
			expect(before.count).toBeGreaterThan(0);

			await reindexMemoryArtifacts("default");

			const after = getDbAccessor().withReadDb(
				(db) =>
					db.prepare("SELECT COUNT(*) AS count FROM memory_artifacts WHERE agent_id = ?").get("other-agent") as {
						count: number;
					},
			);
			expect(after.count).toBe(before.count);
		});

		it("deleted file → removed from DB", async () => {
			await addSummary({ sessionId: "delete-a", project: "/home/nicholai/signet/signetai", minutesAgo: 1 });
			await addSummary({ sessionId: "delete-b", project: "/home/nicholai/signet/signetai", minutesAgo: 2 });
			await reindexMemoryArtifacts("default");

			const target = getDbAccessor().withReadDb(
				(db) =>
					db
						.prepare(
							`SELECT source_path
							 FROM memory_artifacts
							 WHERE agent_id = ?
							   AND source_kind = 'manifest'
							   AND session_id = ?`,
						)
						.get("default", "delete-b") as { source_path: string },
			);

			rmSync(join(dir, target.source_path), { force: true });
			await reindexMemoryArtifacts("default");

			const row = getDbAccessor().withReadDb(
				(db) =>
					db.prepare("SELECT source_path FROM memory_artifacts WHERE source_path = ?").get(target.source_path) as {
						source_path: string;
					} | null,
			);

			expect(row).toBeNull();
		});

		it("cold cache re-reads artifacts when persisted mtime is missing and updated_at is stale", async () => {
			const agentId = "cache-cold";
			const oldStamp = "2000-01-01T00:00:00.000Z";
			await writeSummaryArtifact({
				agentId,
				sessionId: "cold-cache-session",
				sessionKey: "cold-cache-session",
				project: "/home/nicholai/signet/signetai",
				harness: "codex",
				capturedAt: new Date().toISOString(),
				startedAt: null,
				endedAt: null,
				summary: "Cold cache should trigger incremental refresh when DB already has stale rows.",
			});

			getDbAccessor().withWriteTx((db) => {
				db.prepare("UPDATE memory_artifacts SET source_mtime_ms = NULL, updated_at = ? WHERE agent_id = ?").run(
					oldStamp,
					agentId,
				);
			});

			resetProjectionPurgeState();
			await reindexMemoryArtifacts(agentId);

			const rows = getDbAccessor().withReadDb(
				(db) =>
					db.prepare("SELECT updated_at FROM memory_artifacts WHERE agent_id = ?").all(agentId) as Array<{
						updated_at: string;
					}>,
			);

			expect(rows.length).toBeGreaterThan(0);
			expect(rows.every((row) => row.updated_at !== oldStamp)).toBe(true);
		});

		it("cold cache revalidates artifacts instead of trusting persisted source_mtime_ms", async () => {
			await addSummary({ sessionId: "mtime-seeded-skip", project: "/home/nicholai/signet/signetai", minutesAgo: 1 });
			await reindexMemoryArtifacts("default");

			const oldStamp = "2000-01-01T00:00:00.000Z";
			getDbAccessor().withWriteTx((db) => {
				db.prepare("UPDATE memory_artifacts SET updated_at = ? WHERE agent_id = ?").run(oldStamp, "default");
			});

			resetProjectionPurgeState();
			await reindexMemoryArtifacts("default");

			const rows = getDbAccessor().withReadDb(
				(db) =>
					db.prepare("SELECT updated_at FROM memory_artifacts WHERE agent_id = ?").all("default") as Array<{
						updated_at: string;
					}>,
			);

			expect(rows.length).toBeGreaterThan(0);
			expect(rows.every((row) => row.updated_at !== oldStamp)).toBe(true);
		});

		it("cold cache refreshes upgraded rows missing source_mtime_ms", async () => {
			await addSummary({
				sessionId: "mtime-updated-at-fallback",
				project: "/home/nicholai/signet/signetai",
				minutesAgo: 1,
			});
			await reindexMemoryArtifacts("default");

			const rows = getDbAccessor().withReadDb(
				(db) =>
					db
						.prepare("SELECT source_path FROM memory_artifacts WHERE agent_id = ? ORDER BY source_path ASC")
						.all("default") as Array<{ source_path: string }>,
			);
			expect(rows.length).toBeGreaterThan(0);

			getDbAccessor().withWriteTx((db) => {
				for (const row of rows) {
					const nextUpdatedAt = new Date(statSync(join(dir, row.source_path)).mtimeMs).toISOString();
					db.prepare(
						"UPDATE memory_artifacts SET source_mtime_ms = NULL, updated_at = ? WHERE agent_id = ? AND source_path = ?",
					).run(nextUpdatedAt, "default", row.source_path);
				}
			});

			resetProjectionPurgeState();
			await reindexMemoryArtifacts("default");

			const after = getDbAccessor().withReadDb(
				(db) =>
					db
						.prepare(
							"SELECT source_path, source_mtime_ms FROM memory_artifacts WHERE agent_id = ? ORDER BY source_path ASC",
						)
						.all("default") as Array<{ source_path: string; source_mtime_ms: number | null }>,
			);

			expect(after.length).toBe(rows.length);
			expect(after.every((row) => row.source_mtime_ms === statSync(join(dir, row.source_path)).mtimeMs)).toBe(true);
		});

		it("cold cache still refreshes persisted mtime for files changed while the daemon was down", async () => {
			await addSummary({
				sessionId: "mtime-changed-reprocess",
				project: "/home/nicholai/signet/signetai",
				minutesAgo: 1,
			});
			await reindexMemoryArtifacts("default");

			const target = getDbAccessor().withReadDb(
				(db) =>
					db
						.prepare(
							`SELECT source_path, source_mtime_ms
							 FROM memory_artifacts
							 WHERE agent_id = ?
							   AND source_kind = 'summary'
							 ORDER BY source_path ASC
							 LIMIT 1`,
						)
						.get("default") as { source_path: string; source_mtime_ms: number | null },
			);
			expect(target.source_path).toBeDefined();
			expect(target.source_mtime_ms).not.toBeNull();

			const fullPath = join(dir, target.source_path);
			await Bun.sleep(20);
			const bumped = new Date(Date.now() + 2_000);
			utimesSync(fullPath, bumped, bumped);

			resetProjectionPurgeState();
			await reindexMemoryArtifacts("default");

			const after = getDbAccessor().withReadDb(
				(db) =>
					db
						.prepare("SELECT source_mtime_ms FROM memory_artifacts WHERE agent_id = ? AND source_path = ?")
						.get("default", target.source_path) as { source_mtime_ms: number | null } | null,
			);
			expect(after).not.toBeNull();
			expect(after?.source_mtime_ms).toBeGreaterThan(target.source_mtime_ms ?? 0);
		});

		it("cold cache does not trust sub-second source_mtime_ms drift", async () => {
			await addSummary({
				sessionId: "mtime-subsecond-reprocess",
				project: "/home/nicholai/signet/signetai",
				minutesAgo: 1,
			});
			await reindexMemoryArtifacts("default");

			const target = getDbAccessor().withReadDb(
				(db) =>
					db
						.prepare(
							`SELECT source_path, source_mtime_ms
							 FROM memory_artifacts
							 WHERE agent_id = ?
							   AND source_kind = 'summary'
							 ORDER BY source_path ASC
							 LIMIT 1`,
						)
						.get("default") as { source_path: string; source_mtime_ms: number | null },
			);
			expect(target.source_mtime_ms).not.toBeNull();

			const bumpedMs = (target.source_mtime_ms ?? 0) + 500;
			const bumped = new Date(bumpedMs);
			utimesSync(join(dir, target.source_path), bumped, bumped);

			resetProjectionPurgeState();
			await reindexMemoryArtifacts("default");

			const after = getDbAccessor().withReadDb(
				(db) =>
					db
						.prepare("SELECT source_mtime_ms FROM memory_artifacts WHERE agent_id = ? AND source_path = ?")
						.get("default", target.source_path) as { source_mtime_ms: number | null } | null,
			);
			expect(after).not.toBeNull();
			expect(after?.source_mtime_ms).not.toBe(target.source_mtime_ms);
		});

		it("cold cache still indexes new files when DB rows already exist", async () => {
			await addSummary({
				sessionId: "mtime-existing-db",
				project: "/home/nicholai/signet/signetai",
				minutesAgo: 2,
			});
			await reindexMemoryArtifacts("default");

			const baseline = getDbAccessor().withReadDb(
				(db) =>
					db.prepare("SELECT COUNT(*) AS count FROM memory_artifacts WHERE agent_id = ?").get("default") as {
						count: number;
					},
			);

			await addSummary({
				sessionId: "mtime-new-cold-cache",
				project: "/home/nicholai/signet/signetai",
				minutesAgo: 1,
			});
			getDbAccessor().withWriteTx((db) => {
				db.prepare("DELETE FROM memory_artifacts WHERE agent_id = ? AND session_id = ?").run(
					"default",
					"mtime-new-cold-cache",
				);
			});

			resetProjectionPurgeState();
			await reindexMemoryArtifacts("default");

			const after = getDbAccessor().withReadDb(
				(db) =>
					db.prepare("SELECT COUNT(*) AS count FROM memory_artifacts WHERE agent_id = ?").get("default") as {
						count: number;
					},
			);

			expect(after.count).toBe(baseline.count + 2);
		});

		it("renderMemoryProjection output is identical on cold vs warm call", async () => {
			await addSummary({ sessionId: "parity-a", project: "/home/nicholai/signet/signetai", minutesAgo: 1 });
			await addSummary({ sessionId: "parity-b", project: "/home/nicholai/signet/signetai", minutesAgo: 2 });

			// Cold call: cache is empty, full reindex runs
			const cold = await renderMemoryProjection("default");

			// Warm call: cache is populated, incremental reindex skips all files
			const warm = await renderMemoryProjection("default");

			expect(warm.content).toBe(cold.content);
			expect(warm.fileCount).toBe(cold.fileCount);
		});

		it("cold-start cache reconciles DB rows for files deleted while daemon was down", async () => {
			await addSummary({ sessionId: "ghost-a", project: "/home/nicholai/signet/signetai", minutesAgo: 1 });
			await addSummary({ sessionId: "ghost-b", project: "/home/nicholai/signet/signetai", minutesAgo: 2 });
			await reindexMemoryArtifacts("default");

			const target = getDbAccessor().withReadDb(
				(db) =>
					db
						.prepare(
							`SELECT source_path
						 FROM memory_artifacts
						 WHERE agent_id = ? AND source_kind = 'manifest' AND session_id = ?`,
						)
						.get("default", "ghost-b") as { source_path: string },
			);

			rmSync(join(dir, target.source_path), { force: true });
			resetProjectionPurgeState();

			await reindexMemoryArtifacts("default");

			const row = getDbAccessor().withReadDb(
				(db) =>
					db.prepare("SELECT source_path FROM memory_artifacts WHERE source_path = ?").get(target.source_path) as {
						source_path: string;
					} | null,
			);
			expect(row).toBeNull();
		});

		it("clears stale memory_md_refs on manifests that drop out of the ledger", async () => {
			await addSummary({ sessionId: "ref-a", project: "/home/nicholai/signet/signetai", minutesAgo: 2 });
			await addSummary({ sessionId: "ref-b", project: "/home/nicholai/signet/signetai", minutesAgo: 1 });

			await renderMemoryProjection("default");

			const manifestRow = getDbAccessor().withReadDb(
				(db) =>
					db
						.prepare(
							`SELECT source_path
						 FROM memory_artifacts
						 WHERE agent_id = ? AND source_kind = 'manifest' AND session_id = ?`,
						)
						.get("default", "ref-b") as { source_path: string },
			);
			const manifestPath = join(dir, manifestRow.source_path);
			const before = readFileSync(manifestPath, "utf8");
			expect(before).toContain("Session Ledger");

			getDbAccessor().withWriteTx((db) => {
				db.prepare("DELETE FROM memory_artifacts WHERE session_id = ?").run("ref-b");
			});

			await renderMemoryProjection("default");

			const after = readFileSync(manifestPath, "utf8");
			expect(after).not.toContain("Session Ledger");
		});
	});

	it("isolates prevLedgerRefs across agents", async () => {
		const stamp = (minutesAgo: number): string => new Date(Date.now() - minutesAgo * 60_000).toISOString();

		await writeSummaryArtifact({
			agentId: "alice",
			sessionId: "alice-s1",
			sessionKey: "alice-s1",
			project: "/proj/alice",
			harness: "codex",
			capturedAt: stamp(3),
			startedAt: stamp(3),
			endedAt: stamp(3),
			summary: "Alice session one work.",
		});
		await writeSummaryArtifact({
			agentId: "alice",
			sessionId: "alice-s2",
			sessionKey: "alice-s2",
			project: "/proj/alice",
			harness: "codex",
			capturedAt: stamp(2),
			startedAt: stamp(2),
			endedAt: stamp(2),
			summary: "Alice session two work.",
		});
		await writeSummaryArtifact({
			agentId: "bob",
			sessionId: "bob-s1",
			sessionKey: "bob-s1",
			project: "/proj/bob",
			harness: "codex",
			capturedAt: stamp(1),
			startedAt: stamp(1),
			endedAt: stamp(1),
			summary: "Bob session one work.",
		});

		const aliceResult1 = await renderMemoryProjection("alice");
		expect(aliceResult1.content).toContain("alice-s1");

		const bobResult1 = await renderMemoryProjection("bob");
		expect(bobResult1.content).toContain("bob-s1");

		getDbAccessor().withWriteTx((db) => {
			db.prepare("DELETE FROM memory_artifacts WHERE session_id = ? AND agent_id = ?").run("alice-s2", "alice");
		});

		const aliceResult2 = await renderMemoryProjection("alice");

		const bobResult2 = await renderMemoryProjection("bob");
		expect(bobResult2.content).toContain("bob-s1");

		const bobManifest = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare(
						`SELECT source_path FROM memory_artifacts
						 WHERE agent_id = ? AND source_kind = 'manifest' AND session_id = ?`,
					)
					.get("bob", "bob-s1") as { source_path: string } | null,
		);
		if (bobManifest) {
			const content = readFileSync(join(dir, bobManifest.source_path), "utf8");
			expect(content).toContain("Session Ledger");
		}

		expect(aliceResult2.content).not.toContain("bob-s1");
		expect(bobResult2.content).not.toContain("alice-s1");
	});

	it("concurrent reindexMemoryArtifacts calls for the same agent are serialized via single-flight", async () => {
		await addSummary({ sessionId: "flight-1", project: "/home/u/p", minutesAgo: 1 });
		await addSummary({ sessionId: "flight-2", project: "/home/u/p", minutesAgo: 2 });
		await addSummary({ sessionId: "flight-3", project: "/home/u/p", minutesAgo: 3 });

		const a = reindexMemoryArtifacts("default");
		const b = reindexMemoryArtifacts("default");
		const c = reindexMemoryArtifacts("default");

		await Promise.all([a, b, c]);

		const rows = getDbAccessor().withReadDb((db) => {
			return db
				.prepare("SELECT DISTINCT session_id FROM memory_artifacts WHERE agent_id = 'default' ORDER BY session_id")
				.all() as Array<{ session_id: string }>;
		});
		const ids = rows.map((r) => r.session_id);
		expect(ids).toContain("flight-1");
		expect(ids).toContain("flight-2");
		expect(ids).toContain("flight-3");
	});

	it("concurrent reindexMemoryArtifacts for different agents complete through the serialized queue", async () => {
		await writeSummaryArtifact({
			agentId: "x",
			sessionId: "x-s1",
			sessionKey: "x-s1",
			project: "/home/u/p",
			harness: "codex",
			capturedAt: new Date(Date.now() - 60_000).toISOString(),
			startedAt: new Date(Date.now() - 60_000).toISOString(),
			endedAt: new Date(Date.now() - 60_000).toISOString(),
			summary: "X session work.",
		});
		await writeSummaryArtifact({
			agentId: "y",
			sessionId: "y-s1",
			sessionKey: "y-s1",
			project: "/home/u/p",
			harness: "codex",
			capturedAt: new Date(Date.now() - 120_000).toISOString(),
			startedAt: new Date(Date.now() - 120_000).toISOString(),
			endedAt: new Date(Date.now() - 120_000).toISOString(),
			summary: "Y session work.",
		});

		const [, ,] = await Promise.all([reindexMemoryArtifacts("x"), reindexMemoryArtifacts("y")]);

		const xRows = getDbAccessor().withReadDb(
			(db) =>
				db.prepare("SELECT session_id FROM memory_artifacts WHERE agent_id = 'x'").all() as Array<{
					session_id: string;
				}>,
		);
		const yRows = getDbAccessor().withReadDb(
			(db) =>
				db.prepare("SELECT session_id FROM memory_artifacts WHERE agent_id = 'y'").all() as Array<{
					session_id: string;
				}>,
		);
		expect(xRows.some((r) => r.session_id === "x-s1")).toBe(true);
		expect(yRows.some((r) => r.session_id === "y-s1")).toBe(true);
	});

	it("serializes concurrent global and scoped reindexMemoryArtifacts calls", async () => {
		await writeSummaryArtifact({
			agentId: "global-a",
			sessionId: "global-a-s1",
			sessionKey: "global-a-s1",
			project: "/home/u/p",
			harness: "codex",
			capturedAt: new Date(Date.now() - 60_000).toISOString(),
			startedAt: new Date(Date.now() - 60_000).toISOString(),
			endedAt: new Date(Date.now() - 60_000).toISOString(),
			summary: "Global A session work.",
		});
		await writeSummaryArtifact({
			agentId: "global-b",
			sessionId: "global-b-s1",
			sessionKey: "global-b-s1",
			project: "/home/u/p",
			harness: "codex",
			capturedAt: new Date(Date.now() - 120_000).toISOString(),
			startedAt: new Date(Date.now() - 120_000).toISOString(),
			endedAt: new Date(Date.now() - 120_000).toISOString(),
			summary: "Global B session work.",
		});

		await Promise.all([reindexMemoryArtifacts(), reindexMemoryArtifacts("global-a")]);

		const rows = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare("SELECT agent_id, session_id FROM memory_artifacts WHERE session_id IN (?, ?)")
					.all("global-a-s1", "global-b-s1") as Array<{
					agent_id: string;
					session_id: string;
				}>,
		);

		expect(rows.some((r) => r.agent_id === "global-a" && r.session_id === "global-a-s1")).toBe(true);
		expect(rows.some((r) => r.agent_id === "global-b" && r.session_id === "global-b-s1")).toBe(true);
	});
});
