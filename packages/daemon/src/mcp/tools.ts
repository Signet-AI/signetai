/**
 * MCP tool definitions for the Signet daemon.
 *
 * Creates an McpServer with memory operations exposed as MCP tools.
 * Tool handlers call the daemon's HTTP API — this avoids duplicating
 * the complex recall/remember logic and ensures feature parity.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface McpServerOptions {
	/** Daemon HTTP base URL (default: http://localhost:3850) */
	readonly daemonUrl?: string;
	/** Server version string */
	readonly version?: string;
}

interface DaemonResponse<T> {
	readonly ok: true;
	readonly data: T;
}

interface DaemonError {
	readonly ok: false;
	readonly error: string;
	readonly status: number;
}

type FetchResult<T> = DaemonResponse<T> | DaemonError;

// ---------------------------------------------------------------------------
// Internal HTTP helper
// ---------------------------------------------------------------------------

async function daemonFetch<T>(
	baseUrl: string,
	path: string,
	options: {
		readonly method?: string;
		readonly body?: unknown;
		readonly timeout?: number;
	} = {},
): Promise<FetchResult<T>> {
	const { method = "GET", body, timeout = 10_000 } = options;

	const init: RequestInit = {
		method,
		headers: {
			"Content-Type": "application/json",
			"x-signet-runtime-path": "plugin",
			"x-signet-actor": "mcp-server",
			"x-signet-actor-type": "harness",
		},
		signal: AbortSignal.timeout(timeout),
	};

	if (body !== undefined) {
		init.body = JSON.stringify(body);
	}

	try {
		const res = await fetch(`${baseUrl}${path}`, init);
		if (!res.ok) {
			const text = await res.text().catch(() => "unknown error");
			return { ok: false, error: text, status: res.status };
		}
		const data = (await res.json()) as T;
		return { ok: true, data };
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		return { ok: false, error: msg, status: 0 };
	}
}

function textResult(
	value: unknown,
): { content: ReadonlyArray<{ readonly type: "text"; readonly text: string }> } {
	return {
		content: [
			{
				type: "text" as const,
				text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
			},
		],
	};
}

