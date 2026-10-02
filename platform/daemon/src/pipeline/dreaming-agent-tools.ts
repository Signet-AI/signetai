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
	readonly restrictToAgent?: boolean;
}

function scopedInput(value: unknown, agentId: string): void {
	if (typeof value !== "object" || value === null) return;
	if ("agentId" in value && value.agentId !== agentId) throw new Error("Tool agent scope must match the active agent");
	for (const item of Object.values(value)) scopedInput(item, agentId);
}

function textResult(payload: DreamingCapabilityResult): { readonly type: "text"; readonly text: string } {
	return { type: "text", text: JSON.stringify(payload) };
}
export function createDreamingAgentTools(params: CreateDreamingAgentToolsParams): readonly PiAgentTool[] {
	return createDreamingCapabilities(params)
		.filter((capability) => !params.capabilityIds || params.capabilityIds.includes(capability.id))
		.map((capability) => {
			const schema = z.toJSONSchema(capability.inputSchema);
			const parameters = params.restrictToAgent
				? {
						...schema,
						properties: { ...schema.properties, agentId: { type: "string", const: params.agentId } },
						required: [...new Set([...(schema.required ?? []), "agentId"])],
					}
				: schema;
			return {
				name: capability.id,
				label: capability.title,
				description: params.restrictToAgent
					? `${capability.description} This session is restricted to agent ${params.agentId}.`
					: capability.description,
				parameters: Type.Unsafe(parameters),
				async execute(toolCallId, rawParams) {
					const startedAt = Date.now();
					if (params.restrictToAgent) {
						if (typeof rawParams !== "object" || rawParams === null || !("agentId" in rawParams))
							throw new Error("Tool agent scope must match the active agent");
						scopedInput(rawParams, params.agentId);
					}
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
