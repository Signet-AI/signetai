import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "./db-accessor";
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
});
