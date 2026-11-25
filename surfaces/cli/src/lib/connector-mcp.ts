import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
	ListToolsRequestSchema,
	ListToolsResultSchema,
	CallToolRequestSchema,
	CallToolResultSchema,
	ListResourcesRequestSchema,
	ListResourcesResultSchema,
	ReadResourceRequestSchema,
	ReadResourceResultSchema,
	ListResourceTemplatesRequestSchema,
	ListResourceTemplatesResultSchema,
	ListPromptsRequestSchema,
	ListPromptsResultSchema,
	GetPromptRequestSchema,
	GetPromptResultSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { SignetUnauthorizedError, SignetForbiddenError } from "../../../../libs/sdk/src/index.js";
import { resolveTarget, type ResolveTargetOptions } from "../../../../libs/sdk/src/node.js";

export async function runConnectorMcp(harness: string, options: ResolveTargetOptions = {}): Promise<void> {
	const target = await resolveTarget({ ...options, harness });
	const remote = new Client({ name: "signet-connector", version: "1.0.0" });
	const upstream = new StreamableHTTPClientTransport(new URL("/mcp", target.url), {
		fetch: async (input, init) => {
			const headers = new Headers(init?.headers);
			const credential = await target.credential.get({ signal: init?.signal ?? undefined });
			if (credential) headers.set("authorization", `Bearer ${credential}`);
			headers.delete("x-signet-actor");
			headers.delete("x-signet-actor-type");
			const response = await fetch(input, {
				...init,
				headers,
				redirect: "error",
				signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000),
			});
			if (response.status === 401 || response.status === 403) {
				const body: unknown = await response.json().catch(() => ({}));
				const reason =
					typeof body === "object" && body !== null && "reason" in body && typeof body.reason === "string"
						? body.reason
						: "unknown";
				if (response.status === 401) throw new SignetUnauthorizedError(reason, body);
				throw new SignetForbiddenError(reason, undefined, body);
			}
			return response;
		},
	});
	await remote.connect(upstream);
	const capabilities = remote.getServerCapabilities() ?? {};
	const server = new Server(
		{ name: "signet", version: "1.0.0" },
		{
			capabilities: {
				...(capabilities.tools ? { tools: {} } : {}),
				...(capabilities.resources ? { resources: {} } : {}),
				...(capabilities.prompts ? { prompts: {} } : {}),
			},
		},
	);
	if (capabilities.tools) {
		server.setRequestHandler(ListToolsRequestSchema, (request) => remote.request(request, ListToolsResultSchema));
		server.setRequestHandler(CallToolRequestSchema, (request) => remote.request(request, CallToolResultSchema));
	}
	if (capabilities.resources) {
		server.setRequestHandler(ListResourcesRequestSchema, (request) =>
			remote.request(request, ListResourcesResultSchema),
		);
		server.setRequestHandler(ReadResourceRequestSchema, (request) => remote.request(request, ReadResourceResultSchema));
		server.setRequestHandler(ListResourceTemplatesRequestSchema, (request) =>
			remote.request(request, ListResourceTemplatesResultSchema),
		);
	}
	if (capabilities.prompts) {
		server.setRequestHandler(ListPromptsRequestSchema, (request) => remote.request(request, ListPromptsResultSchema));
		server.setRequestHandler(GetPromptRequestSchema, (request) => remote.request(request, GetPromptResultSchema));
	}
	let closing: Promise<void> | undefined;
	const close = () => {
		closing ??= Promise.all([server.close(), remote.close()]).then(() => undefined);
		return closing;
	};
	server.onclose = () => {
		void close();
	};
	process.once("SIGTERM", () => {
		void close();
	});
	process.once("SIGINT", () => {
		void close();
	});
	try {
		await server.connect(new StdioServerTransport());
	} catch (error) {
		await close();
		throw error;
	}
}
