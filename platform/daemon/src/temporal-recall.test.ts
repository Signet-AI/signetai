import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureCompartmentShards } from "../../core/src/compartment-shards";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "./db-accessor";
import type { ReadScope } from "./read-scope";
import { parseTemporalRecallIntent, resolveTemporalRecall } from "./temporal-recall";

describe("temporal recall parser", () => {
	it("parses abbreviated numeric ranges without leaving the end day in the content query", () => {
		const parsed = parseTemporalRecallIntent({ query: "what happened on 2026-07-25/26?" });
		expect(parsed).toMatchObject({
			source: "query",
			contentQuery: "happened",
			mode: "filter",
			start: new Date(2026, 6, 25).toISOString(),
			end: new Date(2026, 6, 27).toISOString(),
		});
	});

	it("consumes expanded and named date ranges as complete temporal expressions", () => {
		const expanded = parseTemporalRecallIntent({ query: "2026-07-25/2026-07-26" });
		const named = parseTemporalRecallIntent({ query: "what happened on July 25/26 2026?" });

		expect(expanded).toMatchObject({
			contentQuery: "",
			mode: "timeline",
			start: new Date(2026, 6, 25).toISOString(),
			end: new Date(2026, 6, 27).toISOString(),
		});
		expect(named).toMatchObject({
			contentQuery: "happened",
			mode: "filter",
			start: new Date(2026, 6, 25).toISOString(),
			end: new Date(2026, 6, 27).toISOString(),
		});
	});

	it("does not treat a reversed abbreviated range as a valid temporal query", () => {
		expect(parseTemporalRecallIntent({ query: "what happened on 2026-07-25/01?" })).toBeNull();
	});

	it("does not partially parse an unsupported numeric range suffix", () => {
		expect(parseTemporalRecallIntent({ query: "report 2026-07-25/26th" })).toBeNull();
	});
});