function errorResult(
	msg: string,
): {
	content: ReadonlyArray<{ readonly type: "text"; readonly text: string }>;
	isError: true;
} {
	return {
		content: [{ type: "text" as const, text: msg }],
		isError: true as const,
	};
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createMcpServer(opts?: McpServerOptions): McpServer {
	const baseUrl = opts?.daemonUrl ?? "http://localhost:3850";
	const version = opts?.version ?? "0.1.0";

	const server = new McpServer({
		name: "signet",
		version,
	});

	// ------------------------------------------------------------------
	// memory_search — hybrid vector + keyword search
	// ------------------------------------------------------------------
	server.registerTool("memory_search", {
		title: "Search Memories",
		description: "Search memories using hybrid vector + keyword search",
		inputSchema: z.object({
			query: z.string().describe("Search query text"),
			limit: z.number().optional().describe("Max results to return (default 10)"),
			type: z.string().optional().describe("Filter by memory type"),
			min_score: z.number().optional().describe("Minimum relevance score threshold"),
		}),
	}, async ({ query, limit, type, min_score }) => {
		const result = await daemonFetch<unknown>(baseUrl, "/api/memory/recall", {
			method: "POST",
			body: {
				query,
				limit: limit ?? 10,
				type,
				importance_min: min_score,
			},
		});

		if (!result.ok) {
			return errorResult(`Search failed: ${result.error}`);
		}
		return textResult(result.data);
	});

	// ------------------------------------------------------------------
	// memory_store — save a new memory
	// ------------------------------------------------------------------
	server.registerTool("memory_store", {
		title: "Store Memory",
		description: "Save a new memory",
		inputSchema: z.object({
			content: z.string().describe("Memory content to save"),
			type: z.string().optional().describe("Memory type (fact, preference, decision, etc.)"),
			importance: z.number().optional().describe("Importance score 0-1"),
			tags: z.string().optional().describe("Comma-separated tags for categorization"),
		}),
		annotations: { readOnlyHint: false },
	}, async ({ content, type, importance, tags }) => {
		// Prepend tags prefix if provided (daemon parses [tag1,tag2]: format)
		let body = content;
		if (tags) {
			body = `[${tags}]: ${content}`;
		}

		const result = await daemonFetch<unknown>(baseUrl, "/api/memory/remember", {
			method: "POST",
			body: {
				content: body,
				importance,
			},
		});

		if (!result.ok) {
			return errorResult(`Store failed: ${result.error}`);
		}
		return textResult(result.data);
	});

	// ------------------------------------------------------------------
	// memory_get — retrieve a memory by ID
	// ------------------------------------------------------------------
	server.registerTool("memory_get", {
		title: "Get Memory",
		description: "Get a single memory by its ID",
		inputSchema: z.object({
			id: z.string().describe("Memory ID to retrieve"),
		}),
	}, async ({ id }) => {
		const result = await daemonFetch<unknown>(baseUrl, `/api/memory/${encodeURIComponent(id)}`);

		if (!result.ok) {
			return errorResult(`Get failed: ${result.error}`);
		}
		return textResult(result.data);
	});

	// ------------------------------------------------------------------
	// memory_list — list memories with optional filters
	// ------------------------------------------------------------------
	server.registerTool("memory_list", {
		title: "List Memories",
		description: "List memories with optional filters",
		inputSchema: z.object({
			limit: z.number().optional().describe("Max results (default 100)"),
			offset: z.number().optional().describe("Pagination offset"),
			type: z.string().optional().describe("Filter by memory type"),
		}),
	}, async ({ limit, offset, type }) => {
		const params = new URLSearchParams();
		if (limit !== undefined) params.set("limit", String(limit));
		if (offset !== undefined) params.set("offset", String(offset));
		if (type !== undefined) params.set("type", type);

		const qs = params.toString();
		const path = `/api/memories${qs ? `?${qs}` : ""}`;
		const result = await daemonFetch<unknown>(baseUrl, path);

		if (!result.ok) {
			return errorResult(`List failed: ${result.error}`);
		}
		return textResult(result.data);
	});

	// ------------------------------------------------------------------
	// memory_modify — edit an existing memory
	// ------------------------------------------------------------------
	server.registerTool("memory_modify", {
		title: "Modify Memory",
		description: "Edit an existing memory by ID",
		inputSchema: z.object({
			id: z.string().describe("Memory ID to modify"),
			content: z.string().optional().describe("New content"),
			type: z.string().optional().describe("New type"),
			importance: z.number().optional().describe("New importance"),
			tags: z.string().optional().describe("New tags (comma-separated)"),
			reason: z.string().describe("Why this edit is being made"),
		}),
		annotations: { readOnlyHint: false },
	}, async ({ id, content, type, importance, tags, reason }) => {
		const result = await daemonFetch<unknown>(
			baseUrl,
			`/api/memory/${encodeURIComponent(id)}`,
			{
				method: "PATCH",
				body: {
					content,
					type,
					importance,
					tags,
					reason,
				},
			},
		);

		if (!result.ok) {
			return errorResult(`Modify failed: ${result.error}`);
		}
		return textResult(result.data);
	});

	// ------------------------------------------------------------------
	// memory_forget — soft-delete a memory
	// ------------------------------------------------------------------
	server.registerTool("memory_forget", {
		title: "Forget Memory",
		description: "Soft-delete a memory by ID",
		inputSchema: z.object({
			id: z.string().describe("Memory ID to forget"),
			reason: z.string().describe("Why this memory should be forgotten"),
		}),
		annotations: { readOnlyHint: false },
	}, async ({ id, reason }) => {
		const result = await daemonFetch<unknown>(
			baseUrl,
			`/api/memory/${encodeURIComponent(id)}`,
			{
				method: "DELETE",
				body: { reason },
			},
		);

		if (!result.ok) {
			return errorResult(`Forget failed: ${result.error}`);
		}
		return textResult(result.data);
	});

	return server;
}
