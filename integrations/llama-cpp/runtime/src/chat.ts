/**
 * Interactive chat loop that bridges llama-server with Signet tools.
 *
 * Renders streaming tokens like llama-cli, with a pulsating signet
 * spinner during tool execution. No raw JSON dumps to the user.
 */

import * as readline from "node:readline";
import { type SessionContext, onSessionEnd, onSessionStart, onUserPromptSubmit } from "./hooks.js";
import { type OpenAiTool, executeSignetTool, fetchSignetTools } from "./signet-tools.js";

interface ChatConfig {
	llamaServerUrl: string;
	daemonUrl: string;
	systemPrompt: string;
	model?: string;
	contextLength: number;
	maxRounds: number;
}

interface ChatMessage {
	role: "system" | "user" | "assistant" | "tool";
	content: string | null;
	tool_calls?: Array<{
		id: string;
		type: "function";
		function: {
			name: string;
			arguments: string;
		};
	}>;
	tool_call_id?: string;
}

interface StreamDelta {
	role?: string;
	content?: string | null;
	tool_calls?: Array<{
		index?: number;
		id?: string;
		type?: "function";
		function?: {
			name?: string;
			arguments?: string;
		};
	}>;
}

interface StreamChunk {
	choices: Array<{
		delta: StreamDelta;
		finish_reason: string | null;
	}>;
}

const SIGNET_FRAMES = ["◈", "◇", "◆", "◇"];
const SPINNER_MS = 180;

export async function runChat(config: ChatConfig): Promise<void> {
	const sessionKey = `llama-cpp-${Date.now()}`;
	const ctx: SessionContext = {
		sessionKey,
		daemonUrl: config.daemonUrl,
		transcript: [],
	};

	const injectedContext = await onSessionStart(ctx);
	const systemContent = buildSystemPrompt(config.systemPrompt, injectedContext);
	const messages: ChatMessage[] = [{ role: "system", content: systemContent }];

	let tools: OpenAiTool[] = [];
	try {
		tools = await fetchSignetTools(config.daemonUrl);
	} catch {
		// Will use empty tools array
	}

	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout,
	});

	rl.on("close", () => {
		process.exit(0);
	});

	writeDim("\n  ◈ signet + llama.cpp\n");
	writeDim(`  ${tools.length} tools loaded  ·  /help for commands\n\n`);

	const prompt = () => {
		rl.question("You> ", async (input) => {
			const trimmed = input.trim();
			if (!trimmed) {
				prompt();
				return;
			}

			if (trimmed === "/quit" || trimmed === "/exit") {
				await shutdown();
				return;
			}
			if (trimmed === "/tools") {
				for (const t of tools) {
					writeDim(`  ${t.function.name} — ${t.function.description.split(".")[0]}\n`);
				}
				process.stdout.write("\n");
				prompt();
				return;
			}
			if (trimmed === "/clear") {
				messages.length = 0;
				messages.push({ role: "system", content: systemContent });
				writeDim("  [cleared]\n\n");
				prompt();
				return;
			}
			if (trimmed === "/help") {
				writeDim("  /quit   — End session\n");
				writeDim("  /tools  — List Signet tools\n");
				writeDim("  /clear  — Clear history\n");
				writeDim("  /help   — This message\n\n");
				prompt();
				return;
			}

			const recallContext = await onUserPromptSubmit(ctx, trimmed);
			if (recallContext) {
				messages.push({
					role: "system",
					content: `[Relevant memories recalled from past sessions]\n${recallContext}`,
				});
			}

			messages.push({ role: "user", content: trimmed });
			ctx.transcript.push({ role: "user", content: trimmed });

			try {
				await processTurn(messages, tools, config, ctx);
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				writeDim(`\n  [error] ${msg}\n\n`);
			}

			prompt();
		});
	};

	const shutdown = async () => {
		process.stdout.write("\n");
		await onSessionEnd(ctx);
		rl.close();
		process.exit(0);
	};

	process.on("SIGINT", async () => {
		await shutdown();
	});
	process.on("SIGTERM", async () => {
		await shutdown();
	});

	prompt();
}

async function processTurn(
	messages: ChatMessage[],
	tools: OpenAiTool[],
	config: ChatConfig,
	ctx: SessionContext,
): Promise<void> {
	for (let round = 0; round < config.maxRounds; round++) {
		const result = await streamCompletion(messages, tools, config);
		if (!result) {
			writeDim("  [no response]\n\n");
			return;
		}

		if (result.tool_calls && result.tool_calls.length > 0) {
			const assistantMsg: ChatMessage = {
				role: "assistant",
				content: result.content || null,
				tool_calls: result.tool_calls,
			};
			messages.push(assistantMsg);

			for (const toolCall of result.tool_calls) {
				const toolName = toolCall.function.name;
				const toolArgs = parseToolArguments(toolCall.function.arguments || "{}");

				const spinner = startSpinner(toolName, toolArgs);

				const rawResult = await executeSignetTool(config.daemonUrl, toolName, toolArgs);
				stopSpinner(spinner);

				const truncatedResult = rawResult.length > 1500 ? `${rawResult.slice(0, 1500)}\n[truncated]` : rawResult;

				messages.push({
					role: "tool",
					content: truncatedResult,
					tool_call_id: toolCall.id,
				});
			}

			continue;
		}

		messages.push({ role: "assistant", content: result.content || null });

		if (result.content) {
			ctx.transcript.push({ role: "assistant", content: result.content });
		}

		process.stdout.write("\n\n");
		return;
	}

	writeDim("  [max tool rounds reached]\n\n");
}

