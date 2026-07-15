import { describe, expect, it } from "bun:test";
import {
	applyRecallScoreThreshold,
	buildRecallRequestBody,
	buildRememberRequestBody,
	formatRecallText,
	parseRecallPayload,
	withHookRecallCompat,
} from "./recall";

describe("recall surface helpers", () => {
	it("formats daemon recall payloads with primary and supporting context", () => {
		const text = formatRecallText({
			method: "hybrid",
			results: [
				{
					id: "mem-1",
					content: "Nicholai likes filesystem-shaped graph navigation.",
					score: 0.91,
					source: "hybrid",
					type: "preference",
					created_at: "2026-04-20T12:00:00.000Z",
					who: "ant",
				},
				{
					id: "ctx-1",
					content: "SEC adds supporting evidence.",
					source: "graph",
					type: "rationale",
					created_at: "2026-04-19T12:00:00.000Z",
					supplementary: true,
				},
			],
			meta: { totalReturned: 2, hasSupplementary: true, noHits: false },
		});

		expect(text).toContain("Found 2 memories (hybrid).");
		expect(text).toContain("Primary matches:");
		expect(text).toContain("id: mem-1; Nicholai likes filesystem-shaped graph navigation.");
		expect(text).toContain("(preference, hybrid, 2026-04-20, by ant)");
		expect(text).toContain("Supporting context:");
		expect(text).toContain("id: ctx-1; SEC adds supporting evidence.");
	});

	it("formats degraded aggregate recall as evidence with a clear partial message", () => {
		const text = formatRecallText({
			method: "hybrid",
			results: [
				{
					id: "mem-1",
					content: "First evidence",
					source: "hybrid",
					type: "semantic",
					created_at: "2026-05-20T12:00:00.000Z",
				},
			],
			meta: { totalReturned: 1, hasSupplementary: false, noHits: false },
			aggregate: {
				savedMemoryId: null,
				saved: false,
				deduped: false,
				budget: "small",
				queries: ["what happened"],
				sourceMemoryIds: ["mem-1"],
				stoppedReason: "router_unavailable",
				partial: true,
				message: "Aggregate recall could not synthesize; returning retrieved evidence.",
			},
		});

		expect(text).toContain("Aggregate recall could not synthesize; returning retrieved evidence.");
		expect(text).toContain("Found 1 memory (hybrid).");
		expect(text).toContain("First evidence");
		expect(text).not.toContain("No matching memories found.");
	});

	it("builds recall request bodies without forwarding client-side score thresholds", () => {
		expect(
			buildRecallRequestBody("graph", {
				limit: 5,
				keyword_query: "graph OR entity",
				pinned: false,
				expand: false,
				agentId: "default",
				sessionKey: "sess-1",
				includeRecalled: true,
			}),
		).toEqual({
			query: "graph",
			keywordQuery: "graph OR entity",
			limit: 5,
			agentId: "default",
			sessionKey: "sess-1",
			includeRecalled: true,
		});
	});

	it("owns the canonical recall default limit", () => {
		expect(buildRecallRequestBody("graph")).toEqual({
			query: "graph",
			limit: 10,
		});
	});

	it("uses explicit agent ids before contextual agent ids", () => {
		expect(
			buildRecallRequestBody("graph", {
				agentId: "explicit-agent",
				contextAgentId: "context-agent",
			}),
		).toMatchObject({
			agentId: "explicit-agent",
		});

		expect(
			buildRecallRequestBody("graph", {
				contextAgentId: "context-agent",
			}),
		).toMatchObject({
			agentId: "context-agent",
		});
	});

	it("normalizes standard recall aliases without losing valid options", () => {
		expect(
			buildRecallRequestBody("graph", {
				keyword_query: "graph OR entity",
				limit: 2,
				agent_id: "agent-a",
				session_key: "session-a",
				include_recalled: true,
				source_only: true,
				aggregate: true,
				aggregate_budget: "large",
				save_aggregate: false,
				scope: "session",
				project: "/tmp/project",
				type: "decision",
				tags: "architecture",
				who: "codex",
				pinned: true,
				importance_min: 0.8,
				since: "2026-01-01",
				until: "2026-02-01",
				time: {
					start: "2026-01-01T00:00:00.000Z",
					end: "2026-02-01T00:00:00.000Z",
					facets: ["captured", "source"],
					mode: "filter",
				},
				expand: true,
			}),
		).toEqual({
			query: "graph",
			keywordQuery: "graph OR entity",
			limit: 2,
			agentId: "agent-a",
			sessionKey: "session-a",
			includeRecalled: true,
			sourceOnly: true,
			aggregate: true,
			aggregateBudget: "large",
			saveAggregate: false,
			scope: "session",
			project: "/tmp/project",
			type: "decision",
			tags: "architecture",
			who: "codex",
			pinned: true,
			importance_min: 0.8,
			since: "2026-01-01",
			until: "2026-02-01",
			time: {
				start: "2026-01-01T00:00:00.000Z",
				end: "2026-02-01T00:00:00.000Z",
				facets: ["captured", "source"],
				mode: "filter",
			},
			expand: true,
		});
	});

	it("bounds recall limits to a positive canonical range", () => {
		expect(buildRecallRequestBody("graph", { limit: 0 }).limit).toBe(1);
		expect(buildRecallRequestBody("graph", { limit: -5 }).limit).toBe(1);
		expect(buildRecallRequestBody("graph", { limit: 5000 }).limit).toBe(100);
	});

	it("forwards temporal recall request options", () => {
		expect(
			buildRecallRequestBody("2026/05/13", {
				time: {
					start: "2026-05-13T00:00:00.000Z",
					end: "2026-05-14T00:00:00.000Z",
					facets: ["session", "occurred"],
					mode: "timeline",
				},
			}),
		).toEqual({
			query: "2026/05/13",
			limit: 10,
			time: {
				start: "2026-05-13T00:00:00.000Z",
				end: "2026-05-14T00:00:00.000Z",
				facets: ["session", "occurred"],
				mode: "timeline",
			},
		});
	});

	it("preserves dedupe metadata when client-side score filtering rewrites counts", () => {
		const result = applyRecallScoreThreshold(
			{
				results: [
					{ id: "mem-1", content: "keep", score: 0.9 },
					{ id: "mem-2", content: "drop", score: 0.1 },
				],
				meta: {
					totalReturned: 2,
					hasSupplementary: false,
					noHits: false,
					dedupe: {
						enabled: true,
						contextEpoch: 3,
						suppressed: 4,
						repeatedReturned: 1,
					},
				},
			},
			0.5,
		);

		expect(parseRecallPayload(result).meta).toEqual({
			totalReturned: 1,
			hasSupplementary: false,
			noHits: false,
			dedupe: {
				enabled: true,
				contextEpoch: 3,
				suppressed: 4,
				repeatedReturned: 1,
			},
		});
	});

	it("forwards aggregate recall options only when callers set them", () => {
		expect(
			buildRecallRequestBody("graph", {
				aggregate: true,
				aggregate_budget: "medium",
				save_aggregate: false,
			}),
		).toEqual({
			query: "graph",
			limit: 10,
			aggregate: true,
			aggregateBudget: "medium",
			saveAggregate: false,
		});
	});

	it("forwards source-only recall constraints only when callers set them", () => {
		expect(buildRecallRequestBody("graph", { sourceOnly: true })).toEqual({
			query: "graph",
			limit: 10,
			sourceOnly: true,
		});
		expect(buildRecallRequestBody("graph", { sourceOnly: false })).toEqual({ query: "graph", limit: 10 });
	});

	it("normalizes legacy structured aspect tuples for remember callers", () => {
		const body = buildRememberRequestBody("Remember this", {
			tags: ["graph", "parity"],
			sourcePath: "/tmp/source.md",
			occurredAt: "2026-05-13T18:00:00.000Z",
			sourceCreatedAt: "2026-05-13T17:00:00.000Z",
			runtimePath: "memory/source.md",
			idempotencyKey: "stable-import-key",
			structured: {
				aspects: [
					{
						entity: "Nicholai",
						aspect: "memory architecture",
						value: "prefers entity/aspect/attribute graph structure",
						groupKey: "knowledge_graph",
						claimKey: "preferred_graph_shape",
						confidence: 0.95,
					},
				],
			},
		});

		expect(body.tags).toBe("graph,parity");
		expect(body.sourcePath).toBe("/tmp/source.md");
		expect(body.occurredAt).toBe("2026-05-13T18:00:00.000Z");
		expect(body.sourceCreatedAt).toBe("2026-05-13T17:00:00.000Z");
		expect(body.runtimePath).toBe("memory/source.md");
		expect(body.idempotencyKey).toBe("stable-import-key");
		expect(body.structured).toEqual({
			aspects: [
				{
					entityName: "Nicholai",
					aspect: "memory architecture",
					attributes: [
						{
							content: "prefers entity/aspect/attribute graph structure",
							groupKey: "knowledge_graph",
							claimKey: "preferred_graph_shape",
							confidence: 0.95,
						},
					],
				},
			],
		});
	});

	it("adds legacy hook aliases plus canonical message", () => {
		const result = withHookRecallCompat({
			query: "filesystem graph",
			method: "hybrid",
			results: [
				{
					id: "mem-1",
					content: "A graph can be navigated like folders and rooms.",
					source: "hybrid",
					type: "fact",
					created_at: "2026-04-20T12:00:00.000Z",
				},
			],
			meta: { totalReturned: 1, hasSupplementary: false, noHits: false },
		});

		expect(result.memories).toBe(result.results);
		expect(result.count).toBe(1);
		expect(result.message).toContain("Found 1 memory (hybrid).");
		expect(parseRecallPayload(result).rows).toHaveLength(1);
	});
});
