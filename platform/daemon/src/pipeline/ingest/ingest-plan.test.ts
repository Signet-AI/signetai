import { describe, expect, test } from "bun:test";
import {
	INGEST_GRAPH_OPERATIONS,
	IngestPlanSchema,
	parseIngestPlan,
	type IngestPlan,
} from "./ingest-plan";

const validBody = {
	memories: [
		{
			content: "Nicholai prefers GLM 5.1 routed through Z.AI, not OpenRouter.",
			why: "stated preference",
			importance: 0.8,
			type: "preference",
			tags: ["providers"],
		},
	],
	graphOps: [
		{
			id: "g1",
			operation: "create_entity",
			payload: { name: "GLM 5.1", kind: "model" },
			reason: "new entity referenced",
			confidence: 0.9,
		},
		{
			id: "g2",
			operation: "set_claim_value",
			payload: {
				entity: "GLM 5.1",
				aspect: "providers",
				group: "routing",
				claim: "preferred_endpoint",
				value: "Z.AI",
			},
		},
	],
	filePatches: [
		{
			id: "fp1",
			file: "AGENTS.md",
			append: "\n## Provider routing\nGLM 5.1 goes through Z.AI.\n",
			section: "Provider routing",
			reason: "preference confirmed",
		},
	],
} as const;

const validEnvelope = {
	schemaVersion: 1 as const,
	jobId: "job_abc",
	agentId: "default",
	sourceHash: "sha_ba5e",
	createdAt: "2026-07-12T20:00:00Z",
};

function validPlan(): IngestPlan {
	return IngestPlanSchema.parse({ ...validBody, ...validEnvelope });
}

describe("IngestPlan schema", () => {
	test("a valid plan across all three output classes parses", () => {
		const plan = validPlan();
		expect(plan.memories).toHaveLength(1);
		expect(plan.graphOps).toHaveLength(2);
		expect(plan.filePatches).toHaveLength(1);
		expect(plan.schemaVersion).toBe(1);
	});

	test("the graph-op vocabulary is the full 19-op ontology surface", () => {
		expect(INGEST_GRAPH_OPERATIONS).toHaveLength(19);
		// Must include the dreaming skill's core ops.
		const vocab = new Set<string>(INGEST_GRAPH_OPERATIONS);
		for (const kind of [
			"create_entity",
			"merge_entities",
			"set_claim_value",
			"supersede_claim_value",
			"create_aspect",
			"create_link",
		] as const) {
			expect(vocab.has(kind)).toBe(true);
		}
	});

	test("rejects a graph op whose kind is outside the closed vocabulary", () => {
		const res = parseIngestPlan({
			...validBody,
			graphOps: [{ operation: "nuke_everything", payload: {} }],
			...validEnvelope,
		});
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.errors.join("; ")).toMatch(/operation/i);
	});

	test("file patches REQUIRE an id (collisions are deduped by patch id)", () => {
		const res = parseIngestPlan({
			...validBody,
			filePatches: [{ file: "AGENTS.md", append: "x" }],
			...validEnvelope,
		});
		expect(res.ok).toBe(false);
	});

	test("rejects an empty-content memory", () => {
		const res = parseIngestPlan({
			...validBody,
			memories: [{ content: "" }],
			...validEnvelope,
		});
		expect(res.ok).toBe(false);
	});

	test("rejects a plan missing envelope fields (jobId/agentId/sourceHash)", () => {
		const { jobId: _jobId, ...withoutJob } = validEnvelope;
		const res = parseIngestPlan({ ...validBody, ...withoutJob });
		expect(res.ok).toBe(false);
	});

	test("rejects the wrong schemaVersion (forward-compat fails closed)", () => {
		const res = parseIngestPlan({
			...validBody,
			...validEnvelope,
			schemaVersion: 2,
		});
		expect(res.ok).toBe(false);
	});

	test("no model-authored idempotency field is part of the schema", () => {
		// planHash is computed at apply from the body; it must NOT be a trusted
		// input. Assert the key is absent from the parsed type's required shape.
		const keys = Object.keys(validPlan()) as readonly (keyof IngestPlan)[];
		expect(keys).not.toContain("planHash");
	});
});
