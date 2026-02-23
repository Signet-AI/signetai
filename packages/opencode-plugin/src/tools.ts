/**
 * Signet memory tools for OpenCode.
 *
 * 8 tools using tool() from @opencode-ai/plugin, mirroring the
 * tool surface of @signet/adapter-openclaw.
 */

import { tool } from "@opencode-ai/plugin";
import type { DaemonClient } from "./daemon-client.js";
import { HARNESS, READ_TIMEOUT, WRITE_TIMEOUT } from "./types.js";
import type { MemoryRecord, RecallResult } from "./types.js";

const DAEMON_OFFLINE_MSG =
	"Signet daemon not running. Start with: signet daemon start";

// ============================================================================
// Tool factory
// ============================================================================

export function createTools(
	client: DaemonClient,
): Record<string, ReturnType<typeof tool>> {
	return {
		memory_search: tool({
			description: "Search memories using hybrid vector + keyword search",
			args: {
				query: tool.schema.string().describe("Search query text"),
				limit: tool.schema
					.number()
					.optional()
					.describe("Max results to return (default 10)"),
				type: tool.schema.string().optional().describe("Filter by memory type"),
				min_score: tool.schema
					.number()
					.optional()
					.describe("Minimum relevance score threshold"),
			},
			async execute(args): Promise<string> {
				const result = await client.post<{ results: RecallResult[] }>(
					"/api/memory/recall",
					{
						query: args.query,
						limit: args.limit ?? 10,
						type: args.type,
						min_score: args.min_score,
					},
					READ_TIMEOUT,
				);

				if (result === null) return DAEMON_OFFLINE_MSG;
				if (!result.results.length) return "No memories found.";

				return result.results
					.map((r) => `[${r.type}] (score: ${r.score.toFixed(2)}) ${r.content}`)
					.join("\n");
			},
		}),

		memory_store: tool({
			description: "Save a new memory",
			args: {
				content: tool.schema.string().describe("Memory content to save"),
				type: tool.schema
					.string()
					.optional()
					.describe("Memory type (fact, preference, decision, etc.)"),
				importance: tool.schema
					.number()
					.optional()
					.describe("Importance score 0-1"),
				tags: tool.schema
					.array(tool.schema.string())
					.optional()
					.describe("Tags for categorization"),
			},
			async execute(args): Promise<string> {
				const result = await client.post<{ id?: string; memoryId?: string }>(
					"/api/memory/remember",
					{
						content: args.content,
						type: args.type,
						importance: args.importance,
						tags: args.tags,
						who: HARNESS,
					},
					WRITE_TIMEOUT,
				);

				if (result === null) return DAEMON_OFFLINE_MSG;
				const id = result.id ?? result.memoryId;
				return id ? `Memory saved (id: ${id})` : "Memory saved.";
			},
		}),

		memory_get: tool({
			description: "Get a single memory by its ID",
			args: {
				id: tool.schema.string().describe("Memory ID to retrieve"),
			},
			async execute(args): Promise<string> {
				const record = await client.get<MemoryRecord>(
					`/api/memory/${encodeURIComponent(args.id)}`,
					READ_TIMEOUT,
				);

				if (record === null) return DAEMON_OFFLINE_MSG;
				return JSON.stringify(record, null, 2);
			},
		}),

		memory_list: tool({
			description: "List memories with optional filters",
			args: {
				limit: tool.schema
					.number()
					.optional()
					.describe("Max results (default 100)"),
				offset: tool.schema.number().optional().describe("Pagination offset"),
				type: tool.schema.string().optional().describe("Filter by memory type"),
			},
			async execute(args): Promise<string> {
				const params = new URLSearchParams();
				if (args.limit !== undefined) params.set("limit", String(args.limit));
				if (args.offset !== undefined)
					params.set("offset", String(args.offset));
				if (args.type !== undefined) params.set("type", args.type);

				const qs = params.toString();
				const path = `/api/memories${qs ? `?${qs}` : ""}`;

				const result = await client.get<{
					memories: MemoryRecord[];
					stats: Record<string, number>;
				}>(path, READ_TIMEOUT);

				if (result === null) return DAEMON_OFFLINE_MSG;
				if (!result.memories.length) return "No memories found.";

				const lines = result.memories.map(
					(m) => `[${m.type}] ${m.content.slice(0, 80)}`,
				);
				return lines.join("\n");
			},
		}),

		memory_modify: tool({
			description: "Edit an existing memory by ID",
			args: {
				id: tool.schema.string().describe("Memory ID to modify"),
				content: tool.schema.string().optional().describe("New content"),
				type: tool.schema.string().optional().describe("New type"),
				importance: tool.schema
					.number()
					.optional()
					.describe("New importance score 0-1"),
				tags: tool.schema
					.string()
					.optional()
					.describe("New tags comma-separated"),
				reason: tool.schema.string().describe("Why this edit is being made"),
				if_version: tool.schema
					.number()
					.optional()
					.describe("Optimistic lock version"),
			},
			async execute(args): Promise<string> {
				const { id, reason, content, type, importance, tags, if_version } =
					args;

				const result = await client.patch<{ success?: boolean }>(
					`/api/memory/${encodeURIComponent(id)}`,
					{ content, type, importance, tags, reason, if_version },
					WRITE_TIMEOUT,
				);

				if (result === null) return DAEMON_OFFLINE_MSG;
				return result.success ? "Memory updated." : "Update failed.";
			},
		}),

		memory_forget: tool({
			description: "Soft-delete a memory by ID",
			args: {
				id: tool.schema.string().describe("Memory ID to forget"),
				reason: tool.schema
					.string()
					.describe("Why this memory should be forgotten"),
				force: tool.schema
					.boolean()
					.optional()
					.describe("Hard-delete instead of soft-delete"),
			},
			async execute(args): Promise<string> {
				const params = new URLSearchParams();
				params.set("reason", args.reason);
				if (args.force) params.set("force", "true");

				const result = await client.del<{ success?: boolean }>(
					`/api/memory/${encodeURIComponent(args.id)}?${params}`,
					WRITE_TIMEOUT,
				);

				if (result === null) return DAEMON_OFFLINE_MSG;
				return result.success ? "Memory forgotten." : "Delete failed.";
			},
		}),

		// Legacy aliases kept for backwards compat with memory.mjs

		remember: tool({
			description: "Save to persistent memory (alias for memory_store)",
			args: {
				content: tool.schema.string().describe("Content to remember"),
				type: tool.schema.string().optional().describe("Memory type"),
				importance: tool.schema.number().optional().describe("Importance 0-1"),
				tags: tool.schema
					.array(tool.schema.string())
					.optional()
					.describe("Tags"),
			},
			async execute(args): Promise<string> {
				const result = await client.post<{ id?: string; memoryId?: string }>(
					"/api/memory/remember",
					{
						content: args.content,
						type: args.type,
						importance: args.importance,
						tags: args.tags,
						who: HARNESS,
					},
					WRITE_TIMEOUT,
				);

				if (result === null) return DAEMON_OFFLINE_MSG;
				const id = result.id ?? result.memoryId;
				return id ? `Saved: ${args.content.slice(0, 50)}` : "Saved.";
			},
		}),

		recall: tool({
			description: "Query persistent memory (alias for memory_search)",
			args: {
				query: tool.schema.string().describe("Search query"),
				limit: tool.schema.number().optional().describe("Max results"),
			},
			async execute(args): Promise<string> {
				const result = await client.post<{ results: RecallResult[] }>(
					"/api/memory/recall",
					{ query: args.query, limit: args.limit ?? 10 },
					READ_TIMEOUT,
				);

				if (result === null) return DAEMON_OFFLINE_MSG;
				if (!result.results.length) return "No memories found.";

				return result.results.map((r) => `- ${r.content}`).join("\n");
			},
		}),
	};
}
