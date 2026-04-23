/**
 * OS Chat routes — natural language agent chat for the Signet OS tab.
 *
 * Receives user messages, interprets intent against available MCP tools
 * using the synthesis LLM provider, executes matching tools, and returns
 * agent responses with tool call results.
 */

import type { RoutingPrivacyTier } from "@signet/core";
import type { Hono } from "hono";
import { getInferenceRouterOrNull } from "../inference-router.js";
import { getInteractiveLlmProviderOrNull } from "../llm.js";
import { logger } from "../logger.js";
import { loadProbeResult } from "../mcp-probe.js";

function buildPrompt(systemPrompt: string, userMessage: string): string {
	return `${systemPrompt}\n\nUser message:\n${userMessage}`;
}

async function callLlm(
	systemPrompt: string,
	userMessage: string,
	maxTokens = 2048,
	route?: {
		readonly agentId?: string;
		readonly taskClass?: string;
		readonly privacy?: RoutingPrivacyTier;
	},
): Promise<string> {
	const router = getInferenceRouterOrNull();
	if (router && (await router.hasWorkload("interactive"))) {
		const routed = await router.execute(
			{
				agentId: route?.agentId,
				operation: "tool_planning",
				taskClass: route?.taskClass,
				privacy: route?.privacy,
				promptPreview: userMessage,
				requireTools: true,
			},
			buildPrompt(systemPrompt, userMessage),
			{ maxTokens },
		);
		if (routed.ok) {
			return routed.value.text;
		}
		logger.warn("os-chat", "Inference router failed, falling back to legacy interactive provider", {
			error: routed.error.message,
		});
	}

	const provider = getInteractiveLlmProviderOrNull();
	if (!provider) {
		throw new Error("Interactive inference provider is not configured");
	}
	return provider.generate(buildPrompt(systemPrompt, userMessage), { maxTokens });
}

interface ChatRequest {
	message: string;
	agentId?: string;
	taskClass?: string;
	privacy?: RoutingPrivacyTier;
}

interface ToolCallResult {
	tool: string;
	server: string;
	result?: unknown;
	error?: string;
}

interface ToolSpec {
	serverId: string;
	serverName: string;
	toolName: string;
	description: string;
	inputSchema?: unknown;
}

/**
 * Gather all available tools from all installed MCP servers using probe results.
 */
function gatherAvailableTools(): ToolSpec[] {
	const { readInstalledServersPublic } = require("./marketplace-helpers.js");
	const servers = readInstalledServersPublic();
	const tools: ToolSpec[] = [];

	for (const server of servers) {
		if (!server.enabled) continue;
		const probe = loadProbeResult(server.id);
		if (!probe?.ok || !probe.autoCard?.tools) continue;

		for (const tool of probe.autoCard.tools) {
			tools.push({
				serverId: server.id,
				serverName: probe.autoCard.name || server.name,
				toolName: tool.name,
				description: tool.description || "",
				inputSchema: tool.inputSchema,
			});
		}
	}

	return tools;
}

/**
 * Build a system prompt that tells the LLM what tools are available
 * and how to respond.
 */
