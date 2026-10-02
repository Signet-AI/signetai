import type { SignetClient } from "./index.js";
import type { ZodRawShape } from "zod";
import { MEMORY_TOOL_SPECS, type MemoryToolParameterSpec } from "./memory-tools-spec.js";
async function getZod() {
	const z = await import("zod");
	return z.z;
}

function buildFieldSchema(z: Awaited<ReturnType<typeof getZod>>, type: MemoryToolParameterSpec["type"]) {
	switch (type) {
		case "string":
			return z.string();
		case "number":
			return z.number();
		case "boolean":
			return z.boolean();
		case "aggregateBudget":
			return z.enum(["small", "medium", "large"]);
	}
}

function buildParameters(
	z: Awaited<ReturnType<typeof getZod>>,
	properties: Readonly<Record<string, MemoryToolParameterSpec>>,
) {
	const shape: Record<string, ZodRawShape[string]> = {};
	for (const [name, property] of Object.entries(properties)) {
		const schema = buildFieldSchema(z, property.type).describe(property.description);
		shape[name] = property.required ? schema : schema.optional();
	}
	return z.object(shape);
}

export async function memoryTools(client: SignetClient) {
	const z = await getZod();

	return {
		memory_search: {
			description: MEMORY_TOOL_SPECS.memory_search.description,
			parameters: buildParameters(z, MEMORY_TOOL_SPECS.memory_search.properties),
			execute: async ({
				query,
				limit,
				type,
				aggregate,
				aggregateBudget,
				saveAggregate,
				sessionKey,
				agentId,
				includeRecalled,
			}: {
				query: string;
				limit?: number;
				type?: string;
				aggregate?: boolean;
				aggregateBudget?: "small" | "medium" | "large";
				saveAggregate?: boolean;
				sessionKey?: string;
				agentId?: string;
				includeRecalled?: boolean;
			}) => {
				return client.recall(query, {
					limit,
					type,
					aggregate,
					aggregateBudget,
					saveAggregate,
					sessionKey,
					agentId,
					includeRecalled,
					recallSurface: "tool_call",
				});
			},
		},

		memory_store: {
			description: MEMORY_TOOL_SPECS.memory_store.description,
			parameters: buildParameters(z, MEMORY_TOOL_SPECS.memory_store.properties),
			execute: async ({ content, type, importance }: { content: string; type?: string; importance?: number }) => {
				return client.remember(content, { type, importance });
			},
		},

		memory_modify: {
			description: MEMORY_TOOL_SPECS.memory_modify.description,
			parameters: buildParameters(z, MEMORY_TOOL_SPECS.memory_modify.properties),
			execute: async ({
				id,
				content,
				reason,
				ifVersion,
			}: {
				id: string;
				content?: string;
				reason: string;
				ifVersion?: number;
			}) => {
				return client.modifyMemory(id, { content, reason, ifVersion });
			},
		},

		memory_forget: {
			description: MEMORY_TOOL_SPECS.memory_forget.description,
			parameters: buildParameters(z, MEMORY_TOOL_SPECS.memory_forget.properties),
			execute: async ({ id, reason }: { id: string; reason: string }) => {
				return client.forgetMemory(id, { reason });
			},
		},
	};
}

export async function getMemoryContext(
	client: SignetClient,
	userMessage: string,
	opts?: { readonly limit?: number; readonly minScore?: number },
): Promise<string> {
	const results = await client.recall(userMessage, {
		limit: opts?.limit ?? 5,
		minScore: opts?.minScore,
	});

	if (results.results.length === 0) return "";

	const lines = results.results.map((r) => `- ${r.content}`).join("\n");
	return `\n## Relevant Memories\n${lines}\n`;
}
