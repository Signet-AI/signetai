import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { type ReadScope, compartmentFor } from "@signet/core";
import { runMigrations } from "../../core/src/migrations/index";
import { assembleInheritedContextBlock, resolveParentSession, searchSessionTranscripts } from "./subagent-context.js";

let db: Database | null = null;

function createTranscriptDb(): Database {
	const next = new Database(":memory:");
	next.run(`
		CREATE TABLE session_transcripts (
			agent_id TEXT NOT NULL,
			session_key TEXT NOT NULL,
			session_id TEXT NOT NULL,
			project TEXT,
			harness TEXT NOT NULL,
			content TEXT NOT NULL,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)
	`);
	db = next;
	return next;
}

afterEach(() => {
	db?.close();
	db = null;
});

describe("searchSessionTranscripts", () => {
	test("fallback LIKE search preserves parameter order with session and project filters", () => {
		const conn = createTranscriptDb();
		const insert = conn.prepare(`
			INSERT INTO session_transcripts
				(agent_id, session_key, session_id, project, harness, content, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		`);
		insert.run(
			"default",
			"parent-session",
			"parent-session",
			"/repo",
			"opencode",
			"Parent session decided the delegated subagent should inherit the continuity note.",
			"2026-05-06T10:00:00Z",
			"2026-05-06T10:01:00Z",
		);
		insert.run(
			"default",
			"other-session",
			"other-session",
			"/elsewhere",
			"opencode",
			"Parent session decided the delegated subagent should inherit the continuity note.",
			"2026-05-06T10:00:00Z",
			"2026-05-06T10:02:00Z",
		);

		const rows = searchSessionTranscripts({
			db: conn,
			agentId: "default",
			query: "delegated continuity",
			project: "/repo",
			currentSessionKey: "child-session",
			limit: 5,
		});

		expect(rows).toHaveLength(1);
		expect(rows[0]?.sessionKey).toBe("parent-session");
		expect(rows[0]?.excerpt).toContain("delegated");
	});
});

describe("inherited parent context read scope", () => {
	function seeded(): { readonly conn: Database; readonly hr: number } {
		const conn = new Database(":memory:");
		db = conn;
		runMigrations(conn);
		conn.run("INSERT INTO classifications (id, name, created_at, updated_at) VALUES ('cls_hr', 'HR', 'now', 'now')");
		const hr = compartmentFor(conn, ["cls_hr"]) ?? 0;
		const transcript = conn.prepare(
			`INSERT INTO session_transcripts
				(session_key, content, harness, project, agent_id, compartment_id, created_at, updated_at, completed_at)
			 VALUES (?, ?, 'claude-code', '/repo', 'default', ?, ?, ?, ?)`,
		);
		transcript.run(
			"parent-visible",
			"Visible parent tail.",
			null,
			"2026-05-06T10:00:00Z",
			"2026-05-06T10:00:00Z",
			null,
		);
		transcript.run("parent-hidden", "HRSECRET parent tail.", hr, "2026-05-06T11:00:00Z", "2026-05-06T11:00:00Z", null);
		const checkpoint = conn.prepare(
			`INSERT INTO session_checkpoints
				(id, session_key, harness, project, project_normalized, trigger, digest, prompt_count, focal_entity_names, agent_id, compartment_id, created_at)
			 VALUES (?, ?, 'claude-code', '/repo', '/repo', 'periodic', ?, 1, '["Atlas"]', 'default', ?, ?)`,
		);
		checkpoint.run("cp-visible", "parent-visible", "Visible checkpoint.", null, "2026-05-06T10:00:00Z");
		checkpoint.run("cp-hidden", "parent-hidden", "HRSECRET checkpoint.", hr, "2026-05-06T11:00:00Z");
		checkpoint.run("cp-visible-hidden", "parent-visible", "HRSECRET newer checkpoint.", hr, "2026-05-06T12:00:00Z");
		conn.run(
			"INSERT INTO entities (id, name, canonical_name, entity_type, agent_id, created_at, updated_at) VALUES ('ent-atlas', 'Atlas', 'atlas', 'project', 'default', 'now', 'now')",
		);
		conn.run(
			"INSERT INTO entity_aspects (id, entity_id, agent_id, name, canonical_name, created_at, updated_at) VALUES ('asp-atlas', 'ent-atlas', 'default', 'rules', 'rules', 'now', 'now')",
		);
		const constraint = conn.prepare(
			`INSERT INTO entity_attributes
				(id, aspect_id, agent_id, kind, content, normalized_content, confidence, importance, status, compartment_id, created_at, updated_at)
			 VALUES (?, 'asp-atlas', 'default', 'constraint', ?, ?, 1, ?, 'active', ?, 'now', 'now')`,
		);
		constraint.run("attr-visible", "Visible constraint.", "visible constraint", 0.5, null);
		constraint.run("attr-hidden", "HRSECRET constraint.", "hrsecret constraint", 0.9, hr);
		return { conn, hr };
	}
	const outside: ReadScope = { reach: { kind: "own", agentId: "default" }, compartments: [], projects: null };
	const cfg = { inheritContext: true, tailChars: 3000 };
	const parent = (sessionKey: string) => ({ sessionKey, agentId: "default", source: "explicit" as const });

	test("withholds hidden parent sessions, checkpoints and constraints", () => {
		const { conn, hr } = seeded();
		expect(assembleInheritedContextBlock(conn, parent("parent-hidden"), cfg, outside)).toBeNull();
		const visible = assembleInheritedContextBlock(conn, parent("parent-visible"), cfg, outside) ?? "";
		expect(visible).toContain("Visible checkpoint.");
		expect(visible).toContain("Visible parent tail.");
		expect(visible).toContain("Visible constraint.");
		expect(visible).not.toContain("HRSECRET");
		const audience = assembleInheritedContextBlock(conn, parent("parent-hidden"), cfg, {
			...outside,
			compartments: [hr],
		});
		expect(audience).toContain("HRSECRET parent tail.");
		expect(audience).toContain("HRSECRET constraint.");
		expect(
			assembleInheritedContextBlock(conn, parent("parent-visible"), cfg, { ...outside, projects: ["/other"] }),
		).toBeNull();
	});

	test("resolves the claude-code parent among readable sessions only", () => {
		const { conn, hr } = seeded();
		const request = {
			harness: "claude-code",
			project: "/repo",
			sessionKey: "child",
			agentId: "default",
			harnessAgentId: "sub-1",
		};
		expect(resolveParentSession(conn, request, outside)?.sessionKey).toBe("parent-visible");
		expect(resolveParentSession(conn, request, { ...outside, compartments: [hr] })?.sessionKey).toBe("parent-hidden");
	});
});
