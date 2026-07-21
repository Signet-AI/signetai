import { describe, expect, test } from "bun:test";
import type { LlmProvider } from "../provider";
import type { IngestContext } from "./context";
import { planIngest } from "./planner";

function fakeProvider(response: string, opts?: Partial<LlmProvider>): LlmProvider {
	return {
		name: "fake",
		async generate(): Promise<string> {
			return response;
		},
		async available(): Promise<boolean> {
			return true;
		},
		...opts,
	} as LlmProvider;
}

function fakeContext(source = "Nicholai prefers GLM 5.1 via Z.AI, not OpenRouter."): IngestContext {
	return {
		jobId: "job1",
		agentId: "default",
		source: {
			kind: "payload",
			id: "job1",
			content: source,
			sourceKind: "payload",
			sourceId: "job1",
			sourcePath: null,
			project: null,
		},
		dreamingMd: "Prefer durable preferences over transient state.",
		graphSlice: "",
		focalEntityIds: [],
		budget: { window: 128_000, inputBudget: 102_400, reservedOverhead: 25_600, contextBudgetPct: 0.8 },
		tokens: { source: 10, dreamingMd: 8, graphSlice: 0, total: 18 },
		oversize: false,
	};
}

const VALID_BODY = {
	memories: [
		{ content: "Nicholai prefers GLM 5.1 via Z.AI.", importance: 0.9, type: "preference", tags: ["providers"] },
	],
	graphOps: [
		{ operation: "create_entity", payload: { name: "GLM 5.1", entity_type: "model" }, reason: "new entity", confidence: 0.9 },
		{ operation: "set_claim_value", payload: { entity: "GLM 5.1", aspect: "providers", group: "routing", claim: "preferred_endpoint", value: "Z.AI" } },
	],
	filePatches: [],
};

describe("planIngest (consolidated planner)", () => {
	test("parses a valid JSON plan body into a strict IngestPlan", async () => {
		const res = await planIngest(fakeContext(), { provider: fakeProvider(JSON.stringify(VALID_BODY)), model: "fake-model" });
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.plan.memories).toHaveLength(1);
		expect(res.plan.memories[0].content).toContain("GLM 5.1");
		expect(res.plan.graphOps).toHaveLength(2);
		expect(res.plan.graphOps[0].operation).toBe("create_entity");
		// Envelope attached from context, not the model.
		expect(res.plan.jobId).toBe("job1");
		expect(res.plan.agentId).toBe("default");
		expect(res.plan.sourceHash).toMatch(/^sha256:/);
		expect(res.plan.schemaVersion).toBe(1);
	});

	test("extracts JSON from reasoning-wrapped output (local-model defense)", async () => {
		const wrapped = `Here is my plan:\n\`\`\`json\n${JSON.stringify(VALID_BODY)}\n\`\`\`\nDone.`;
		const res = await planIngest(fakeContext(), { provider: fakeProvider(wrapped) });
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.plan.graphOps).toHaveLength(2);
	});

	test("returns malformed when no JSON object can be isolated", async () => {
		const res = await planIngest(fakeContext(), { provider: fakeProvider("the source is about preferences, no json here") });
		expect(res.ok).toBe(false);
		if (res.ok) return;
		expect(res.reason).toBe("malformed");
	});

	test("returns malformed when the JSON fails the strict schema", async () => {
		// graphOps with an out-of-vocabulary operation kind.
		const bad = { ...VALID_BODY, graphOps: [{ operation: "nuke_everything", payload: {} }] };
		const res = await planIngest(fakeContext(), { provider: fakeProvider(JSON.stringify(bad)) });
		expect(res.ok).toBe(false);
		if (res.ok) return;
		expect(res.reason).toBe("malformed");
		expect(res.message).toMatch(/schema validation/i);
	});

	test("returns provider-error when generate throws", async () => {
		const provider = fakeProvider("", {
			async generate(): Promise<string> {
				throw new Error("boom");
			},
		});
		const res = await planIngest(fakeContext(), { provider });
		expect(res.ok).toBe(false);
		if (res.ok) return;
		expect(res.reason).toBe("provider-error");
	});

	test("an empty plan (nothing durable) is a legitimate ok result", async () => {
		const empty = { memories: [], graphOps: [], filePatches: [] };
		const res = await planIngest(fakeContext("running tests... build 42 passed"), {
			provider: fakeProvider(JSON.stringify(empty)),
		});
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.plan.memories).toHaveLength(0);
	});
});
