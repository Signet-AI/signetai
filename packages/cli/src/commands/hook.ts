import chalk from "chalk";
import type { Command } from "commander";

interface HookDeps {
	readonly AGENTS_DIR: string;
	readonly fetchFromDaemon: <T>(path: string, opts?: RequestInit & { timeout?: number }) => Promise<T | null>;
	readonly readStaticIdentity: (basePath: string) => string | null;
}

export function registerHookCommands(program: Command, deps: HookDeps): void {
	const hookCmd = program.command("hook").description("Lifecycle hooks for harness integration");

	hookCmd.hook("preAction", () => {
		if (process.env.SIGNET_NO_HOOKS === "1" || process.env.SIGNET_BYPASS === "1") {
			process.exit(0);
		}
	});

	hookCmd
		.command("session-start")
		.description("Get context/memories for a new session")
		.requiredOption("-H, --harness <harness>", "Harness name")
		.option("--project <project>", "Project path")
		.option("--agent-id <id>", "Agent ID")
		.option("--context <context>", "Additional context")
		.option("--json", "Output as JSON")
		.action(async (options) => {
			const input = await readJson();
			const sessionKey = pickSessionKey(input);
			const stdinProject = pickString(input?.cwd);
			const data = await deps.fetchFromDaemon<{
				identity?: { name: string; description?: string };
				memories?: Array<{ content: string }>;
				inject?: string;
				error?: string;
			}>("/api/hooks/session-start", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					harness: options.harness,
					project: options.project || stdinProject,
					agentId: options.agentId,
					context: options.context,
					sessionKey,
				}),
			});
			if (!data) {
				const fallback = deps.readStaticIdentity(deps.AGENTS_DIR);
				if (fallback) {
					process.stderr.write("[signet] daemon offline — using static identity\n");
					if (options.json) {
						console.log(JSON.stringify({ inject: fallback, identity: { name: "signet" }, memories: [] }));
					} else {
						console.log(fallback);
					}
				} else {
					process.stderr.write("[signet] daemon not running, no identity files found\n");
				}
				process.exit(0);
			}
			if (data.error) {
				console.error(chalk.red(`Error: ${data.error}`));
				process.exit(1);
			}
			if (options.json) {
				console.log(JSON.stringify(data, null, 2));
			} else if (data.inject) {
				console.log(data.inject);
			}
		});

	hookCmd
		.command("user-prompt-submit")
		.description("Get relevant memories for a user prompt")
		.requiredOption("-H, --harness <harness>", "Harness name")
		.option("--project <project>", "Project path")
		.action(async (options) => {
			const input = await readJson();
			const stdinProject = pickString(input?.cwd);
			const data = await deps.fetchFromDaemon<{ inject?: string }>("/api/hooks/user-prompt-submit", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(buildUserPromptSubmitBody(input, options.harness, options.project || stdinProject)),
			});
			if (!data) {
				process.stderr.write("[signet] daemon not running, hook skipped\n");
				process.exit(0);
			}
			if (data.inject) console.log(data.inject);
		});

	hookCmd
		.command("session-end")
		.description("Extract and save memories from session transcript")
		.requiredOption("-H, --harness <harness>", "Harness name")
		.action(async (options) => {
			const body = (await readJson()) ?? {};
			const data = await deps.fetchFromDaemon<{ memoriesSaved?: number }>("/api/hooks/session-end", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(buildSessionEndBody(body, options.harness)),
				timeout: 60_000,
			});
			if (!data) {
				process.stderr.write("[signet] daemon not running, hook skipped\n");
				process.exit(0);
			}
			if ((data.memoriesSaved ?? 0) > 0) {
				process.stderr.write(`[signet] ${data.memoriesSaved} memories saved\n`);
			}
		});

	hookCmd
		.command("pre-compaction")
		.description("Get summary instructions before session compaction")
		.requiredOption("-H, --harness <harness>", "Harness name")
		.option("--project <project>", "Project path")
		.option("--message-count <count>", "Number of messages in session", Number.parseInt)
		.option("--json", "Output as JSON")
		.action(async (options) => {
			const input = await readJson();
			const sessionKey = pickSessionKey(input);
			const sessionContext = pickString(input?.session_context, input?.sessionContext);
			const data = await deps.fetchFromDaemon<{ summaryPrompt?: string; guidelines?: string; error?: string }>(
				"/api/hooks/pre-compaction",
				{
					method: "POST",
					body: JSON.stringify({
						harness: options.harness,
						messageCount: options.messageCount,
						sessionKey,
						sessionContext,
					}),
				},
			);
			if (data?.error) {
				console.error(chalk.red(`Error: ${data.error}`));
				process.exit(1);
			}
			if (options.json) {
				console.log(JSON.stringify(data, null, 2));
			} else if (data?.summaryPrompt) {
				console.log(data.summaryPrompt);
			}
		});

	hookCmd
		.command("compaction-complete")
		.description("Save session summary after compaction")
		.requiredOption("-H, --harness <harness>", "Harness name")
		.requiredOption("-s, --summary <summary>", "Session summary text")
		.option("--session-key <key>", "Session key")
		.option("--project <project>", "Project path")
		.option("--agent-id <id>", "Agent ID")
		.action(async (options) => {
			const input = shouldReadCompactionInput(process.stdin.isTTY, options) ? await readJson() : null;
			const data = await deps.fetchFromDaemon<{ success?: boolean; memoryId?: number; error?: string }>(
				"/api/hooks/compaction-complete",
				{
					method: "POST",
					body: JSON.stringify(
						buildCompactionCompleteBody(input, options.harness, options.summary, {
							agentId: options.agentId,
							project: options.project,
							sessionKey: options.sessionKey,
						}),
					),
				},
			);
			if (data?.error) {
				console.error(chalk.red(`Error: ${data.error}`));
				process.exit(1);
			}
			if (data?.success) {
				console.log(chalk.green("✓ Summary saved"));
				if (typeof data.memoryId === "number") console.log(chalk.dim(`  Memory ID: ${data.memoryId}`));
			}
		});

	hookCmd
		.command("synthesis")
		.description("Request MEMORY.md synthesis (returns prompt for configured harness)")
		.option("--json", "Output as JSON")
		.action(async (options) => {
			const data = await deps.fetchFromDaemon<{
				harness?: string;
				model?: string;
				prompt?: string;
				fileCount?: number;
				error?: string;
			}>("/api/hooks/synthesis", {
				method: "POST",
				body: JSON.stringify({ trigger: "manual" }),
			});
			if (data?.error) {
				console.error(chalk.red(`Error: ${data.error}`));
				process.exit(1);
			}
			if (options.json) {
				console.log(JSON.stringify(data, null, 2));
				return;
			}
			console.log(chalk.bold("MEMORY.md Synthesis Request\n"));
			console.log(chalk.dim(`Harness: ${data?.harness}`));
			console.log(chalk.dim(`Model: ${data?.model}`));
			console.log(chalk.dim(`Session files: ${data?.fileCount ?? 0}\n`));
			if (data?.prompt) console.log(data.prompt);
		});

	hookCmd
		.command("synthesis-complete")
		.description("Save synthesized MEMORY.md content")
		.requiredOption("-c, --content <content>", "Synthesized MEMORY.md content")
		.action(async (options) => {
			const data = await deps.fetchFromDaemon<{ success?: boolean; error?: string }>("/api/hooks/synthesis/complete", {
				method: "POST",
				body: JSON.stringify({ content: options.content }),
			});
			if (data?.error) {
				console.error(chalk.red(`Error: ${data.error}`));
				process.exit(1);
			}
			if (data?.success) console.log(chalk.green("✓ MEMORY.md synthesized"));
		});
}