async function streamCompletion(
	messages: ChatMessage[],
	tools: OpenAiTool[],
	config: ChatConfig,
): Promise<{
	content: string | null;
	tool_calls?: Array<{
		id: string;
		type: "function";
		function: { name: string; arguments: string };
	}>;
} | null> {
	const body: Record<string, unknown> = {
		messages: messages.map((m) => {
			const msg: Record<string, unknown> = { role: m.role, content: m.content };
			if (m.tool_calls) msg.tool_calls = m.tool_calls;
			if (m.tool_call_id) msg.tool_call_id = m.tool_call_id;
			return msg;
		}),
		stream: true,
		max_tokens: 2048,
		temperature: 0.7,
	};

	if (tools.length > 0) {
		body.tools = tools;
		body.tool_choice = "auto";
	}

	if (config.model) {
		body.model = config.model;
	}

	let res: Response;
	try {
		res = await fetch(`${config.llamaServerUrl}/v1/chat/completions`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(120_000),
		});
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		writeDim(`  [connection error: ${msg}]\n`);
		return null;
	}

	if (!res.ok) {
		const text = await res.text().catch(() => "");
		writeDim(`  [llama-server error ${res.status}: ${text.slice(0, 200)}]\n`);
		return null;
	}

	let content = "";
	const toolCallMap = new Map<number, { id: string; name: string; arguments: string }>();
	let inContent = false;

	const reader = res.body?.getReader();
	if (!reader) return null;

	const decoder = new TextDecoder();
	let buffer = "";

	while (true) {
		const { done, value } = await reader.read();
		if (done) break;

		buffer += decoder.decode(value, { stream: true });
		const lines = buffer.split("\n");
		buffer = lines.pop() || "";

		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed || !trimmed.startsWith("data: ")) continue;

			const data = trimmed.slice(6);
			if (data === "[DONE]") continue;

			let chunk: StreamChunk;
			try {
				chunk = JSON.parse(data) as StreamChunk;
			} catch {
				continue;
			}

			const delta = chunk.choices?.[0]?.delta;
			if (!delta) continue;

			if (delta.content) {
				if (!inContent) {
					process.stdout.write("\n");
					inContent = true;
				}
				process.stdout.write(delta.content);
				content += delta.content;
			}

			if (delta.tool_calls) {
				for (const tc of delta.tool_calls) {
					const idx = tc.index ?? 0;
					if (!toolCallMap.has(idx) && tc.id) {
						toolCallMap.set(idx, {
							id: tc.id,
							name: tc.function?.name || "",
							arguments: tc.function?.arguments || "",
						});
					} else if (toolCallMap.has(idx)) {
						const existing = toolCallMap.get(idx);
						if (!existing) continue;
						if (tc.function?.name) existing.name += tc.function.name;
						if (tc.function?.arguments) existing.arguments += tc.function.arguments;
					}
				}
			}
		}
	}

	if (content) process.stdout.write("\n");

	const tool_calls =
		toolCallMap.size > 0
			? Array.from(toolCallMap.entries()).map(([_, tc]) => ({
					id: tc.id,
					type: "function" as const,
					function: { name: tc.name, arguments: tc.arguments },
				}))
			: undefined;

	return {
		content: content || null,
		tool_calls,
	};
}

function startSpinner(toolName: string, args: Record<string, unknown>): NodeJS.Timeout {
	const label = `${toolName}(${summarizeArgs(args)})`;
	let frame = 0;

	process.stdout.write(`  ${SIGNET_FRAMES[0]} ${label}`);
	const pos = `  ${SIGNET_FRAMES[0]} ${label}`.length;

	const interval = setInterval(() => {
		frame = (frame + 1) % SIGNET_FRAMES.length;
		process.stdout.write(`\r${" ".repeat(pos)}\r`);
		process.stdout.write(`  ${SIGNET_FRAMES[frame]} ${label}`);
	}, SPINNER_MS);

	return interval;
}

function stopSpinner(interval: NodeJS.Timeout): void {
	clearInterval(interval);
	process.stdout.write(`\r${" ".repeat(60)}\r`);
	writeDim("  ◈ done\n");
}

function writeDim(text: string): void {
	process.stdout.write(`\x1b[2m${text}\x1b[0m`);
}

function buildSystemPrompt(basePrompt: string, injectedContext: string | null): string {
	const parts: string[] = [];

	if (basePrompt) {
		const truncated = basePrompt.length > 3000 ? `${basePrompt.slice(0, 3000)}\n[... truncated]` : basePrompt;
		parts.push(truncated);
	}

	if (injectedContext) {
		parts.push(`\n## Session Context\n\n${injectedContext}`);
	}

	if (parts.length === 0) {
		parts.push("You are a helpful AI assistant with access to persistent memory tools through Signet.");
	}

	return parts.join("\n\n");
}

function summarizeArgs(args: Record<string, unknown>): string {
	const entries = Object.entries(args);
	if (entries.length === 0) return "";
	const parts = entries.map(([k, v]) => {
		const val = typeof v === "string" ? (v.length > 30 ? `${v.slice(0, 30)}...` : v) : JSON.stringify(v);
		return `${k}=${val}`;
	});
	return parts.join(", ");
}

function parseToolArguments(raw: string): Record<string, unknown> {
	if (!raw || typeof raw !== "string") return {};

	const trimmed = raw.trim();

	try {
		return JSON.parse(trimmed);
	} catch {
		const firstBrace = trimmed.indexOf("{");
		if (firstBrace === -1) return {};

		let depth = 0;
		for (let i = firstBrace; i < trimmed.length; i++) {
			if (trimmed[i] === "{") depth++;
			else if (trimmed[i] === "}") depth--;
			if (depth === 0) {
				try {
					return JSON.parse(trimmed.slice(firstBrace, i + 1));
				} catch {
					return {};
				}
			}
		}
		return {};
	}
}
