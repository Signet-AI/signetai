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
			aggregate: true,
			aggregateBudget: "medium",
			saveAggregate: false,
		});
	});

	it("forwards source-only recall constraints only when callers set them", () => {
		expect(buildRecallRequestBody("graph", { sourceOnly: true })).toEqual({
			query: "graph",
			sourceOnly: true,
		});
		expect(buildRecallRequestBody("graph", { sourceOnly: false })).toEqual({ query: "graph" });
	});

	it("normalizes legacy structured aspect tuples for remember callers", () => {
		const body = buildRememberRequestBody("Remember this", {
			tags: ["graph", "parity"],
			sourcePath: "/tmp/source.md",
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
