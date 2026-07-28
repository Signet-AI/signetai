import { describe, expect, test } from "bun:test";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createPiModelProvider } from "../pi-provider";
import type { IngestContext } from "./context";
import { planIngestWithAgent, type DreamingAgentSessionProvider } from "./agent-planner";

function context(): IngestContext {
	return {
		jobId: "job-1",
		agentId: "agent-a",
		source: {
			kind: "payload",
			id: "source-1",
			content: "Alice prefers direct answers.",
			sourceKind: "payload",
			sourceId: "source-1",
			sourcePath: null,
			project: null,
		},
		dreamingMd: "Keep only durable preferences.",
		graphSlice: "- alice / preferences = concise answers",
		focalEntityIds: [],
		budget: { window: 128_000, inputBudget: 102_400, reservedOverhead: 25_600, contextBudgetPct: 0.8 },
		tokens: { source: 5, dreamingMd: 5, graphSlice: 7, total: 17 },
		oversize: false,
	};
}

const DREAMING_TOOLS = ["inspect_dream_context", "submit_ingest_plan"];

function activeDreamingTools(): readonly string[] {
	return DREAMING_TOOLS;
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
						expect(inspected?.content[0]).toEqual({
							type: "text",
							text: expect.stringContaining("Alice prefers direct answers."),
						});
						await submit?.execute(
							"submit",
							{
								memories: [{ content: "Alice prefers direct answers.", importance: 0.9 }],
								graphOps: [],
								filePatches: [],
							},
							undefined,
							undefined,
							{} as never,
						);
					},
					async abort() {},
					dispose() {
						disposed = true;
					},
					getActiveToolNames: activeDreamingTools,
				};
			},
		};

		const result = await planIngestWithAgent(context(), provider);
		expect(result).toEqual({
			ok: true,
			body: {
				memories: [{ content: "Alice prefers direct answers.", importance: 0.9 }],
				graphOps: [],
				filePatches: [],
			},
		});
		expect(prompt).toContain("submit_ingest_plan");
		expect(prompt).toContain("create_entity");
		expect(disposed).toBe(true);
	});

	test("fails closed when the agent never submits a plan", async () => {
		const provider: DreamingAgentSessionProvider = {
			async createDreamingAgentSession() {
				return { async prompt() {}, async abort() {}, dispose() {}, getActiveToolNames: activeDreamingTools };
			},
		};
		await expect(planIngestWithAgent(context(), provider)).resolves.toEqual({
			ok: false,
			message: "Agent ended without submit_ingest_plan",
		});
	});

	test("surfaces a provider failure when the agent cannot submit", async () => {
		const provider: DreamingAgentSessionProvider = {
			async createDreamingAgentSession() {
				return {
					async prompt() {},
					async abort() {},
					dispose() {},
					getActiveToolNames: activeDreamingTools,
					getFailureMessage: () => "provider rejected the request",
				};
			},
		};
		await expect(planIngestWithAgent(context(), provider)).resolves.toEqual({
			ok: false,
			message: "provider rejected the request",
		});
	});

	test("aborts a stuck agent when the caller cancels", async () => {
		let aborted = false;
		const controller = new AbortController();
		const provider: DreamingAgentSessionProvider = {
			async createDreamingAgentSession() {
				return {
					async prompt() {
						await new Promise<void>(() => {});
					},
					async abort() {
						aborted = true;
					},
					dispose() {},
					getActiveToolNames: activeDreamingTools,
				};
			},
		};
		const planned = planIngestWithAgent(context(), provider, { signal: controller.signal });
		controller.abort(new Error("worker stopped"));
		await expect(planned).resolves.toEqual({ ok: false, message: "worker stopped" });
		expect(aborted).toBe(true);
	});

	test("the real Pi session exposes only the daemon-owned tools", async () => {
		const inspect = defineTool({
			name: "inspect_dream_context",
			label: "Inspect dreaming context",
			description: "test",
			parameters: Type.Object({}),
			async execute() {
				return { content: [], details: {} };
			},
		});
		const submit = defineTool({
			name: "submit_ingest_plan",
			label: "Submit ingest plan",
			description: "test",
			parameters: Type.Object({}),
			async execute() {
				return { content: [], details: {}, terminate: true };
			},
		});
		const provider = createPiModelProvider({
			executor: "openai-compatible",
			model: "test-model",
			baseUrl: "http://127.0.0.1:1/v1",
		});
		const session = await provider.createDreamingAgentSession([inspect, submit]);
		expect(session).not.toBeNull();
		if (!session) return;
		try {
			expect([...session.getActiveToolNames()].sort()).toEqual(DREAMING_TOOLS);
			expect(session.getSystemPrompt?.()).toContain("Signet's dreaming planner");
		} finally {
			session.dispose();
		}
	});
});