export function shouldReadCompactionInput(
	isTTY: boolean,
	options: {
		sessionKey?: string;
		project?: string;
		agentId?: string;
	},
): boolean {
	if (isTTY) return false;
	if (options.sessionKey && options.project && options.agentId) return false;
	return true;
}

async function readJson(): Promise<Record<string, unknown> | null> {
	try {
		const chunks: Buffer[] = [];
		for await (const chunk of process.stdin) {
			chunks.push(chunk);
		}
		const input = Buffer.concat(chunks).toString("utf-8").trim();
		if (!input) return null;
		const parsed = JSON.parse(input);
		return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

function pickString(...values: unknown[]): string {
	for (const value of values) {
		if (typeof value === "string" && value.trim().length > 0) return value;
	}
	return "";
}

export function pickSessionKey(input: Record<string, unknown> | null): string {
	if (!input) return "";
	return pickString(input.session_key, input.sessionKey, input.session_id, input.sessionId);
}

export function buildUserPromptSubmitBody(
	input: Record<string, unknown> | null,
	harness: string,
	project: string,
): {
	harness: string;
	project: string;
	userMessage: string;
	userPrompt: string;
	sessionKey: string;
	transcriptPath: string;
	transcript: string;
	lastAssistantMessage?: string;
} {
	const body = input;
	const userPrompt = pickString(body?.prompt, body?.user_prompt, body?.userPrompt);
	const userMessage = pickString(body?.user_message, body?.userMessage, userPrompt);
	const lastAssistantMessage = readLastAssistantMessage(body);
	return {
		harness,
		project,
		userMessage,
		userPrompt,
		sessionKey: pickSessionKey(body),
		transcriptPath: pickString(body?.transcript_path, body?.transcriptPath),
		transcript: pickString(body?.transcript),
		...(lastAssistantMessage ? { lastAssistantMessage } : {}),
	};
}

export function buildCompactionCompleteBody(
	input: Record<string, unknown> | null,
	harness: string,
	summary: string,
	overrides: {
		agentId?: string;
		project?: string;
		sessionKey?: string;
	} = {},
): {
	harness: string;
	summary: string;
	agentId?: string;
	sessionKey?: string;
	project?: string;
} {
	const body = input;
	const agentId = pickString(overrides.agentId, body?.agent_id, body?.agentId);
	const sessionKey = pickString(overrides.sessionKey, pickSessionKey(body));
	const project = pickString(overrides.project, body?.project, body?.cwd);
	return {
		harness,
		summary,
		...(agentId ? { agentId } : {}),
		...(sessionKey ? { sessionKey } : {}),
		...(project ? { project } : {}),
	};
}

export function buildSessionEndBody(
	input: Record<string, unknown> | null,
	harness: string,
): {
	harness: string;
	transcriptPath: string;
	transcript: string;
	sessionId: string;
	sessionKey: string;
	cwd: string;
	reason: string;
} {
	const body = input ?? {};
	const sessionKey = pickSessionKey(body);
	const sessionId = pickString(body.session_id, body.sessionId, sessionKey);
	return {
		harness,
		transcriptPath: pickString(body.transcript_path, body.transcriptPath),
		transcript: pickString(body.transcript),
		sessionId,
		sessionKey,
		cwd: pickString(body.cwd),
		reason: pickString(body.reason),
	};
}

function readLastAssistantMessage(input: Record<string, unknown> | null): string {
	if (!input) return "";
	const direct = pickString(
		input.last_assistant_message,
		input.lastAssistantMessage,
		input.assistant_message,
		input.assistantMessage,
		input.previous_assistant_message,
		input.previousAssistantMessage,
	);
	if (direct) return direct;
	const messages = input.messages;
	if (!Array.isArray(messages)) return "";
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (typeof msg !== "object" || msg === null) continue;
		const record = msg as Record<string, unknown>;
		const role = typeof record.role === "string" ? record.role.toLowerCase() : "";
		const sender = typeof record.sender === "string" ? record.sender.toLowerCase() : "";
		const isAssistant =
			role === "assistant" || role === "agent" || role === "model" || sender === "assistant" || sender === "agent";
		if (!isAssistant) continue;
		const content = pickString(record.content, record.text, record.message);
		if (content) return content;
	}
	return "";
}
