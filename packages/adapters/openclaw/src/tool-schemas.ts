/**
 * JSON Schema definitions for OpenClaw tool operations.
 *
 * These schemas describe each tool's parameters so OpenClaw can
 * present them to the LLM as function definitions.
 */

export const memorySearchSchema = {
	name: "memory_search",
	description: "Search memories using hybrid vector + keyword search",
	parameters: {
		type: "object",
		properties: {
			query: {
				type: "string",
				description: "Search query text",
			},
			limit: {
				type: "number",
				description: "Max results to return (default 10)",
			},
			type: {
				type: "string",
				description: "Filter by memory type",
			},
			min_score: {
				type: "number",
				description: "Minimum relevance score threshold",
			},
		},
		required: ["query"],
	},
} as const;

export const memoryStoreSchema = {
	name: "memory_store",
	description: "Save a new memory",
	parameters: {
		type: "object",
		properties: {
			content: {
				type: "string",
				description: "Memory content to save",
			},
			type: {
				type: "string",
				description: "Memory type (fact, preference, decision, etc.)",
			},
			importance: {
				type: "number",
				description: "Importance score 0-1",
			},
			tags: {
				type: "array",
				items: { type: "string" },
				description: "Tags for categorization",
			},
		},
		required: ["content"],
	},
} as const;

export const memoryGetSchema = {
	name: "memory_get",
	description: "Get a single memory by its ID",
	parameters: {
		type: "object",
		properties: {
			id: {
				type: "string",
				description: "Memory ID to retrieve",
			},
		},
		required: ["id"],
	},
} as const;

export const memoryListSchema = {
	name: "memory_list",
	description: "List memories with optional filters",
	parameters: {
		type: "object",
		properties: {
			limit: {
				type: "number",
				description: "Max results (default 100)",
			},
			offset: {
				type: "number",
				description: "Pagination offset",
			},
			type: {
				type: "string",
				description: "Filter by memory type",
			},
		},
	},
} as const;

export const memoryModifySchema = {
	name: "memory_modify",
	description: "Edit an existing memory by ID",
	parameters: {
		type: "object",
		properties: {
			id: {
				type: "string",
				description: "Memory ID to modify",
			},
			content: {
				type: "string",
				description: "New content (optional)",
			},
			type: {
				type: "string",
				description: "New type (optional)",
			},
			importance: {
				type: "number",
				description: "New importance (optional)",
			},
			tags: {
				type: "string",
				description: "New tags comma-separated (optional)",
			},
			reason: {
				type: "string",
				description: "Why this edit is being made",
			},
		},
		required: ["id", "reason"],
	},
} as const;

export const memoryForgetSchema = {
	name: "memory_forget",
	description: "Soft-delete a memory by ID",
	parameters: {
		type: "object",
		properties: {
			id: {
				type: "string",
				description: "Memory ID to forget",
			},
			reason: {
				type: "string",
				description: "Why this memory should be forgotten",
			},
		},
		required: ["id", "reason"],
	},
} as const;
