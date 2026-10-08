import * as Type from "typebox";
import type { PiAgentTool } from "./pi-agent-protocol";
import { z } from "zod";
import type {
	CreateDreamingCapabilitiesParams,
	DreamingCapabilityResult,
	DreamingCapabilityId,
} from "./dreaming-capabilities";
import { createDreamingCapabilities } from "./dreaming-capabilities";

export type { DreamingAgentEvidence } from "./dreaming-evidence";
export type { DreamingCapabilityResult as DreamingAgentToolResult } from "./dreaming-capabilities";
export interface CreateDreamingAgentToolsParams extends CreateDreamingCapabilitiesParams {
	readonly capabilityIds?: readonly DreamingCapabilityId[];
	readonly allowedAgentIds: readonly string[];
	readonly codemode?: boolean;
}

export const DREAMING_CODEMODE_TOOL_IDS: ReadonlySet<DreamingCapabilityId> = new Set<DreamingCapabilityId>([
	"search_entities",
	"get_entity",
	"list_aspect_claims",
	"validate_proposal",
	"attention_list",
	"zoom_history",
]);

function scopedInput(value: unknown, allowed: ReadonlySet<string>): void {
	if (typeof value !== "object" || value === null) return;
	if ("agentId" in value && (typeof value.agentId !== "string" || !allowed.has(value.agentId)))
		throw new Error("Tool agent scope must be one of this pass's agents");
	for (const item of Object.values(value)) scopedInput(item, allowed);
}

function textResult(payload: DreamingCapabilityResult): { readonly type: "text"; readonly text: string } {
	return { type: "text", text: JSON.stringify(payload) };
}
type DreamingPassToolCall = (
	tool: DreamingCapabilityId,
	toolCallId: string,
	input: unknown,
) => Promise<DreamingCapabilityResult | undefined>;

export interface DreamingAgentToolset {
	readonly tools: readonly PiAgentTool[];
	readonly call: DreamingPassToolCall;
}

const runningPassTools = new Map<string, { readonly agentId: string; readonly call: DreamingPassToolCall }>();

export function bindRunningDreamingPassTools(passId: string, agentId: string, call: DreamingPassToolCall): () => void {
	const binding = { agentId, call };
	runningPassTools.set(passId, binding);
	return () => {
		if (runningPassTools.get(passId) === binding) runningPassTools.delete(passId);
	};
}

export async function callRunningDreamingPassTool(
	passId: string,
	agentId: string,
	tool: DreamingCapabilityId,
	toolCallId: string,
	input: unknown,
): Promise<DreamingCapabilityResult | undefined> {
	const binding = runningPassTools.get(passId);
	if (binding?.agentId !== agentId) return undefined;
	try {
		return await binding.call(tool, toolCallId, input);
	} catch (error) {
		return { tool, ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

export function createDreamingAgentTools(params: CreateDreamingAgentToolsParams): readonly PiAgentTool[] {
	return createDreamingAgentToolset(params).tools;
}

export function createDreamingAgentToolset(params: CreateDreamingAgentToolsParams): DreamingAgentToolset {
	const runs = new Map<
		DreamingCapabilityId,
		(toolCallId: string, rawParams: unknown) => Promise<DreamingCapabilityResult>
	>();
	const tools = createDreamingCapabilities({ ...params, allowedScopes: params.allowedAgentIds })
		.filter((capability) => !params.capabilityIds || params.capabilityIds.includes(capability.id))
		.map((capability): PiAgentTool => {
			const schema = z.toJSONSchema(capability.inputSchema);
			const allowed = new Set(params.allowedAgentIds);
			const agentIdSchema =
				params.allowedAgentIds.length === 1
					? { type: "string", const: params.allowedAgentIds[0] }
					: { type: "string", enum: [...params.allowedAgentIds] };
			const defaultsToSessionAgent = allowed.has(params.agentId);
			const parameters = {
				...schema,
				properties: { ...schema.properties, agentId: agentIdSchema },
				required:
					defaultsToSessionAgent && params.allowedAgentIds.length > 1
						? (schema.required ?? [])
						: [...new Set([...(schema.required ?? []), "agentId"])],
			};
			const run = async (toolCallId: string, rawParams: unknown): Promise<DreamingCapabilityResult> => {
				const startedAt = Date.now();
				if (
					typeof rawParams !== "object" ||
					rawParams === null ||
					(!("agentId" in rawParams) && !defaultsToSessionAgent)
				)
					throw new Error("Tool agent scope must be one of this pass's agents");
				scopedInput(rawParams, allowed);
				const result = await capability.invoke(rawParams);
				await params.onToolCall?.({
					toolCallId,
					tool: capability.id,
					input: rawParams,
					output: result,
					latencyMs: Date.now() - startedAt,
				});
				return result;
			};
			runs.set(capability.id, run);
			return {
				name: capability.id,
				label: capability.title,
				description:
					params.allowedAgentIds.length === 1
						? `${capability.description} This session is restricted to agent ${params.allowedAgentIds[0]}.`
						: capability.description,
				parameters: Type.Unsafe(parameters),
				...(params.codemode
					? {
							exposure: DREAMING_CODEMODE_TOOL_IDS.has(capability.id) ? ("codemode" as const) : ("model-only" as const),
						}
					: {}),
				async execute(toolCallId, rawParams) {
					return { content: [textResult(await run(toolCallId, rawParams))], details: { tool: capability.id } };
				},
			};
		});
	return {
		tools,
		async call(tool, toolCallId, input) {
			return await runs.get(tool)?.(toolCallId, input);
		},
	};
}
