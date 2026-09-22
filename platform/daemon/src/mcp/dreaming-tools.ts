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
export function createDreamingMcpServer(options: DreamingMcpServerOptions): McpServer {
	const server = new McpServer({ name: "signet-dreaming", version: options.version });
	for (const capability of getDreamingCapabilityManifest()) {
		server.registerTool(
			capability.id,
			{
				title: capability.title,
				description: capability.description,
				inputSchema: z.fromJSONSchema(capability.inputSchema) as never,
				annotations: { readOnlyHint: capability.readOnly },
			},
			(async (input: unknown) => {
				const result = await daemonFetch<unknown>(
					options.daemonUrl,
					`/api/dream/tools/${encodeURIComponent(capability.id)}`,
					{
						method: "POST",
						body: {
							input,
							agentId: options.agentId,
							actor: "dreaming-acpx",
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
