/**
 * Fetches Signet MCP tool definitions from the daemon and converts them
 * to OpenAI function-calling format for llama-server.
 *
 * Falls back to a curated static set if the daemon is unreachable.
 */

export interface OpenAiTool {
	type: "function";
	function: {
		name: string;
		description: string;
		parameters?: {
			type: "object";
			properties: Record<string, unknown>;
			required?: string[];
		};
	};
}

interface McpToolSchema {
	readonly name: string;
	readonly description?: string;
	readonly inputSchema?: {
		readonly type?: string;
		readonly properties?: Record<string, unknown>;
		readonly required?: readonly string[];
	};
}

interface McpListToolsResponse {
	readonly tools: ReadonlyArray<{
		readonly name: string;
		readonly description?: string;
		readonly inputSchema?: unknown;
	}>;
}

const SIGNET_CORE_TOOLS: ReadonlyArray<{
	name: string;
	description: string;
	parameters: Record<string, unknown>;
	required?: string[];
}> = [
	{
		name: "memory_search",
		description:
			"Search persistent memory using hybrid vector + keyword search. Use this to recall information from past conversations.",
		parameters: {
			query: { type: "string", description: "Search query text" },
			limit: { type: "number", description: "Max results (default 10)" },
		},
		required: ["query"],
	},
	{
		name: "memory_store",
		description:
			"Save a new memory to persistent storage with auto-embedding. Use this to remember important information.",
		parameters: {
			content: { type: "string", description: "Memory content to save" },
			type: { type: "string", description: "Memory type (fact, preference, decision, etc.)" },
			importance: { type: "number", description: "Importance score 0-1" },
			tags: { type: "string", description: "Comma-separated tags" },
		},
		required: ["content"],
	},
	{
		name: "memory_get",
		description: "Get a single memory by its ID.",
		parameters: {
			id: { type: "string", description: "Memory ID to retrieve" },
		},
		required: ["id"],
	},
	{
		name: "memory_list",
		description: "List memories with optional filters.",
		parameters: {
			limit: { type: "number", description: "Max results (default 100)" },
			offset: { type: "number", description: "Pagination offset" },
			type: { type: "string", description: "Filter by memory type" },
		},
	},
	{
		name: "memory_modify",
		description: "Edit an existing memory by ID.",
		parameters: {
			id: { type: "string", description: "Memory ID to modify" },
			content: { type: "string", description: "New content" },
			type: { type: "string", description: "New type" },
			importance: { type: "number", description: "New importance" },
			tags: { type: "string", description: "New tags (comma-separated)" },
			reason: { type: "string", description: "Why this edit is being made" },
		},
		required: ["id", "reason"],
	},
	{
		name: "memory_forget",
		description: "Soft-delete a memory by ID.",
		parameters: {
			id: { type: "string", description: "Memory ID to forget" },
			reason: { type: "string", description: "Why this memory should be forgotten" },
		},
		required: ["id", "reason"],
	},
	{
		name: "knowledge_expand",
		description: "Drill into entity details in the knowledge graph.",
		parameters: {
			entity_name: { type: "string", description: "Entity name to expand" },
			question: { type: "string", description: "What you want to know" },
		},
		required: ["entity_name"],
	},
	{
		name: "knowledge_list_entities",
		description: "List top-level knowledge graph entities.",
		parameters: {
			query: { type: "string", description: "Optional entity name filter" },
			limit: { type: "number", description: "Max entities (default 50)" },
		},
	},
	{
		name: "secret_list",
		description: "List available secret names (values are never exposed).",
		parameters: {},
	},
];

function normalizeInputSchema(schema: unknown): OpenAiTool["function"]["parameters"] {
	if (typeof schema !== "object" || schema === null) {
		return { type: "object", properties: {} };
	}
	const s = schema as Record<string, unknown>;
	return {
		type: "object",
		properties: (s.properties as Record<string, unknown>) || {},
		required: Array.isArray(s.required) ? (s.required as string[]) : undefined,
	};
}