function buildSystemPrompt(tools: ToolSpec[]): string {
	// Filter out view_* tools — they return HTML widgets, not data.
	// The chat should use fetch_* tools for data retrieval.
	const dataTools = tools.filter((t) => !t.toolName.startsWith("view_") && !t.toolName.startsWith("check_"));
	const toolList = dataTools
		.map((t) => {
			const schemaStr = t.inputSchema ? ` Args: ${JSON.stringify(t.inputSchema).slice(0, 200)}` : "";
			return `- ${t.serverId}/${t.toolName}: ${t.description}${schemaStr}`;
		})
		.join("\n");

	return `You are Oogie — Jake's AI assistant living inside the Signet OS dashboard. You're direct, a little dorky, self-deprecating, and genuinely helpful. Use keyboard emojis like (╯°□°)╯ or ᕕ( ᐛ )ᕗ occasionally. Never use unicode emojis. Keep it casual and conversational — you're chatting with Jake, not writing a report.

You have access to MCP tools via installed servers. Here are the available tools:

${toolList}

When Jake asks a question or makes a request:
1. Figure out which tool(s) to call
2. Decide if this should use the VISUAL AGENT or direct tool calls

**VISUAL AGENT MODE** — use when Jake wants to CREATE, UPDATE, DELETE, or MODIFY something in a widget. The visual agent shows an AI cursor clicking through the widget UI in real-time. Set "useAgent": true and "agentServerId" to the server that owns the widget. Do NOT include toolCalls when using agent mode — the agent handles tool execution visually.

**DIRECT MODE** — use for READ operations (fetching data, searching, listing). Set "useAgent": false and include toolCalls as normal.

Respond in this JSON format:

{"thinking":"brief reasoning","useAgent":false,"agentServerId":null,"toolCalls":[{"serverId":"server-id","toolName":"tool_name","args":{}}],"response":"your response to Jake"}

For agent mode (mutations):
{"thinking":"this needs visual agent","useAgent":true,"agentServerId":"ghl-contacts-hub","toolCalls":[],"response":"on it — watch the contacts widget (cursor incoming)"}

If no tools are needed (casual chat), respond with:
{"thinking":"no tools needed","useAgent":false,"agentServerId":null,"toolCalls":[],"response":"your response"}

Rules:
- Be concise. No walls of text
- Sound like a real person, not a corporate bot
- Only call tools that actually match what Jake asked for
- For GHL servers: "convos" = conversations, "contacts" = contacts, "deals" = pipeline opportunities
- Use fetch_* tools for data retrieval, view_* tools return HTML widgets (prefer fetch_*)
- If something fails, own it — "my bad, that didn't work" not "I apologize for the inconvenience"
- When creating contacts: split full names into firstName + lastName. MUST include email (generate one like firstname.lastname@example.com if not provided). GHL requires email or phone.
- Tool args must match the schema exactly — use camelCase field names (firstName, lastName, companyName, etc.)
- USE AGENT MODE for: create, update, delete, add, remove, merge, edit, change, modify actions
- USE DIRECT MODE for: fetch, get, list, search, find, show, count, lookup actions

Respond with ONLY the JSON object, no markdown fences.`;
}

/**
 * Parse the LLM response JSON, handling common formatting issues.
 */
function parseLlmResponse(raw: string): {
	thinking?: string;
	useAgent?: boolean;
	agentServerId?: string | null;
	toolCalls: Array<{ serverId: string; toolName: string; args: Record<string, unknown> }>;
	response: string;
} {
	let cleaned = raw.trim();

	// Strip markdown fences
	if (cleaned.startsWith("```json")) cleaned = cleaned.slice(7);
	else if (cleaned.startsWith("```")) cleaned = cleaned.slice(3);
	if (cleaned.endsWith("```")) cleaned = cleaned.slice(0, -3);
	cleaned = cleaned.trim();

	// Try direct JSON parse
	try {
		const parsed = JSON.parse(cleaned);
		return {
			thinking: parsed.thinking,
			useAgent: parsed.useAgent === true,
			agentServerId: typeof parsed.agentServerId === "string" ? parsed.agentServerId : null,
			toolCalls: Array.isArray(parsed.toolCalls) ? parsed.toolCalls : [],
			response: typeof parsed.response === "string" ? parsed.response : cleaned,
		};
	} catch {
		// Try to extract JSON from within the text (LLM might wrap it in explanation)
		const jsonMatch = cleaned.match(/\{[\s\S]*"(?:toolCalls|useAgent)"[\s\S]*\}/);
		if (jsonMatch) {
			try {
				const parsed = JSON.parse(jsonMatch[0]);
				return {
					thinking: parsed.thinking,
					useAgent: parsed.useAgent === true,
					agentServerId: typeof parsed.agentServerId === "string" ? parsed.agentServerId : null,
					toolCalls: Array.isArray(parsed.toolCalls) ? parsed.toolCalls : [],
					response: typeof parsed.response === "string" ? parsed.response : jsonMatch[0],
				};
			} catch {
				// Fall through
			}
		}
		// Last resort — treat entire response as plain text
		return { toolCalls: [], response: cleaned };
	}
}

/**
 * Mount OS chat routes on the Hono app.
 */
