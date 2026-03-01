/**
 * Signet extension for pi-coding-agent.
 *
 * Integrates Signet's memory pipeline into pi-mono's conversation loop
 * by firing daemon hooks on lifecycle events and injecting memories
 * into LLM context.
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type {
	ExtensionContext,
	ExtensionFactory,
	ExtensionUIContext,
} from "@mariozechner/pi-coding-agent";
import { DaemonClient } from "../daemon/client.js";
import type {
	LogEntry,
	SessionStartResponse,
	UserPromptSubmitResponse,
} from "../daemon/types.js";
import { EventBuffer } from "../viz/event-buffer.js";
import { formatEvents, formatStatusLine } from "../viz/formatters.js";
import type { PipelineEvent, VisualizationMode } from "../viz/types.js";

export interface SignetExtensionOptions {
	readonly host?: string;
	readonly port?: number;
	readonly vizMode?: VisualizationMode;
	/** Enable SSE log streaming for pipeline observability */
	readonly streamLogs?: boolean;
}

export function createSignetExtension(
	options: SignetExtensionOptions = {},
): ExtensionFactory {
	return (pi) => {
		const client = new DaemonClient({
			host: options.host,
			port: options.port,
		});
		const eventBuffer = new EventBuffer(200);

		let sessionKey: string | undefined;
		let currentInject = "";
		let pendingPromptInject = "";
		let vizMode: VisualizationMode = options.vizMode ?? "inline";
		let stopLogStream: (() => void) | undefined;

		// Store UI context reference from the first event handler
		let ui: ExtensionUIContext | undefined;

		// Track conversation messages for session-end transcript
		const conversationMessages: string[] = [];

		// =====================================================================
		// Visualization
		// =====================================================================

		function updateWidget(): void {
			if (!ui) return;

			if (vizMode === "hidden") {
				ui.setWidget("signet-pipeline", undefined);
				return;
			}

			if (vizMode === "inline") {
				const recent = eventBuffer.getRecent(15);
				const lines = formatEvents(recent);
				ui.setWidget("signet-pipeline", lines, {
					placement: "belowEditor",
				});
			}
			// split mode is handled via custom overlay
		}

		eventBuffer.onEvent(() => {
			if (!ui) return;
			updateWidget();
			const all = eventBuffer.getAll();
			ui.setStatus("signet", formatStatusLine(all, vizMode));
		});

		// =====================================================================
		// SSE Log Stream → Pipeline Events
		// =====================================================================

		function startLogStream(): void {
			if (stopLogStream) return;

			stopLogStream = client.streamLogs(
				(entry: LogEntry) => {
					const event = normalizeLogEntry(entry);
					if (event) eventBuffer.push(event);
				},
				(err: Error) => {
					ui?.notify(
						`signet log stream error: ${err.message}`,
						"warning",
					);
				},
			);
		}

		function normalizeLogEntry(entry: LogEntry): PipelineEvent | undefined {
			const now = Date.now();
			const cat = entry.category;
			const data = (entry.data ?? {}) as Record<string, unknown>;
			const msg = entry.message;

			if (cat === "hooks") {
				const name = (data.hookName as string | undefined) ?? msg;
				return {
					kind: "hook",
					name,
					durationMs: (data.durationMs as number) ?? 0,
					memoryCount: (data.memoryCount as number) ?? 0,
					injectChars: (data.injectChars as number) ?? 0,
					sessionKey: data.sessionKey as string | undefined,
					timestamp: now,
				};
			}

			if (cat === "pipeline") {
				if (msg.includes("extraction") || msg.includes("extract")) {
					return {
						kind: "extraction",
						facts: (data.facts as number) ?? 0,
						entities: (data.entities as number) ?? 0,
						durationMs: (data.durationMs as number) ?? 0,
						jobId: data.jobId as string | undefined,
						timestamp: now,
					};
				}
				if (msg.includes("decision") || msg.includes("proposal")) {
					return {
						kind: "decision",
						action:
							(data.action as
								| "add"
								| "update"
								| "skip"
								| "delete") ?? "skip",
						confidence: (data.confidence as number) ?? 0,
						content: (data.content as string) ?? "",
						memoryId: data.memoryId as string | undefined,
						timestamp: now,
					};
				}
			}

			if (cat === "memory" && msg.includes("saved")) {
				return {
					kind: "memory_write",
					id: (data.id as string) ?? "",
					content: (data.content as string) ?? "",
					type: (data.type as string) ?? "fact",
					timestamp: now,
				};
			}

			if (cat === "session-memories") {
				return {
					kind: "injection_candidates",
					total: (data.total as number) ?? 0,
					injected: (data.injected as number) ?? 0,
					sessionKey: data.sessionKey as string | undefined,
					timestamp: now,
				};
			}

			return undefined;
		}

		// =====================================================================
		// Session Lifecycle
		// =====================================================================

		pi.on("session_start", async (_event, ctx) => {
			ui = ctx.ui;

			const id = crypto.randomUUID();
			sessionKey = `harness-${id}`;

			const healthy = await client.health();
			if (!healthy) {
				ctx.ui.notify(
					"signet daemon not reachable at localhost:3850",
					"warning",
				);
				return;
			}

			try {
				const result: SessionStartResponse =
					await client.sessionStart({
						harness: "signet-harness",
						sessionKey,
						project: process.cwd(),
						runtimePath: "plugin",
					});

				currentInject = result.inject;

				eventBuffer.push({
					kind: "hook",
					name: "session-start",
					durationMs: 0,
					memoryCount: result.memories.length,
					injectChars: result.inject.length,
					sessionKey,
					timestamp: Date.now(),
				});

				eventBuffer.push({
					kind: "session_claim",
					sessionKey,
					runtimePath: "plugin",
					harness: "signet-harness",
					timestamp: Date.now(),
				});

				if (result.memories.length > 0) {
					eventBuffer.push({
						kind: "injection_candidates",
						total: result.memories.length,
						injected: result.memories.length,
						sessionKey,
						timestamp: Date.now(),
					});
				}
			} catch (err) {
				ctx.ui.notify(
					`signet session-start failed: ${err instanceof Error ? err.message : String(err)}`,
					"error",
				);
			}

			if (options.streamLogs !== false) {
				startLogStream();
			}
		});

		// =====================================================================
		// Context Injection
		// =====================================================================

		pi.on("context", (event) => {
			if (!currentInject && !pendingPromptInject) return;

			const inject = [currentInject, pendingPromptInject]
				.filter(Boolean)
				.join("\n\n");
			pendingPromptInject = "";

			if (!inject) return;

			// Prepend as a synthetic user message with system-reminder tags
			const systemMessage: AgentMessage = {
				role: "user",
				content: [
					{
						type: "text",
						text: `<system-reminder>\n${inject}\n</system-reminder>`,
					},
				],
				timestamp: Date.now(),
			};

			return { messages: [systemMessage, ...event.messages] };
		});

		// =====================================================================
		// User Prompt Submit
		// =====================================================================

		pi.on("input", async (event) => {
			if (!sessionKey) return { action: "continue" as const };

			conversationMessages.push(`User: ${event.text}`);

			try {
				const result: UserPromptSubmitResponse =
					await client.userPromptSubmit({
						harness: "signet-harness",
						sessionKey,
						project: process.cwd(),
						userPrompt: event.text,
						runtimePath: "plugin",
					});

				if (result.inject) {
					pendingPromptInject = result.inject;
				}

				eventBuffer.push({
					kind: "hook",
					name: "user-prompt-submit",
					durationMs: 0,
					memoryCount: result.memoryCount,
					injectChars: result.inject.length,
					sessionKey,
					timestamp: Date.now(),
				});
			} catch {
				// non-fatal
			}

			return { action: "continue" as const };
		});

		// =====================================================================
		// Track assistant responses for transcript
		// =====================================================================

		pi.on("message_end", (event) => {
			if (event.message.role === "assistant") {
				const content = event.message.content;
				let text = "";
				if (typeof content === "string") {
					text = content;
				} else if (Array.isArray(content)) {
					text = content
						.filter(
							(c): c is { type: "text"; text: string } =>
								"type" in c && c.type === "text",
						)
						.map((c) => c.text)
						.join("");
				}
				if (text) {
					conversationMessages.push(`Assistant: ${text}`);
				}
			}
		});

		// =====================================================================
		// Session Shutdown
		// =====================================================================

		pi.on("session_shutdown", async () => {
			if (!sessionKey) return;

			const transcript = conversationMessages.join("\n\n");

			if (transcript.length >= 500) {
				try {
					await client.sessionEnd({
						harness: "signet-harness",
						sessionKey,
						cwd: process.cwd(),
						runtimePath: "plugin",
					});

					eventBuffer.push({
						kind: "hook",
						name: "session-end",
						durationMs: 0,
						memoryCount: 0,
						injectChars: 0,
						sessionKey,
						timestamp: Date.now(),
					});
				} catch {
					// best-effort on shutdown
				}
			}

			if (stopLogStream) {
				stopLogStream();
				stopLogStream = undefined;
			}
		});

		// =====================================================================
		// Slash Commands
		// =====================================================================

		pi.registerCommand("vizmode", {
			description:
				"Toggle pipeline visualization: /vizmode [inline|hidden|split]",
			handler: async (args: string, ctx: ExtensionContext) => {
				ui = ctx.ui;
				const mode = args.trim().toLowerCase();
				if (
					mode === "inline" ||
					mode === "hidden" ||
					mode === "split"
				) {
					vizMode = mode;
					updateWidget();
					ctx.ui.notify(`pipeline visualization: ${mode}`, "info");
				} else {
					const current = vizMode;
					if (current === "inline") vizMode = "split";
					else if (current === "split") vizMode = "hidden";
					else vizMode = "inline";
					updateWidget();
					ctx.ui.notify(
						`pipeline visualization: ${vizMode}`,
						"info",
					);
				}
			},
		});

		pi.registerCommand("remember", {
			description: "Save a memory: /remember <content>",
			handler: async (args: string, ctx: ExtensionContext) => {
				if (!sessionKey || !args.trim()) return;
				try {
					const result = await client.remember({
						harness: "signet-harness",
						sessionKey,
						content: args.trim(),
						runtimePath: "plugin",
					});
					if (result.saved) {
						ctx.ui.notify(
							`memory saved: ${result.id.slice(0, 8)}`,
							"info",
						);
						eventBuffer.push({
							kind: "memory_write",
							id: result.id,
							content: args.trim(),
							type: "explicit",
							timestamp: Date.now(),
						});
					}
				} catch (err) {
					ctx.ui.notify(
						`remember failed: ${err instanceof Error ? err.message : String(err)}`,
						"error",
					);
				}
			},
		});

		pi.registerCommand("recall", {
			description: "Search memories: /recall <query>",
			handler: async (args: string, ctx: ExtensionContext) => {
				if (!sessionKey || !args.trim()) return;
				try {
					const result = await client.recall({
						harness: "signet-harness",
						sessionKey,
						query: args.trim(),
						runtimePath: "plugin",
					});
					if (result.count > 0) {
						const lines = result.results.map(
							(r) => `- [${r.type}] ${r.content}`,
						);
						ctx.ui.notify(
							`${result.count} memories found`,
							"info",
						);
						pendingPromptInject = lines.join("\n");
					} else {
						ctx.ui.notify("no memories found", "info");
					}
				} catch (err) {
					ctx.ui.notify(
						`recall failed: ${err instanceof Error ? err.message : String(err)}`,
						"error",
					);
				}
			},
		});

		// Initial widget
		updateWidget();
	};
}