function staticToOpenAiTools(): OpenAiTool[] {
	return SIGNET_CORE_TOOLS.map((tool) => ({
		type: "function" as const,
		function: {
			name: tool.name,
			description: tool.description,
			parameters: {
				type: "object",
				properties: tool.parameters,
				required: tool.required,
			},
		},
	}));
}

export async function fetchSignetTools(daemonUrl: string): Promise<OpenAiTool[]> {
	try {
		const res = await fetch(`${daemonUrl}/api/skills/mcp/tools`, {
			method: "GET",
			headers: {
				"Content-Type": "application/json",
			},
			signal: AbortSignal.timeout(5_000),
		});

		if (res.ok) {
			const json = (await res.json()) as {
				tools?: Array<{
					name: string;
					description?: string;
					inputSchema?: unknown;
				}>;
			};
			if (json.tools && Array.isArray(json.tools) && json.tools.length > 0) {
				return json.tools.map((tool) => ({
					type: "function" as const,
					function: {
						name: tool.name,
						description: tool.description || `Signet tool: ${tool.name}`,
						parameters: normalizeInputSchema(tool.inputSchema),
					},
				}));
			}
		}

		console.error("[signet] Using static tool definitions (daemon tools endpoint unavailable)");
		return staticToOpenAiTools();
	} catch {
		console.error("[signet] Daemon unreachable, using static tool definitions");
		return staticToOpenAiTools();
	}
}

export async function executeSignetTool(
	daemonUrl: string,
	toolName: string,
	args: Record<string, unknown>,
): Promise<string> {
	const mapping = TOOL_API_MAP[toolName];
	if (!mapping) {
		return `Unknown tool: ${toolName}`;
	}

	try {
		const url = mapping.buildUrl(daemonUrl, args);
		let body: string;
		if (mapping.hookPath) {
			const hookBody: Record<string, unknown> = { ...args, harness: "llama-cpp" };
			if (args.sessionKey) hookBody.sessionKey = args.sessionKey;
			body = JSON.stringify(hookBody);
		} else {
			body = JSON.stringify(args);
		}

		const res = await fetch(url, {
			method: mapping.method,
			headers: {
				"Content-Type": "application/json",
				"x-signet-runtime-path": "plugin",
				"x-signet-harness": "llama-cpp",
			},
			body: mapping.method !== "GET" ? body : undefined,
			signal: AbortSignal.timeout(30_000),
		});

		if (!res.ok) {
			const text = await res.text().catch(() => "unknown error");
			return `Error (HTTP ${res.status}): ${text}`;
		}

		const data = await res.json();
		if (typeof data === "string") return data;
		return JSON.stringify(data, null, 2);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		return `Error executing ${toolName}: ${msg}`;
	}
}

interface ToolApiMapping {
	method: string;
	buildUrl: (baseUrl: string, args: Record<string, unknown>) => string;
	hookPath?: string;
}

const TOOL_API_MAP: Record<string, ToolApiMapping> = {
	memory_search: { method: "POST", buildUrl: (base) => `${base}/api/hooks/recall`, hookPath: "recall" },
	memory_store: { method: "POST", buildUrl: (base) => `${base}/api/hooks/remember`, hookPath: "remember" },
	memory_get: {
		method: "GET",
		buildUrl: (base, args) => `${base}/api/memory/${encodeURIComponent(String(args.id ?? ""))}`,
	},
	memory_list: { method: "GET", buildUrl: (base) => `${base}/api/memories` },
	memory_modify: { method: "POST", buildUrl: (base) => `${base}/api/memory/modify` },
	memory_forget: { method: "POST", buildUrl: (base) => `${base}/api/memory/forget` },
	memory_feedback: { method: "POST", buildUrl: (base) => `${base}/api/memory/feedback` },
	knowledge_expand: { method: "POST", buildUrl: (base) => `${base}/api/knowledge/expand` },
	knowledge_list_entities: { method: "GET", buildUrl: (base) => `${base}/api/knowledge/navigation/entities` },
	secret_list: { method: "GET", buildUrl: (base) => `${base}/api/secrets` },
};