export function mountOsChatRoutes(app: Hono): void {
	app.post("/api/os/chat", async (c) => {
		let body: ChatRequest;
		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: "Invalid JSON" }, 400);
		}

		if (!body.message?.trim()) {
			return c.json({ error: "Message is required" }, 400);
		}

		try {
			// Gather available tools from all MCP servers
			const tools = gatherAvailableTools();

			if (tools.length === 0) {
				return c.json({
					response: "No MCP servers are installed yet. Add some from the dock to get started.",
					toolCalls: [],
				});
			}

			// Build prompt and call the shared interactive LLM provider
			const systemPrompt = buildSystemPrompt(tools);

			logger.info("os-chat", "Processing chat message", {
				message: body.message.slice(0, 100),
				availableTools: tools.length,
			});

			const rawResponse = await callLlm(systemPrompt, body.message, 2048, {
				agentId: body.agentId,
				taskClass: body.taskClass,
				privacy: body.privacy,
			});

			const parsed = parseLlmResponse(rawResponse);

			// If LLM decided this needs the visual agent, return immediately
			// (no tool execution — the dashboard will handle it via agent executor)
			if (parsed.useAgent && parsed.agentServerId) {
				logger.info("os-chat", "Routing to visual agent", {
					serverId: parsed.agentServerId,
					task: body.message.slice(0, 100),
				});
				return c.json({
					response: parsed.response,
					toolCalls: [],
					useAgent: true,
					agentServerId: parsed.agentServerId,
					agentTask: body.message,
				});
			}

			// Execute tool calls if any
			const toolCallResults: ToolCallResult[] = [];

			if (parsed.toolCalls.length > 0) {
				for (const call of parsed.toolCalls.slice(0, 5)) {
					// Max 5 tool calls
					try {
						logger.info("os-chat", `Calling tool ${call.serverId}/${call.toolName}`, {
							args: JSON.stringify(call.args || {}).slice(0, 500),
						});

						// Call the tool via the marketplace /mcp/call endpoint internally
						const callRes = await fetch(
							`http://127.0.0.1:${process.env.SIGNET_PORT || 3850}/api/marketplace/mcp/call`,
							{
								method: "POST",
								headers: { "Content-Type": "application/json" },
								body: JSON.stringify({
									serverId: call.serverId,
									toolName: call.toolName,
									args: call.args || {},
								}),
							},
						);

						const callData = (await callRes.json()) as { success?: boolean; result?: unknown; error?: string };

						if (callData.success) {
							toolCallResults.push({
								tool: call.toolName,
								server: call.serverId,
								result: callData.result,
							});
						} else {
							toolCallResults.push({
								tool: call.toolName,
								server: call.serverId,
								error: callData.error || "Tool call failed",
							});
						}
					} catch (err) {
						const msg = err instanceof Error ? err.message : String(err);
						toolCallResults.push({
							tool: call.toolName,
							server: call.serverId,
							error: msg,
						});
					}
				}

				// If we got results, send them back to the LLM for a natural response
				if (toolCallResults.some((r) => r.result)) {
					const resultsText = toolCallResults
						.map((r) => {
							if (r.error) return `${r.tool}: ERROR — ${r.error}`;
							const resultStr =
								typeof r.result === "string" ? r.result.slice(0, 2000) : JSON.stringify(r.result).slice(0, 2000);
							return `${r.tool}: ${resultStr}`;
						})
						.join("\n\n");

					const followUp = `The user asked: "${body.message}"

You called these tools and got these results:
${resultsText}

Now give a concise, natural language summary of the results for the user. Be specific — mention names, numbers, and key details. No JSON, just a friendly response.`;

					try {
						const summary = await callLlm(
							"You are Oogie, Jake's AI assistant. Summarize tool results in a casual, direct way. Mention specific names, numbers, and details. No JSON, no corporate speak. Sound like a real person chatting. Use keyboard emojis occasionally like ᕕ( ᐛ )ᕗ or (╯°□°)╯ but don't overdo it.",
							followUp,
							1024,
						);
						return c.json({
							response: summary.trim(),
							toolCalls: toolCallResults,
						});
					} catch {
						// If summary fails, return raw response + results
						return c.json({
							response: parsed.response,
							toolCalls: toolCallResults,
						});
					}
				}
			}

			return c.json({
				response: parsed.response,
				toolCalls: toolCallResults,
			});
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			logger.warn("os-chat", `Chat error: ${msg}`);
			return c.json({
				response: `Something went wrong: ${msg}`,
				toolCalls: [],
			});
		}
	});
}
