import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi, OpenClawToolResult } from "./openclaw-types.js";
import {
	memoryForget,
	memoryGet,
	memoryList,
	memoryModify,
	memoryRecall,
	memoryStore,
	sessionSearch,
} from "./memory-operations.js";
import { projectRecall } from "./recall-projection.js";

export interface MemoryToolOptions {
	readonly daemonUrl: string;
	readonly harness: string;
	readonly workspace: string;
	readonly channel?: string;
}

interface ToolSpec {
	readonly name: string;
	readonly label: string;
	readonly description: string;
	readonly parameters: unknown;
	readonly errorLabel: string;
	execute(params: unknown): Promise<OpenClawToolResult>;
}

function textResult(text: string, details?: Record<string, unknown>): OpenClawToolResult {
	return { content: [{ type: "text", text }], ...(details ? { details } : {}) };
}

function toolSpecs(options: MemoryToolOptions): readonly ToolSpec[] {
	return [
		{
			name: "memory_search",
			label: "Memory Search",
			description: "Search memories using hybrid vector + keyword search",
			parameters: Type.Object({
				query: Type.String({ description: "Search query text" }),
				limit: Type.Optional(Type.Number({ description: "Max results to return (default 10)" })),
				type: Type.Optional(Type.String({ description: "Filter by memory type" })),
				min_score: Type.Optional(Type.Number({ description: "Minimum relevance score threshold" })),
				aggregate: Type.Optional(Type.Boolean({ description: "Synthesize an aggregate answer from recall evidence" })),
				aggregate_budget: Type.Optional(
					Type.Union([Type.Literal("small"), Type.Literal("medium"), Type.Literal("large")]),
				),
				save_aggregate: Type.Optional(Type.Boolean({ description: "Save aggregate answers as memories" })),
				session_key: Type.Optional(Type.String({ description: "Session key for per-context recall dedupe" })),
				agent_id: Type.Optional(Type.String({ description: "Agent ID for scoped recall dedupe" })),
				include_recalled: Type.Optional(Type.Boolean({ description: "Include rows already recalled in this context" })),
			}),
			errorLabel: "Memory search",
			async execute(params) {
				const {
					query,
					limit,
					type,
					min_score,
					aggregate,
					aggregate_budget,
					save_aggregate,
					session_key,
					agent_id,
					include_recalled,
				} = params as {
					query: string;
					limit?: number;
					type?: string;
					min_score?: number;
					aggregate?: boolean;
					aggregate_budget?: "small" | "medium" | "large";
					save_aggregate?: boolean;
					session_key?: string;
					agent_id?: string;
					include_recalled?: boolean;
				};
				const recall = await memoryRecall(query, {
					...options,
					limit,
					type,
					minScore: min_score,
					aggregate,
					aggregateBudget: aggregate_budget,
					saveAggregate: save_aggregate,
					sessionKey: session_key,
					agentId: agent_id,
					includeRecalled: include_recalled,
				});
				const projection = projectRecall(recall);
				if (projection.rows.length === 0) return textResult("No relevant memories found.", { count: 0 });
				return textResult(projection.text ?? "", {
					count: projection.rows.length,
					memories: projection.rows,
					meta: projection.meta,
				});
			},
		},
		{
			name: "memory_store",
			label: "Memory Store",
			description: "Save a new memory",
			parameters: Type.Object({
				content: Type.String({ description: "Memory content to save" }),
				type: Type.Optional(Type.String({ description: "Memory type (fact, preference, decision, etc.)" })),
				importance: Type.Optional(Type.Number({ description: "Importance score 0-1" })),
				tags: Type.Optional(Type.String({ description: "Comma-separated tags for categorization" })),
			}),
			errorLabel: "Memory store",
			async execute(params) {
				const { content, type, importance, tags } = params as {
					content: string;
					type?: string;
					importance?: number;
					tags?: string;
				};
				const id = await memoryStore(content, { ...options, type, importance, tags });
				return id
					? textResult(`Memory saved successfully (id: ${id})`, { id })
					: textResult("Failed to save memory.", { error: "no id returned" });
			},
		},
		{
			name: "session_search",
			label: "Session Search",
			description: "Search active or completed session transcripts",
			parameters: Type.Object({
				query: Type.String({ description: "Natural language or keyword query" }),
				session_key: Type.Optional(Type.String({ description: "Specific transcript session key to search" })),
				current_session_key: Type.Optional(
					Type.String({ description: "Current session key; sub-agent lineage may resolve this to the parent session" }),
				),
				agent_id: Type.Optional(Type.String({ description: "Agent scope, default default" })),
				project: Type.Optional(Type.String({ description: "Optional project path filter" })),
				limit: Type.Optional(Type.Number({ description: "Max results to return (default 10, max 20)" })),
			}),
			errorLabel: "Session search",
			async execute(params) {
				const { query, session_key, current_session_key, agent_id, project, limit } = params as {
					query: string;
					session_key?: string;
					current_session_key?: string;
					agent_id?: string;
					project?: string;
					limit?: number;
				};
				const result = await sessionSearch(query, {
					...options,
					sessionKey: session_key,
					currentSessionKey: current_session_key,
					agentId: agent_id,
					project,
					limit,
				});
				return result === null
					? textResult("Session search failed: daemon unavailable", { error: "daemon unavailable" })
					: textResult(JSON.stringify(result, null, 2), { result });
			},
		},
		{
			name: "memory_get",
			label: "Memory Get",
			description: "Get a single memory by its ID",
			parameters: Type.Object({ id: Type.String({ description: "Memory ID to retrieve" }) }),
			errorLabel: "Memory get",
			async execute(params) {
				const { id } = params as { id: string };
				const memory = await memoryGet(id, options);
				return memory
					? textResult(JSON.stringify(memory, null, 2), { memory })
					: textResult(`Memory ${id} not found.`, { error: "not found" });
			},
		},
		{
			name: "memory_list",
			label: "Memory List",
			description: "List memories with optional filters",
			parameters: Type.Object({
				limit: Type.Optional(Type.Number({ description: "Max results (default 50, max 50)" })),
				offset: Type.Optional(Type.Number({ description: "Pagination offset" })),
				type: Type.Optional(Type.String({ description: "Filter by memory type" })),
			}),
			errorLabel: "Memory list",
			async execute(params) {
				const { limit, offset, type } = params as { limit?: number; offset?: number; type?: string };
				const result = await memoryList({ ...options, limit: Math.min(limit ?? 50, 50), offset, type });
				const lines: string[] = [];
				let totalChars = 0;
				for (const memory of result.memories) {
					const content = memory.content.length > 500 ? `${memory.content.slice(0, 500)}[truncated]` : memory.content;
					const line = `- [${memory.type}] ${content} (id: ${memory.id})`;
					if (totalChars + line.length > 8000) break;
					lines.push(line);
					totalChars += line.length;
				}
				return textResult(`${lines.length} of ${result.memories.length} memories:\n\n${lines.join("\n")}`, {
					count: result.memories.length,
					shown: lines.length,
					stats: result.stats,
				});
			},
		},
		{
			name: "memory_modify",
			label: "Memory Modify",
			description: "Edit an existing memory by ID",
			parameters: Type.Object({
				id: Type.String({ description: "Memory ID to modify" }),
				reason: Type.String({ description: "Why this edit is being made" }),
				content: Type.Optional(Type.String({ description: "New content" })),
				type: Type.Optional(Type.String({ description: "New type" })),
				importance: Type.Optional(Type.Number({ description: "New importance" })),
				tags: Type.Optional(Type.String({ description: "New tags (comma-separated)" })),
			}),
			errorLabel: "Memory modify",
			async execute(params) {
				const { id, reason, content, type, importance, tags } = params as {
					id: string;
					reason: string;
					content?: string;
					type?: string;
					importance?: number;
					tags?: string;
				};
				const success = await memoryModify(id, { content, type, importance, tags, reason }, options);
				return textResult(success ? `Memory ${id} updated.` : `Failed to update memory ${id}.`, { success });
			},
		},
		{
			name: "memory_forget",
			label: "Memory Forget",
			description: "Soft-delete a memory by ID",
			parameters: Type.Object({
				id: Type.String({ description: "Memory ID to forget" }),
				reason: Type.String({ description: "Why this memory should be forgotten" }),
			}),
			errorLabel: "Memory forget",
			async execute(params) {
				const { id, reason } = params as { id: string; reason: string };
				const success = await memoryForget(id, { ...options, reason });
				return textResult(success ? `Memory ${id} forgotten.` : `Failed to forget memory ${id}.`, { success });
			},
		},
	];
}

export function registerMemoryTools(api: OpenClawPluginApi, options: MemoryToolOptions): void {
	for (const tool of toolSpecs(options)) {
		api.registerTool(
			{
				name: tool.name,
				label: tool.label,
				description: tool.description,
				parameters: tool.parameters,
				async execute(_toolCallId, params) {
					try {
						return await tool.execute(params);
					} catch (error) {
						const message = String(error);
						return textResult(`${tool.errorLabel} failed: ${message}`, { error: message });
					}
				},
			},
			{ name: tool.name },
		);
	}
}
