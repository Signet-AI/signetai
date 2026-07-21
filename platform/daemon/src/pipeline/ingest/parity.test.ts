import { describe, expect, test } from "bun:test";
import { computePlannerQualityMetrics } from "./parity";
import { IngestPlanSchema, type IngestPlan } from "./ingest-plan";

function plan(ops: {
	memories?: { content: string }[];
	graphOps?: { operation: string; payload: Record<string, unknown> }[];
}): IngestPlan {
	return IngestPlanSchema.parse({
		schemaVersion: 1,
		jobId: "j",
		agentId: "default",
		sourceHash: "s",
		memories: ops.memories ?? [],
		graphOps: (ops.graphOps ?? []) as never,
		filePatches: [],
	});
}

describe("computePlannerQualityMetrics", () => {
	test("a clean corpus: no duplicate memories or entities, consistent aspects", () => {
		const m = computePlannerQualityMetrics([
			plan({
				graphOps: [
					{ operation: "create_entity", payload: { name: "GLM 5.1" } },
					{ operation: "set_claim_value", payload: { entity: "GLM 5.1", aspect: "providers", group: "routing", claim: "endpoint", value: "Z.AI" } },
				],
			}),
			plan({
				graphOps: [
					{ operation: "create_entity", payload: { name: "OpenRouter" } },
					{ operation: "set_claim_value", payload: { entity: "GLM 5.1", aspect: "providers", group: "routing", claim: "status", value: "fallback" } },
				],
			}),
		]);
		expect(m.duplicateMemoryHashes).toBe(0);
		expect(m.duplicateEntities).toBe(0);
		// GLM 5.1 appears in two set_claim_value ops with the SAME aspect ("providers") -> consistent.
		expect(m.aspectConsistency.sharedEntities).toBe(1);
		expect(m.aspectConsistency.score).toBe(1);
		expect(m.aspectConsistency.inconsistencies).toHaveLength(0);
	});

	test("flags duplicate memories (same content across plans)", () => {
		const m = computePlannerQualityMetrics([
			plan({ memories: [{ content: "Identical durable fact." }] }),
			plan({ memories: [{ content: "Identical durable fact." }] }),
		]);
		expect(m.memoryCount).toBe(2);
		expect(m.duplicateMemoryHashes).toBe(1);
	});

	test("flags duplicate create_entity (same canonical name)", () => {
		const m = computePlannerQualityMetrics([
			plan({ graphOps: [{ operation: "create_entity", payload: { name: "GLM 5.1" } }] }),
			plan({ graphOps: [{ operation: "create_entity", payload: { name: "glm 5.1" } }] }), // case differs
		]);
		expect(m.duplicateEntities).toBe(1);
	});

	test("HEADLINE: flags aspect-naming inconsistency on a shared entity", () => {
		// The legacy structural-classify worker existed to prevent exactly this:
		// the same entity routed under two different aspect slot names. The
		// consolidated planner must not regress it.
		const m = computePlannerQualityMetrics([
			plan({
				graphOps: [
					{ operation: "create_entity", payload: { name: "GLM 5.1" } },
					{ operation: "set_claim_value", payload: { entity: "GLM 5.1", aspect: "providers", claim: "endpoint", value: "Z.AI" } },
				],
			}),
			plan({
				graphOps: [
					{ operation: "set_claim_value", payload: { entity: "GLM 5.1", aspect: "prefs", claim: "endpoint", value: "Z.AI" } },
				],
			}),
		]);
		expect(m.aspectConsistency.sharedEntities).toBe(1);
		expect(m.aspectConsistency.consistent).toBe(0);
		expect(m.aspectConsistency.score).toBe(0);
		expect(m.aspectConsistency.inconsistencies).toHaveLength(1);
		expect(m.aspectConsistency.inconsistencies[0].aspects).toEqual(expect.arrayContaining(["providers", "prefs"]));
	});

	test("aspect variants that canonicalize to one form count as consistent", () => {
		const m = computePlannerQualityMetrics([
			plan({
				graphOps: [
					{ operation: "set_claim_value", payload: { entity: "GLM 5.1", aspect: "Providers", claim: "a", value: "1" } },
					{ operation: "set_claim_value", payload: { entity: "GLM 5.1", aspect: "providers", claim: "b", value: "2" } },
				],
			}),
		]);
		expect(m.aspectConsistency.score).toBe(1);
	});

	test("records the graph-op vocabulary distribution", () => {
		const m = computePlannerQualityMetrics([
			plan({
				graphOps: [
					{ operation: "create_entity", payload: { name: "A" } },
					{ operation: "create_entity", payload: { name: "B" } },
					{ operation: "set_claim_value", payload: { entity: "A", aspect: "x", claim: "c", value: "v" } },
				],
			}),
		]);
		expect(m.graphOpsByKind.create_entity).toBe(2);
		expect(m.graphOpsByKind.set_claim_value).toBe(1);
	});
});
