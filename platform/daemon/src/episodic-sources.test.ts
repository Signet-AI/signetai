import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "./db-accessor";
import {
	type EpisodicCursor,
	readEpisodicSource,
	readRecentEpisodicSources,
	searchEpisodicSources,
} from "./episodic-sources";

describe("episodic source selection", () => {
	let dir = "";

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "signet-episodic-sources-"));
		mkdirSync(join(dir, "memory"), { recursive: true });
		initDbAccessor(join(dir, "memory", "memories.db"));
	});

	afterEach(() => {
		closeDbAccessor();
		rmSync(dir, { recursive: true, force: true });
	});

	it("resolves artifacts, live transcripts, and compaction summaries without crossing agents", () => {
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO memory_artifacts
				 (agent_id, source_path, source_sha256, source_kind, session_id, session_key, session_token,
				  project, harness, captured_at, content, updated_at, is_deleted)
				 VALUES ('ant', 'sources/note.md', 'sha', 'source_obsidian_markdown', 'session-a', 'session-a', 'token-a',
				  '/repo', 'obsidian', '2026-08-01T10:00:00.000Z', 'artifact evidence', '2026-08-01T10:00:00.000Z', 0)`,
			).run();
			db.prepare(
				`INSERT INTO session_transcripts
				 (session_key, content, harness, project, agent_id, created_at, updated_at)
				 VALUES ('live-a', 'live transcript evidence', 'pi', '/repo', 'ant', '2026-08-01T11:00:00.000Z', '2026-08-01T11:01:00.000Z')`,
			).run();
			db.prepare(
				`INSERT INTO session_summaries
				 (id, project, depth, kind, content, token_count, earliest_at, latest_at, session_key, harness,
				  agent_id, source_type, source_ref, meta_json, created_at)
				 VALUES ('compaction-a', '/repo', 0, 'session', 'compaction evidence', 3,
				  '2026-08-01T12:00:00.000Z', '2026-08-01T12:00:00.000Z', 'session-a', 'pi',
				  'ant', 'compaction', 'session-a', '{}', '2026-08-01T12:00:00.000Z')`,
			).run();
			db.prepare(
				`INSERT INTO session_summaries
				 (id, project, depth, kind, content, token_count, earliest_at, latest_at, session_key, harness,
				  agent_id, source_type, source_ref, meta_json, created_at)
				 VALUES ('chunk-a', '/repo', 0, 'session', 'derived chunk', 2,
				  '2026-08-01T12:01:00.000Z', '2026-08-01T12:01:00.000Z', NULL, 'pi',
				  'ant', 'chunk', 'session-a', '{}', '2026-08-01T12:01:00.000Z')`,
			).run();
			db.prepare(
				`INSERT INTO session_transcripts
				 (session_key, content, harness, project, agent_id, created_at, updated_at)
				 VALUES ('live-a', 'other agent transcript', 'pi', '/other', 'other', '2026-08-01T11:00:00.000Z', '2026-08-01T11:01:00.000Z')`,
			).run();
		});

		const read = (from: string) => getDbAccessor().withReadDb((db) => readEpisodicSource(db, { agentId: "ant", from }));

		expect(read("source:sources/note.md")).toMatchObject({
			kind: "artifact",
			sourceKind: "source_obsidian_markdown",
			sourcePath: "sources/note.md",
			content: "artifact evidence",
		});
		expect(read("transcript:live-a")).toMatchObject({
			kind: "transcript",
			harness: "pi",
			content: "live transcript evidence",
		});
		expect(read("summary:compaction-a")).toMatchObject({
			kind: "summary",
			sourceKind: "compaction",
			sourceId: "session-a",
			content: "compaction evidence",
		});
		expect(read("summary:chunk-a")).toBeNull();
		expect(getDbAccessor().withReadDb((db) => readRecentEpisodicSources(db, "ant", 10))).toMatchObject([
			{ kind: "summary", id: "compaction-a" },
			{ kind: "transcript", id: "live-a" },
			{ kind: "artifact", id: "sources/note.md" },
		]);
		expect(
			getDbAccessor().withReadDb((db) =>
				readRecentEpisodicSources(db, "ant", 10, undefined, "2026-08-01T10:30:00.000Z"),
			),
		).toMatchObject([
			{ kind: "summary", id: "compaction-a" },
			{ kind: "transcript", id: "live-a" },
		]);
	});

	it("marks transcripts completed when a session-end summary job is triggered, even if it fails", () => {
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO session_transcripts
				 (session_key, content, harness, project, agent_id, created_at, updated_at)
				 VALUES ('running-a', 'intermediate investigation states', 'pi', '/repo', 'ant',
				  '2026-08-07T06:14:00.000Z', '2026-08-07T06:30:00.000Z')`,
			).run();
			db.prepare(
				`INSERT INTO session_transcripts
				 (session_key, content, harness, project, agent_id, created_at, updated_at)
				 VALUES ('settled-b', 'settled outcome', 'pi', '/repo', 'ant',
				  '2026-08-07T05:00:00.000Z', '2026-08-07T05:20:00.000Z')`,
			).run();
			db.prepare(
				`INSERT INTO session_transcripts
				 (session_key, content, harness, project, agent_id, created_at, updated_at)
				 VALUES ('timed-out-c', 'outcome despite summary timeout', 'pi', '/repo', 'ant',
				  '2026-08-07T04:00:00.000Z', '2026-08-07T04:30:00.000Z')`,
			).run();
			db.prepare(
				`INSERT INTO session_transcripts
				 (session_key, content, harness, project, agent_id, created_at, updated_at)
				 VALUES ('checkpointed-d', 'mid-session checkpointed states', 'pi', '/repo', 'ant',
				  '2026-08-07T07:00:00.000Z', '2026-08-07T07:10:00.000Z')`,
			).run();
			// Session ended normally: summary job triggered (status pending).
			db.prepare(
				`INSERT INTO summary_jobs
				 (id, session_key, session_id, harness, project, agent_id, transcript,
				  trigger, captured_at, started_at, ended_at, status, created_at)
				 VALUES ('job-settled', 'settled-b', 'settled-b', 'pi', '/repo', 'ant',
				  'settled outcome', 'session_end', '2026-08-07T05:20:00.000Z',
				  '2026-08-07T05:20:00.000Z', '2026-08-07T05:20:00.000Z', 'pending',
				  '2026-08-07T05:20:00.000Z')`,
			).run();
			// Summary timed out / failed: the job row still proves the session ended.
			db.prepare(
				`INSERT INTO summary_jobs
				 (id, session_key, session_id, harness, project, agent_id, transcript,
				  trigger, captured_at, started_at, ended_at, status, created_at)
				 VALUES ('job-timed-out', 'timed-out-c', 'timed-out-c', 'pi', '/repo', 'ant',
				  'outcome despite summary timeout', 'session_end', '2026-08-07T04:30:00.000Z',
				  '2026-08-07T04:30:00.000Z', null, 'failed',
				  '2026-08-07T04:30:00.000Z')`,
			).run();
			// A mid-session checkpoint extract is NOT a session-end signal.
			db.prepare(
				`INSERT INTO summary_jobs
				 (id, session_key, session_id, harness, project, agent_id, transcript,
				  trigger, captured_at, started_at, ended_at, status, created_at)
				 VALUES ('job-checkpoint', 'checkpointed-d', 'checkpointed-d', 'pi', '/repo', 'ant',
				  'mid-session checkpointed states', 'checkpoint_extract', '2026-08-07T07:10:00.000Z',
				  '2026-08-07T07:10:00.000Z', null, 'completed',
				  '2026-08-07T07:10:00.000Z')`,
			).run();
		});

		const read = (from: string) => getDbAccessor().withReadDb((db) => readEpisodicSource(db, { agentId: "ant", from }));
		// A still-running session has no session-end job yet: not settled evidence.
		expect(read("transcript:running-a")).toMatchObject({ kind: "transcript", completed: false });
		// A session-end summary job was triggered: settled, even while pending.
		expect(read("transcript:settled-b")).toMatchObject({ kind: "transcript", completed: true });
		// A failed/timed-out summary job still proves the session ended.
		expect(read("transcript:timed-out-c")).toMatchObject({ kind: "transcript", completed: true });
		// A mid-session checkpoint extract does not settle the session.
		expect(read("transcript:checkpointed-d")).toMatchObject({ kind: "transcript", completed: false });
	});

	it("orders timezone-less artifact timestamps like SQLite's UTC cursor", () => {
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO memory_artifacts
				 (agent_id, source_path, source_sha256, source_kind, session_id, session_token, captured_at, content, updated_at, is_deleted)
				 VALUES ('ant', 'sources/older.md', 'sha', 'source_obsidian_markdown', 'session-a', 'token-a',
				  '2026-07-31 23:00:00', 'older artifact', '2026-07-31 23:00:00', 0)`,
			).run();
			db.prepare(
				`INSERT INTO session_summaries
				 (id, agent_id, content, token_count, depth, kind, source_type, earliest_at, latest_at, created_at)
				 VALUES ('newer-summary', 'ant', 'newer summary', 2, 0, 'session', 'summary',
				  '2026-08-01T03:00:00.000Z', '2026-08-01T03:00:00.000Z', '2026-08-01T03:00:00.000Z')`,
			).run();
		});
		expect(
			getDbAccessor().withReadDb((db) => readRecentEpisodicSources(db, "ant", 10, undefined, null, "oldest")),
		).toMatchObject([
			{ kind: "artifact", id: "sources/older.md" },
			{ kind: "summary", id: "newer-summary" },
		]);
	});

	it("uses the temporal-DAG node once for canonical session evidence", () => {
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO memories
				 (id, content, type, importance, agent_id, visibility, created_at, updated_at, memory_kind)
				 VALUES ('compaction-recall-projection', 'compaction evidence', 'session_summary', 0.8,
				 'ant', 'global', '2026-08-01T12:00:00.000Z', '2026-08-01T12:00:00.000Z', 'episodic')`,
			).run();
			db.prepare(
				`INSERT INTO memory_artifacts
				 (agent_id, source_path, source_sha256, source_kind, session_id, session_key, session_token,
				  captured_at, content, updated_at, is_deleted)
				 VALUES ('ant', 'sessions/compaction.md', 'sha-compaction', 'compaction', 'session-a', 'session-a', 'token-a',
				  '2026-08-01T12:00:00.000Z', 'compaction evidence', '2026-08-01T12:00:00.000Z', 0)`,
			).run();
			db.prepare(
				`INSERT INTO session_summaries
				 (id, content, token_count, depth, kind, source_type, earliest_at, latest_at, session_key, created_at, agent_id)
				 VALUES ('compaction-node', 'compaction evidence', 2, 0, 'session', 'compaction',
				  '2026-08-01T12:00:00.000Z', '2026-08-01T12:00:00.000Z', 'session-a', '2026-08-01T12:00:00.000Z', 'ant')`,
			).run();
		});

		expect(
			getDbAccessor().withReadDb((db) => readRecentEpisodicSources(db, "ant", 10, undefined, null, "oldest")),
		).toMatchObject([{ kind: "summary", id: "compaction-node", sourceKind: "compaction" }]);
	});

	it("uses the temporal-DAG node once for sessionless compaction evidence", () => {
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO memory_artifacts
				 (agent_id, source_path, source_sha256, source_kind, session_id, session_token,
				  captured_at, content, updated_at, is_deleted)
				 VALUES ('ant', 'sessions/sessionless-compaction.md', 'sha-sessionless', 'compaction', 'sessionless',
				 'token-sessionless', '2026-08-01T12:30:00.000Z', 'sessionless compaction evidence',
				 '2026-08-01T12:30:00.000Z', 0)`,
			).run();
			db.prepare(
				`INSERT INTO session_summaries
				 (id, content, token_count, depth, kind, source_type, earliest_at, latest_at, created_at, agent_id)
				 VALUES ('sessionless-compaction-node', 'sessionless compaction evidence', 2, 0, 'session', 'compaction',
				  '2026-08-01T12:30:00.000Z', '2026-08-01T12:30:00.000Z', '2026-08-01T12:30:00.000Z', 'ant')`,
			).run();
		});

		expect(
			getDbAccessor().withReadDb((db) => readRecentEpisodicSources(db, "ant", 10, undefined, null, "oldest")),
		).toMatchObject([{ kind: "summary", id: "sessionless-compaction-node", sourceKind: "compaction" }]);
	});

	it("retains a session artifact when its canonical transcript is unavailable", () => {
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO memory_artifacts
				 (agent_id, source_path, source_sha256, source_kind, session_id, session_token,
				  captured_at, content, updated_at, is_deleted)
				 VALUES ('ant', 'sessions/recovery-manifest.md', 'sha-manifest', 'manifest', 'session-recovery',
				 'token-recovery', '2026-08-01T12:00:00.000Z', 'structural metadata only',
				 '2026-08-01T12:00:00.000Z', 0)`,
			).run();
			db.prepare(
				`INSERT INTO memory_artifacts
				 (agent_id, source_path, source_sha256, source_kind, session_id, session_key, session_token,
				  captured_at, content, updated_at, is_deleted)
				 VALUES ('ant', 'sessions/recovery-transcript.md', 'sha-recovery', 'transcript', 'session-recovery',
				 'session-recovery', 'token-recovery', '2026-08-01T13:00:00.000Z', 'recovered transcript',
				 '2026-08-01T13:00:00.000Z', 0)`,
			).run();
		});

		expect(
			getDbAccessor().withReadDb((db) => readRecentEpisodicSources(db, "ant", 10, undefined, null, "oldest")),
		).toMatchObject([{ kind: "artifact", id: "sessions/recovery-transcript.md", sourceKind: "transcript" }]);
	});

	it("searches only live episodic evidence across source stores", () => {
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO memories
				 (id, content, type, agent_id, visibility, memory_kind, created_at, updated_at)
				 VALUES ('matching-memory', 'Needle in a manual memory', 'fact', 'ant', 'global', 'episodic',
				  '2026-08-01T10:00:00.000Z', '2026-08-01T10:00:00.000Z')`,
			).run();
			db.prepare(
				`INSERT INTO memory_artifacts
				 (agent_id, source_path, source_sha256, source_kind, session_id, session_token, captured_at, content, updated_at, is_deleted)
				 VALUES ('ant', 'sources/needle.md', 'needle-sha', 'source_markdown', 'session-a', 'token-a',
				  '2026-08-01T11:00:00.000Z', 'Needle in source evidence', '2026-08-01T11:00:00.000Z', 0)`,
			).run();
			db.prepare(
				`INSERT INTO memories
				 (id, content, type, agent_id, visibility, memory_kind, created_at, updated_at)
				 VALUES ('derived-memory', 'Needle in derived state', 'fact', 'ant', 'global', 'semantic',
				  '2026-08-01T12:00:00.000Z', '2026-08-01T12:00:00.000Z')`,
			).run();
			db.prepare(
				`INSERT INTO memory_artifacts
				 (agent_id, source_path, source_sha256, source_kind, session_id, session_token, captured_at, content, updated_at, is_deleted)
				 VALUES ('other', 'sources/other.md', 'other-sha', 'source_markdown', 'session-b', 'token-b',
				  '2026-08-01T13:00:00.000Z', 'Needle for another agent', '2026-08-01T13:00:00.000Z', 0)`,
			).run();
		});

		const matches = getDbAccessor().withReadDb((db) => searchEpisodicSources(db, { agentId: "ant", query: "Needle" }));
		expect(matches).toMatchObject([
			{ kind: "artifact", id: "sources/needle.md", content: "Needle in source evidence" },
			{ kind: "memory", id: "matching-memory", content: "Needle in a manual memory" },
		]);
	});

	it("re-lists corrupt pre-epoch artifacts behind the since watermark (#1149)", () => {
		// Regression for #1149: artifacts stamped with the DOS-epoch sentinel
		// (1980, from timestamp-stripping filesystems) can never be reached
		// by a rolling `since` watermark, so the since-filtered scan-first
		// listing used to exclude them forever. They must stay listable as a
		// catch-up backstop.
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO memory_artifacts
				 (agent_id, source_path, source_sha256, source_kind, session_id, session_token,
				  captured_at, content, updated_at, is_deleted)
				 VALUES ('ant', 'sources/sentinel.md', 'sha-sentinel', 'source_obsidian_markdown', 'session-a',
				  'token-a', '1980-01-01T06:00:00.000Z', 'sentinel artifact evidence',
				  '2026-08-01T10:00:00.000Z', 0)`,
			).run();
			db.prepare(
				`INSERT INTO memory_artifacts
				 (agent_id, source_path, source_sha256, source_kind, session_id, session_token,
				  captured_at, content, updated_at, is_deleted)
				 VALUES ('ant', 'sources/modern.md', 'sha-modern', 'source_obsidian_markdown', 'session-a',
				  'token-a', '2026-08-01T11:00:00.000Z', 'modern artifact evidence',
				  '2026-08-01T11:00:00.000Z', 0)`,
			).run();
		});

		const since = "2026-08-01T10:30:00.000Z";
		const listed = getDbAccessor().withReadDb((db) =>
			readRecentEpisodicSources(db, "ant", 10, undefined, since, "oldest"),
		);
		expect(listed.map((source) => source.id)).toEqual(
			expect.arrayContaining(["sources/sentinel.md", "sources/modern.md"]),
		);

		const searched = getDbAccessor().withReadDb((db) =>
			searchEpisodicSources(db, { agentId: "ant", query: "", since }),
		);
		expect(searched.map((source) => source.id)).toEqual(expect.arrayContaining(["sources/sentinel.md"]));
	});

	it("compares the since bound across ISO and space timestamp formats (#1149)", () => {
		// Regression for #1149: the watermark can be ISO (an artifact's
		// captured_at) while rows use SQLite space format. A raw string
		// comparison would lexically misorder them (' ' < 'T'), silently
		// dropping a space-format row captured after an ISO watermark.
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO memory_artifacts
				 (agent_id, source_path, source_sha256, source_kind, session_id, session_token,
				  captured_at, content, updated_at, is_deleted)
				 VALUES ('ant', 'sources/space-format.md', 'sha-space', 'source_obsidian_markdown', 'session-a',
				  'token-a', '2026-08-01 12:00:00', 'space format artifact evidence',
				  '2026-08-01 12:00:00', 0)`,
			).run();
			db.prepare(
				`INSERT INTO session_summaries
				 (id, project, depth, kind, content, token_count, earliest_at, latest_at, session_key, harness,
				  agent_id, source_type, source_ref, meta_json, created_at)
				 VALUES ('space-summary', '/repo', 0, 'session', 'space format summary evidence', 3,
				  '2026-08-01 12:00:00', '2026-08-01 12:00:00', 'session-a', 'pi',
				  'ant', 'summary', 'session-a', '{}', '2026-08-01 12:00:00')`,
			).run();
		});

		// ISO watermark: both space-format rows are captured after it and
		// must be listed.
		const searched = getDbAccessor().withReadDb((db) =>
			searchEpisodicSources(db, { agentId: "ant", query: "", since: "2026-08-01T11:00:00.000Z" }),
		);
		expect(searched.map((source) => source.id)).toEqual(
			expect.arrayContaining(["sources/space-format.md", "space-summary"]),
		);

		// A space-format before bound still excludes rows captured after it.
		const bounded = getDbAccessor().withReadDb((db) =>
			searchEpisodicSources(db, {
				agentId: "ant",
				query: "",
				since: "2026-08-01T11:00:00.000Z",
				before: "2026-08-01 12:30:00",
			}),
		);
		expect(bounded.map((source) => source.id)).toEqual(
			expect.arrayContaining(["sources/space-format.md", "space-summary"]),
		);
	});

	it("pages cursor listings past pre-epoch sentinel rows without re-listing them (#1149)", () => {
		// Regression for #1149 (adversarial review F2): re-admitting sentinel
		// rows on every cursor page froze paging on the pre-2000 block. The
		// initial page surfaces them; later pages must move past them.
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO memory_artifacts
				 (agent_id, source_path, source_sha256, source_kind, session_id, session_token,
				  captured_at, content, updated_at, is_deleted)
				 VALUES ('ant', 'sources/sentinel.md', 'sha-sentinel', 'source_obsidian_markdown', 'session-a',
				  'token-a', '1980-01-01T06:00:00.000Z', 'sentinel artifact evidence',
				  '2026-08-01T10:00:00.000Z', 0)`,
			).run();
			db.prepare(
				`INSERT INTO memory_artifacts
				 (agent_id, source_path, source_sha256, source_kind, session_id, session_token,
				  captured_at, content, updated_at, is_deleted)
				 VALUES ('ant', 'sources/first.md', 'sha-first', 'source_obsidian_markdown', 'session-a',
				  'token-a', '2026-08-01T11:00:00.000Z', 'first artifact evidence',
				  '2026-08-01T11:00:00.000Z', 0)`,
			).run();
			db.prepare(
				`INSERT INTO memory_artifacts
				 (agent_id, source_path, source_sha256, source_kind, session_id, session_token,
				  captured_at, content, updated_at, is_deleted)
				 VALUES ('ant', 'sources/second.md', 'sha-second', 'source_obsidian_markdown', 'session-a',
				  'token-a', '2026-08-01T12:00:00.000Z', 'second artifact evidence',
				  '2026-08-01T12:00:00.000Z', 0)`,
			).run();
		});

		const page = (cursor: EpisodicCursor | null) =>
			getDbAccessor().withReadDb((db) =>
				readRecentEpisodicSources(db, "ant", 2, undefined, "2026-08-01T00:00:00.000Z", "oldest", cursor),
			);

		const pageOne = page(null);
		expect(pageOne.map((source) => source.id)).toEqual(["sources/sentinel.md", "sources/first.md"]);

		const last = pageOne[pageOne.length - 1];
		if (!last) throw new Error("page one empty");
		const pageTwo = page({ capturedAt: last.capturedAt, kind: last.kind, id: last.id });
		// The sentinel was surfaced by the initial page and must not re-enter.
		expect(pageTwo.map((source) => source.id)).not.toContain("sources/sentinel.md");
		expect(pageTwo.map((source) => source.id)).toEqual(["sources/second.md"]);
	});
});
