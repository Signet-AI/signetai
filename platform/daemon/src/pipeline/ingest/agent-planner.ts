import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { IngestContext } from "./context";
import { IngestPlanBodySchema, type IngestPlanBody } from "./ingest-plan";

export interface DreamingAgentSession {
	prompt(text: string): Promise<void>;
	dispose(): void;
}

export interface DreamingAgentSessionProvider {
	createDreamingAgentSession(tools: readonly ToolDefinition[]): Promise<DreamingAgentSession>;
}

export type DreamingAgentPlanResult =
	| { readonly ok: true; readonly body: IngestPlanBody }
	| { readonly ok: false; readonly message: string };

function buildDreamingPrompt(ctx: IngestContext): string {
	return [
		"You are Signet's dreaming planner.",
		"Inspect the deterministic context before deciding what is durable.",
		"Do not write memories, mutate the graph, complete a lease, or access files directly.",
		"Use submit_ingest_plan exactly once with the complete plan, including empty arrays when nothing is durable.",
		`The leased job is ${ctx.jobId} for agent ${ctx.agentId}.`,
	].join("\n");
}

/**
 * Run the Pi AgentSession planning loop. Its two tools are deliberately
 * capability-constrained: context is read-only and the terminating submission
 * produces only an IngestPlan body. The daemon retains validation, writes, and
 * fenced lease completion in applyIngestPlan.
 */
export async function planIngestWithAgent(
	ctx: IngestContext,
	provider: DreamingAgentSessionProvider,
): Promise<DreamingAgentPlanResult> {
	let submitted: IngestPlanBody | null = null;
	const inspectContext = defineTool({
		name: "inspect_dream_context",
		label: "Inspect dreaming context",
		description: "Read the leased source, DREAMING.md runbook, and bounded existing graph slice.",
		parameters: Type.Object({}),
		async execute() {
			return {
				content: [
					{
						type: "text",
						text: JSON.stringify({
							source: ctx.source,
							runbook: ctx.dreamingMd,
							graphSlice: ctx.graphSlice,
							budget: ctx.budget,
						}),
					},
				],
				details: {},
			};
		},
	});
	const submitPlan = defineTool({
		name: "submit_ingest_plan",
		label: "Submit ingest plan",
		description: "Submit the final plan body for deterministic validation and application.",
		parameters: Type.Object({
			memories: Type.Array(Type.Any()),
			graphOps: Type.Array(Type.Any()),
			filePatches: Type.Array(Type.Any()),
			notes: Type.Optional(Type.Any()),
		}),
		async execute(_toolCallId, params) {
			const parsed = IngestPlanBodySchema.safeParse(params);
			if (!parsed.success) {
				return {
					content: [{ type: "text", text: `Plan failed schema validation: ${parsed.error.message}` }],
					details: {},
					isError: true,
				};
			}
			submitted = parsed.data;
			return {
				content: [{ type: "text", text: "Plan submitted for deterministic validation and apply." }],
				details: {},
				terminate: true,
			};
		},
	});

	const session = await provider.createDreamingAgentSession([inspectContext, submitPlan]);
	try {
		await session.prompt(buildDreamingPrompt(ctx));
	} finally {
		session.dispose();
	}
	return submitted ? { ok: true, body: submitted } : { ok: false, message: "Agent ended without submit_ingest_plan" };
}
