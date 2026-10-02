export type MemoryToolParameterType = "string" | "number" | "boolean" | "aggregateBudget";

export interface MemoryToolParameterSpec {
	readonly type: MemoryToolParameterType;
	readonly description: string;
	readonly required?: true;
}

interface MemoryToolSpec {
	readonly description: string;
	readonly properties: Readonly<Record<string, MemoryToolParameterSpec>>;
}

export const MEMORY_TOOL_SPECS = {
	memory_search: {
		description: "Search the agent's memory for relevant information",
		properties: {
			query: { type: "string", description: "Search query", required: true },
			limit: { type: "number", description: "Max results" },
			type: { type: "string", description: "Memory type filter" },
			aggregate: { type: "boolean", description: "Synthesize an aggregate answer from recall evidence" },
			aggregateBudget: { type: "aggregateBudget", description: "Aggregate recall budget" },
			saveAggregate: { type: "boolean", description: "Save aggregate answers as memories" },
			sessionKey: { type: "string", description: "Session key for context dedupe" },
			agentId: { type: "string", description: "Agent ID for scoped recall" },
			includeRecalled: { type: "boolean", description: "Include rows already recalled in this context" },
		},
	},
	memory_store: {
		description: "Store information in the agent's memory",
		properties: {
			content: { type: "string", description: "Content to remember", required: true },
			type: { type: "string", description: "Memory type" },
			importance: { type: "number", description: "0-1 importance" },
		},
	},
	memory_modify: {
		description: "Modify an existing memory by ID",
		properties: {
			id: { type: "string", description: "Memory ID to modify", required: true },
			content: { type: "string", description: "New content" },
			reason: { type: "string", description: "Why this change is being made", required: true },
			ifVersion: { type: "number", description: "Optimistic lock version" },
		},
	},
	memory_forget: {
		description: "Forget a memory by ID (soft-delete)",
		properties: {
			id: { type: "string", description: "Memory ID to forget", required: true },
			reason: { type: "string", description: "Why this memory is being forgotten", required: true },
		},
	},
} as const satisfies Readonly<Record<string, MemoryToolSpec>>;
