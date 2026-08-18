/** Restricted MCP binding for the canonical Dreaming capability registry. */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getDreamingCapabilityManifest } from "../pipeline/dreaming-capabilities.js";
import { z } from "zod";
import { daemonFetch, errorResult, textResult } from "./tools.js";

export interface DreamingMcpServerOptions {
	readonly daemonUrl: string;
	readonly agentId: string;
	readonly passId?: string;
	readonly version: string;
}

/**
 * Create the only MCP server an ACPX Dreaming pass may access. Every
 * registered capability is generated from the same daemon-owned registry as
 * Pi and CLI; agent scope is fixed at process construction.
 */
export function createDreamingMcpServer(options: DreamingMcpServerOptions): McpServer {
	const server = new McpServer({ name: "signet-dreaming", version: options.version });
	for (const capability of getDreamingCapabilityManifest()) {
		server.registerTool(
			capability.id,
			{
				title: capability.title,
				description: capability.description,
				// SDK types resolve against a second zod major in this monorepo;
				// runtime validation still uses the registry's public JSON Schema.
				inputSchema: z.fromJSONSchema(capability.inputSchema) as never,
				annotations: { readOnlyHint: capability.readOnly },
			},
			(async (input: unknown, extra?: { readonly requestId?: string | number }) => {
				const result = await daemonFetch<unknown>(
					options.daemonUrl,
					`/api/dream/tools/${encodeURIComponent(capability.id)}`,
					{
						method: "POST",
						body: {
							input,
							agentId: options.agentId,
							actor: "dreaming-acpx",
							...(extra?.requestId === undefined ? {} : { toolCallId: String(extra.requestId) }),
							...(options.passId ? { passId: options.passId } : {}),
						},
					},
				);
				return result.ok ? textResult(result.data) : errorResult(`Dreaming ${capability.id} failed: ${result.error}`);
			}) as never,
		);
	}
	return server;
}
