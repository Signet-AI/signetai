import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBlackBoxSession, listBlackBoxSessions } from "./black-box";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "./db-accessor";

let dir: string;

function insertSearchTelemetry(input: {
	agentId: string;
	sessionKey: string;
	createdAt: string;
	id?: string;
	project?: string;
	query?: string;
	results?: unknown[];
}): void {
	getDbAccessor().withWriteTx((db) => {
		db.prepare(
			`INSERT INTO memory_search_telemetry
			 (id, created_at, route, agent_id, session_key, project, query, keyword_query,
			  filters_json, method, result_count, top_score, no_hits, duration_ms,
			  timings_json, results_json, sources_json)
			 VALUES (?, ?, '/memory/search', ?, ?, ?, ?, NULL, '{}', 'hybrid', ?, 0.9, 0, 12,
			         '{"totalMs":12,"stages":[]}', ?, NULL)`,
		).run(
			input.id ?? crypto.randomUUID(),
			input.createdAt,
			input.agentId,
			input.sessionKey,
			input.project ?? "/repo",
			input.query ?? "what mattered?",
			input.results?.length ?? 0,
			JSON.stringify(input.results ?? []),
		);
	});
}

function insertArtifact(input: {
	agentId: string;
	sessionKey: string;
	capturedAt: string;
	path: string;
	project?: string;
}): void {
	getDbAccessor().withWriteTx((db) => {
		db.prepare(
			`INSERT INTO memory_artifacts
			 (agent_id, source_path, source_sha256, source_kind, session_id, session_key, session_token,
			  project, harness, captured_at, started_at, ended_at, manifest_path, source_node_id,
			  memory_sentence, memory_sentence_quality, content, updated_at)
			 VALUES (?, ?, 'sha', 'summary', ?, ?, ?, ?, 'codex', ?, NULL, NULL, NULL, NULL,
			         'Session summary was written.', 'ok', 'summary body', ?)`,
		).run(
			input.agentId,
			input.path,
			input.sessionKey,
			input.sessionKey,
			input.sessionKey,
			input.project ?? "/repo",
			input.capturedAt,
			input.capturedAt,
		);
	});
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "signet-black-box-"));
	mkdirSync(join(dir, "memory"), { recursive: true });
	initDbAccessor(join(dir, "memory", "memories.db"));
});

afterEach(() => {
	closeDbAccessor();
	rmSync(dir, { recursive: true, force: true });
});

describe("black box session replay", () => {
	it("builds an ordered frame from recall telemetry and session artifacts", () => {
		insertSearchTelemetry({
			agentId: "default",
			sessionKey: "session-a",
			createdAt: "2026-06-20T10:00:00.000Z",
			results: [
				{
					id: "mem-1",
					content: "The user prefers source-backed context with provenance.",
					score: 0.91,
					source_id: "obsidian:vault:note.md#1-3",
					source_path: "note.md",
				},
			],
		});
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO session_recall_events
				 (session_key, agent_id, context_epoch, item_kind, item_id, surface, mode, score, source, created_at)
				 VALUES ('session-a', 'default', 0, 'memory', 'mem-1', 'prompt', 'hybrid', 0.91, 'memory_search',
				         '2026-06-20T10:00:01.000Z')`,
			).run();
		});
		insertArtifact({
			agentId: "default",
			sessionKey: "session-a",
			capturedAt: "2026-06-20T10:01:00.000Z",
			path: "memory/sessions/session-a.md",
		});

		const replay = buildBlackBoxSession(getDbAccessor(), { agentId: "default", sessionKey: "session-a" });

		expect(replay.eventCount).toBe(4);
		expect(replay.events.map((event) => event.kind)).toEqual([
			"recall.requested",
			"recall.result",
			"context.recalled",
			"artifact.written",
		]);
		expect(replay.frame.activeRefCount).toBe(3);
		expect(replay.frame.likelyInfluences[0]?.refs[0]?.id).toBe("mem-1");
	});

	it("keeps sessions scoped by agent", () => {
		insertSearchTelemetry({
			agentId: "alice",
			sessionKey: "shared-session-key",
			createdAt: "2026-06-20T10:00:00.000Z",
			results: [{ id: "alice-memory", content: "alice", score: 0.8 }],
		});
		insertSearchTelemetry({
			agentId: "bob",
			sessionKey: "shared-session-key",
			createdAt: "2026-06-20T10:00:00.000Z",
			results: [{ id: "bob-memory", content: "bob", score: 0.7 }],
		});

		const replay = buildBlackBoxSession(getDbAccessor(), { agentId: "alice", sessionKey: "shared-session-key" });

		expect(replay.events.flatMap((event) => event.refs).map((ref) => ref.id)).toContain("alice-memory");
		expect(replay.events.flatMap((event) => event.refs).map((ref) => ref.id)).not.toContain("bob-memory");
	});

	it("lists sessions from telemetry and artifact lineage", () => {
		insertSearchTelemetry({
			agentId: "default",
			sessionKey: "telemetry-session",
			createdAt: "2026-06-20T10:00:00.000Z",
		});
		insertArtifact({
			agentId: "default",
			sessionKey: "artifact-session",
			capturedAt: "2026-06-20T10:02:00.000Z",
			path: "memory/sessions/artifact-session.md",
		});

		const sessions = listBlackBoxSessions(getDbAccessor(), { agentId: "default" });

		expect(sessions.map((session) => session.sessionKey)).toEqual(["artifact-session", "telemetry-session"]);
		expect(sessions[0]?.artifactEvents).toBe(1);
		expect(sessions[1]?.recallEvents).toBe(1);
	});

	it("filters replay data by project when project scope is supplied", () => {
		insertSearchTelemetry({
			agentId: "default",
			sessionKey: "shared-session",
			project: "/allowed",
			createdAt: "2026-06-20T10:00:00.000Z",
			results: [{ id: "allowed-memory", content: "allowed", score: 0.8 }],
		});
		insertSearchTelemetry({
			agentId: "default",
			sessionKey: "shared-session",
			project: "/blocked",
			createdAt: "2026-06-20T10:00:01.000Z",
			results: [{ id: "blocked-memory", content: "blocked", score: 0.7 }],
		});
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO session_recall_events
				 (session_key, agent_id, context_epoch, item_kind, item_id, surface, mode, score, source, created_at)
				 VALUES ('shared-session', 'default', 0, 'memory', 'blocked-memory', 'prompt', 'hybrid', 0.7, 'memory_search',
				         '2026-06-20T10:00:02.000Z')`,
			).run();
		});

		const replay = buildBlackBoxSession(getDbAccessor(), {
			agentId: "default",
			sessionKey: "shared-session",
			project: "/allowed",
		});

		const refIds = replay.events.flatMap((event) => event.refs).map((ref) => ref.id);
		expect(refIds).toContain("allowed-memory");
		expect(refIds).not.toContain("blocked-memory");
	});
});
