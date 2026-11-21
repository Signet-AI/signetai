import * as Type from "typebox";
import type { PiAgentTool } from "../../inference/providers/pi-agent-protocol";
import { z } from "zod";
import type {
	CreateDreamingCapabilitiesParams,
	DreamingCapabilityResult,
	DreamingCapabilityId,
} from "../operations/capabilities";
import { createDreamingCapabilities } from "../operations/capabilities";
import { DreamingToolScopeError } from "./pass-tools";

export type { DreamingAgentEvidence } from "../evidence/evidence";
export type { DreamingCapabilityResult as DreamingAgentToolResult } from "../operations/capabilities";
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
		throw new DreamingToolScopeError();
	for (const item of Object.values(value)) scopedInput(item, allowed);
}

function textResult(payload: DreamingCapabilityResult): { readonly type: "text"; readonly text: string } {
	return { type: "text", text: JSON.stringify(payload) };
}
export function createDreamingAgentTools(params: CreateDreamingAgentToolsParams): readonly PiAgentTool[] {
	return createDreamingCapabilities({ ...params, allowedScopes: params.allowedAgentIds })
		.filter((capability) => !params.capabilityIds || params.capabilityIds.includes(capability.id))
		.map((capability) => {
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
					const startedAt = Date.now();
					if (
						typeof rawParams !== "object" ||
						rawParams === null ||
						(!("agentId" in rawParams) && !defaultsToSessionAgent)
					)
						throw new DreamingToolScopeError();
					scopedInput(rawParams, allowed);
					const result = await capability.invoke(rawParams);
					await params.onToolCall?.({
						toolCallId,
						tool: capability.id,
						input: rawParams,
						output: result,
						latencyMs: Date.now() - startedAt,
					});
					return { content: [textResult(result)], details: { tool: capability.id } };
				},
			};
		});
}
