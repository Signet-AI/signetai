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
}

function scopedInput(value: unknown, allowed: ReadonlySet<string>): void {
	if (typeof value !== "object" || value === null) return;
	if ("agentId" in value && (typeof value.agentId !== "string" || !allowed.has(value.agentId)))
		throw new Error("Tool agent scope must be one of this pass's agents");
	for (const item of Object.values(value)) scopedInput(item, allowed);
}

function textResult(payload: DreamingCapabilityResult): { readonly type: "text"; readonly text: string } {
	return { type: "text", text: JSON.stringify(payload) };
}
export function createDreamingAgentTools(params: CreateDreamingAgentToolsParams): readonly PiAgentTool[] {
	return createDreamingCapabilities(params)
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
				async execute(toolCallId, rawParams) {
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
					return { content: [textResult(result)], details: { tool: capability.id } };
				},
			};
		});
}
