import { describe, expect, test } from "bun:test";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { IngestContext } from "./context";
import { planIngestWithAgent, type DreamingAgentSessionProvider } from "./agent-planner";

function context(): IngestContext {
	return {
		jobId: "job-1",
		agentId: "agent-a",
		source: { kind: "payload", id: "source-1", content: "Alice prefers direct answers.", sourceKind: "payload", sourceId: "source-1", sourcePath: null, project: null },
		dreamingMd: "Keep only durable preferences.",
		graphSlice: "- alice / preferences = concise answers",
		focalEntityIds: [],
		budget: { window: 128_000, inputBudget: 102_400, reservedOverhead: 25_600, contextBudgetPct: 0.8 },
		tokens: { source: 5, dreamingMd: 5, graphSlice: 7, total: 17 },
		oversize: false,
	};
}

describe("Pi dreaming agent planner", () => {
	test("exposes read-only context and returns only a submitted plan body", async () => {
		let disposed = false;
		let prompt = "";
		const provider: DreamingAgentSessionProvider = {
			async createDreamingAgentSession(tools: readonly ToolDefinition[]) {
				return {
					async prompt(nextPrompt) {
						prompt = nextPrompt;
						const inspect = tools.find((tool) => tool.name === "inspect_dream_context");
						const submit = tools.find((tool) => tool.name === "submit_ingest_plan");
						expect(inspect).toBeDefined();
						expect(submit).toBeDefined();
						const inspected = await inspect?.execute("inspect", {}, undefined, undefined, {} as never);
						expect(inspected?.content[0]).toEqual({ type: "text", text: expect.stringContaining("Alice prefers direct answers.") });
						await submit?.execute(
							"submit",
							{ memories: [{ content: "Alice prefers direct answers.", importance: 0.9 }], graphOps: [], filePatches: [] },
							undefined,
							undefined,
							{} as never,
						);
					},
					dispose() {
						disposed = true;
					},
				};
			},
		};

		const result = await planIngestWithAgent(context(), provider);
		expect(result).toEqual({ ok: true, body: { memories: [{ content: "Alice prefers direct answers.", importance: 0.9 }], graphOps: [], filePatches: [] } });
		expect(prompt).toContain("submit_ingest_plan");
		expect(disposed).toBe(true);
	});

	test("fails closed when the agent never submits a plan", async () => {
		const provider: DreamingAgentSessionProvider = {
			async createDreamingAgentSession() {
				return { async prompt() {}, dispose() {} };
			},
		};
		await expect(planIngestWithAgent(context(), provider)).resolves.toEqual({ ok: false, message: "Agent ended without submit_ingest_plan" });
	});
});
