import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { IngestContext } from "./context";
import { INGEST_GRAPH_OPERATIONS, IngestPlanBodySchema, type IngestPlanBody } from "./ingest-plan";

export interface DreamingAgentSession {
	prompt(text: string): Promise<void>;
	abort(): Promise<void>;
	dispose(): void;
	getActiveToolNames(): readonly string[];
	getSystemPrompt?(): string;
	getFailureMessage?(): string | undefined;
}

export interface DreamingAgentSessionOptions {
	readonly maxTokens?: number;
}

export interface DreamingAgentSessionProvider {
	createDreamingAgentSession(
		tools: readonly ToolDefinition[],
		options?: DreamingAgentSessionOptions,
	): Promise<DreamingAgentSession | null>;
}

export interface DreamingAgentCapableProvider extends DreamingAgentSessionProvider {
	readonly dreamingTimeoutMs: number;
}

export function isDreamingAgentSessionProvider(provider: unknown): provider is DreamingAgentCapableProvider {
	return (
		typeof provider === "object" &&
		provider !== null &&
		"createDreamingAgentSession" in provider &&
		typeof provider.createDreamingAgentSession === "function" &&
		"dreamingTimeoutMs" in provider &&
		typeof provider.dreamingTimeoutMs === "number"
	);
}

export interface PlanIngestWithAgentOptions extends DreamingAgentSessionOptions {
	readonly signal?: AbortSignal;
	readonly timeoutMs?: number;
}

export type DreamingAgentPlanResult =
	| { readonly ok: true; readonly body: IngestPlanBody }
	| { readonly ok: false; readonly message: string; readonly unsupported?: true };

function buildDreamingPrompt(ctx: IngestContext): string {
	return [
		"You are Signet's dreaming planner.",
		"Inspect the deterministic context before deciding what is durable.",
		"Do not write memories, mutate the graph, complete a lease, or access files directly.",
		"Use submit_ingest_plan exactly once with the complete plan, including empty arrays when nothing is durable.",
		`For graphOps, operation must be one of: ${INGEST_GRAPH_OPERATIONS.join(", ")}.`,
		"Submit memories as durable observations, graphOps as { operation, payload }, and filePatches as { id, file, append }.",
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
	opts: PlanIngestWithAgentOptions = {},
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
				throw new Error(`Plan failed schema validation: ${parsed.error.message}`);
			}
			submitted = parsed.data;
			return {
				content: [{ type: "text", text: "Plan submitted for deterministic validation and apply." }],
				details: {},
				terminate: true,
			};
		},
	});

	let session: DreamingAgentSession | null = null;
	let didAbort = false;
	let abortPromise: Promise<void> | undefined;
	let timeout: ReturnType<typeof setTimeout> | undefined;
	let removeAbortListener: (() => void) | undefined;
	try {
		session = await provider.createDreamingAgentSession([inspectContext, submitPlan], { maxTokens: opts.maxTokens });
		if (!session) return { ok: false, unsupported: true, message: "Resolved provider does not support AgentSession planning" };
		const expectedTools = ["inspect_dream_context", "submit_ingest_plan"].sort();
		const activeTools = [...session.getActiveToolNames()].sort();
		if (
			activeTools.length !== expectedTools.length ||
			activeTools.some((tool, index) => tool !== expectedTools[index])
		) {
			return { ok: false, message: `Dreaming session exposed unexpected tools: ${activeTools.join(", ")}` };
		}

		const abort = () => {
			didAbort = true;
			abortPromise ??= session?.abort();
		};
		const aborted = new Promise<never>((_, reject) => {
			const rejectAborted = () => {
				abort();
				reject(opts.signal?.reason ?? new Error("Dreaming agent planning aborted"));
			};
			if (opts.signal?.aborted) {
				rejectAborted();
				return;
			}
			if (opts.signal) {
				opts.signal.addEventListener("abort", rejectAborted, { once: true });
				removeAbortListener = () => opts.signal?.removeEventListener("abort", rejectAborted);
			}
			if (opts.timeoutMs && opts.timeoutMs > 0) {
				timeout = setTimeout(() => {
					abort();
					reject(new Error(`Dreaming agent planning timed out after ${opts.timeoutMs}ms`));
				}, opts.timeoutMs);
			}
		});
		await Promise.race([session.prompt(buildDreamingPrompt(ctx)), aborted]);
		return submitted
			? { ok: true, body: submitted }
			: { ok: false, message: session.getFailureMessage?.() ?? "Agent ended without submit_ingest_plan" };
	} catch (error) {
		return { ok: false, message: error instanceof Error ? error.message : String(error) };
	} finally {
		if (timeout) clearTimeout(timeout);
		removeAbortListener?.();
		if (didAbort) await abortPromise;
		session?.dispose();
	}
}