describe("temporal recall", () => {
	let dir = "";

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "signet-temporal-recall-"));
		mkdirSync(join(dir, "memory"), { recursive: true });
		initDbAccessor(join(dir, "memory", "memories.db"), { agentsDir: dir });
	});

	afterEach(async () => {
		await closeDbAccessor();
		rmSync(dir, { recursive: true, force: true });
	});

	it("scopes non-memory temporal edges by the requesting agent policy", () => {
		const createdAt = "2026-05-24T18:00:00.000Z";
		getDbAccessor().withWriteTx((db) => {
			const agent = db.prepare(
				`INSERT INTO agents (id, name, read_policy, policy_group, created_at, updated_at)
				 VALUES (?, ?, 'isolated', ?, ?, ?)`,
			);
			agent.run("owner", "owner", "team-a", createdAt, createdAt);
			agent.run("teammate", "teammate", "team-a", createdAt, createdAt);
			agent.run("outsider", "outsider", "team-b", createdAt, createdAt);
			const edge = db.prepare(
				`INSERT INTO temporal_edges
				 (id, agent_id, subject_type, subject_id, facet, start_at, end_at, confidence, created_at, updated_at)
				 VALUES (?, ?, 'source_document', ?, 'occurred', ?, ?, 1.0, ?, ?)`,
			);
			edge.run(
				"owner-edge",
				"owner",
				"owner-doc",
				"2026-05-13T12:00:00.000Z",
				"2026-05-13T12:00:00.000Z",
				createdAt,
				createdAt,
			);
			edge.run(
				"teammate-edge",
				"teammate",
				"teammate-doc",
				"2026-05-13T13:00:00.000Z",
				"2026-05-13T13:00:00.000Z",
				createdAt,
				createdAt,
			);
			edge.run(
				"outsider-edge",
				"outsider",
				"outsider-doc",
				"2026-05-13T14:00:00.000Z",
				"2026-05-13T14:00:00.000Z",
				createdAt,
				createdAt,
			);
		});

		const time = {
			start: "2026-05-13T00:00:00.000Z",
			end: "2026-05-14T00:00:00.000Z",
			facets: ["occurred"] as const,
			mode: "timeline" as const,
		};
		const group = resolveTemporalRecall({
			query: "",
			time,
			limit: 10,
			agentId: "owner",
			readPolicy: "group",
			policyGroup: "team-a",
		});
		expect(group.response?.results.map((row) => row.subject_id)).toEqual(["teammate-doc", "owner-doc"]);

		const isolated = resolveTemporalRecall({ query: "", time, limit: 10, agentId: "owner", readPolicy: "isolated" });
		expect(isolated.response?.results.map((row) => row.subject_id)).toEqual(["owner-doc"]);
	});

	it("leaves raw transcript artifacts out when transcript evidence is disabled", () => {
		getDbAccessor().withWriteTx((db) => {
			const artifact = db.prepare(
				`INSERT INTO memory_artifacts
				 (agent_id, source_path, source_sha256, source_kind, session_id, session_key, session_token,
				  project, harness, captured_at, content, updated_at, is_deleted)
				 VALUES ('default', ?, ?, ?, 'session-a', 'session-a', 'token-a', NULL, 'pi', ?, ?, ?, 0)`,
			);
			artifact.run(
				"transcripts/pi.jsonl",
				"sha-transcript",
				"transcript",
				"2026-08-01T10:00:00.000Z",
				"raw transcript turn",
				"2026-08-01T10:00:00.000Z",
			);
			artifact.run(
				"sources/note.md",
				"sha-note",
				"source_obsidian_markdown",
				"2026-08-01T11:00:00.000Z",
				"source note",
				"2026-08-01T11:00:00.000Z",
			);
		});
		const time = {
			start: "2026-08-01T00:00:00.000Z",
			end: "2026-08-02T00:00:00.000Z",
			facets: ["captured"] as const,
			mode: "timeline" as const,
		};
		const kinds = (transcriptEvidence?: boolean): readonly (string | undefined)[] =>
			(
				resolveTemporalRecall({ query: "", time, limit: 10, agentId: "default", transcriptEvidence }).response
					?.results ?? []
			).map((row) => row.type);

		expect(kinds()).toEqual(["source_obsidian_markdown", "transcript"]);
		expect(kinds(false)).toEqual(["source_obsidian_markdown"]);
	});

	it("widens an empty day filter, then falls back to unfiltered ranking instead of returning nothing", () => {
		const createdAt = new Date(2026, 2, 19, 15, 0, 0).toISOString();
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO memories (id, content, type, agent_id, updated_by, created_at, updated_at)
				 VALUES (?, ?, 'fact', 'default', 'test', ?, ?)`,
			).run("walk", "The user completed the Walk for Hunger charity event.", createdAt, createdAt);
		});

		const widened = resolveTemporalRecall({ query: "which charity event did I join on 2026-03-18?", limit: 10 });
		expect(widened.response).toBeUndefined();
		expect(widened.candidateIds).toEqual(["walk"]);
		expect(widened.meta?.window).toBe("widened");

		const unfiltered = resolveTemporalRecall({ query: "which charity event did I join on 2026-01-02?", limit: 10 });
		expect(unfiltered.response).toBeUndefined();
		expect(unfiltered.candidateIds).toBeUndefined();
		expect(unfiltered.adjustedQuery).toBe(unfiltered.meta?.contentQuery);
		expect(unfiltered.meta?.window).toBe("unfiltered");
	});

	describe("read scope", () => {
		const org: ReadScope = { reach: { kind: "all" }, compartments: [], projects: null };
		const at = "2026-06-01T12:00:00.000Z";
		const time = {
			start: "2026-06-01T00:00:00.000Z",
			end: "2026-06-02T00:00:00.000Z",
			mode: "timeline" as const,
		};

		function seed(prefix: string, agent: string, compartment: number | null, project: string | null): void {
			getDbAccessor().withWriteTx((db) => {
				db.prepare("INSERT OR IGNORE INTO agents (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)").run(
					agent,
					agent,
					at,
					at,
				);
				db.prepare("INSERT OR IGNORE INTO compartments (id, key, created_at) VALUES (1, 'cls_hr', ?)").run(at);
				ensureCompartmentShards(db as unknown as Parameters<typeof ensureCompartmentShards>[0], 1, 0);
				db.prepare(
					`INSERT INTO session_summaries (id, project, depth, kind, content, earliest_at, latest_at, session_key, agent_id, compartment_id, created_at)
					 VALUES (?, ?, 0, 'session', ?, ?, ?, ?, ?, ?, ?)`,
				).run(`s-${prefix}`, project, `summary ${prefix}`, at, at, `session-${prefix}`, agent, compartment, at);
				db.prepare(
					`INSERT INTO memories (id, content, type, agent_id, project, compartment_id, updated_by, created_at, updated_at)
					 VALUES (?, ?, 'fact', ?, ?, ?, 'test', ?, ?)`,
				).run(`m-${prefix}`, `memory ${prefix}`, agent, project, compartment, at, at);
				db.prepare(
					`INSERT INTO memory_artifacts (agent_id, source_path, source_sha256, source_kind, session_id, session_key, session_token,
					  project, captured_at, content, updated_at, is_deleted, compartment_id)
					 VALUES (?, ?, ?, 'source_obsidian_markdown', ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
				).run(
					agent,
					`notes/${prefix}.md`,
					`sha-${prefix}`,
					prefix,
					prefix,
					prefix,
					project,
					at,
					`artifact ${prefix}`,
					at,
					compartment,
				);
				const edge = db.prepare(
					`INSERT INTO temporal_edges (id, agent_id, subject_type, subject_id, facet, start_at, end_at, confidence, compartment_id, created_at, updated_at)
					 VALUES (?, ?, ?, ?, 'occurred', ?, ?, 1.0, ?, ?, ?)`,
				);
				edge.run(`te-doc-${prefix}`, agent, "source_document", `doc-${prefix}`, at, at, compartment, at, at);
				edge.run(`te-mem-${prefix}`, agent, "memory", "m-visible", at, at, compartment, at, at);
			});
		}

		function observe(scope: ReadScope): readonly string[] {
			return (
				resolveTemporalRecall({ query: "", time, limit: 50, agentId: "alice", readScope: scope }).response?.results ??
				[]
			).map((row) => `${row.subject_type}:${row.subject_id}:${row.temporal_facet}`);
		}

		it("returns identical timelines whether hidden temporal rows exist", () => {
			seed("visible", "alice", null, null);
			const before = observe(org);
			expect(before).toContain("session_summary:s-visible:session");
			expect(before).toContain("memory:m-visible:captured");
			expect(before).toContain("source_document:doc-visible:occurred");
			seed("hidden", "alice", 1, null);
			expect(observe(org)).toEqual(before);
		});

		it("lets organization reach read every active agent without agent equality", () => {
			seed("visible", "bob", null, null);
			const observed = observe(org);
			expect(observed).toContain("session_summary:s-visible:session");
			expect(observed).toContain("source_document:doc-visible:occurred");
		});

		it("fails closed for project-restricted reads of project-less temporal edges", () => {
			seed("visible", "alice", null, "atlas");
			seed("other", "alice", null, null);
			const observed = observe({ ...org, projects: ["atlas"] });
			expect(observed).toContain("session_summary:s-visible:session");
			expect(observed).toContain("memory:m-visible:captured");
			expect(observed.some((row) => row.includes("other"))).toBe(false);
			expect(observed.some((row) => row.endsWith(":occurred"))).toBe(false);
		});
	});
});
