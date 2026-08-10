import type { Readable } from "node:stream";
import {
	STATIC_IDENTITY_SESSION_START_TIMEOUT_STATUS,
	resolvePromptSubmitTimeoutMs,
	resolveSessionStartTimeoutMs,
} from "@signet/core";
import chalk from "chalk";
import type { Command } from "commander";
import type { DaemonFetchResult } from "../lib/daemon.js";

interface HookDeps {
	readonly AGENTS_DIR: string;
	readonly fetchDaemonResult: <T>(
		path: string,
		opts?: RequestInit & { timeout?: number },
	) => Promise<DaemonFetchResult<T>>;
	readonly readStaticIdentity: (basePath: string, status?: string) => string | null;
}

const SESSION_START_TIMEOUT_MS = resolveSessionStartTimeout();
const PROMPT_SUBMIT_TIMEOUT_MS = resolvePromptSubmitTimeout();
const LEGACY_RUNTIME_PATH = "legacy" as const;
const STDIN_TIMEOUT_MS = 2000;

type HookInput = Readable & {
	readonly isTTY?: boolean;
	unref?: () => void;
};

function legacyHookHeaders(headers?: HeadersInit): Headers {
	const merged = new Headers(headers);
	if (!merged.has("Content-Type")) merged.set("Content-Type", "application/json");
	merged.set("x-signet-runtime-path", LEGACY_RUNTIME_PATH);
	return merged;
}

function readTimeoutEnv(name: string): string {
	const value = process.env[name];
	return typeof value === "string" ? value.trim() : "";
}

export function resolveSessionStartTimeout(): number {
	const raw = readTimeoutEnv("SIGNET_SESSION_START_TIMEOUT") || readTimeoutEnv("SIGNET_FETCH_TIMEOUT");
	return resolveSessionStartTimeoutMs(raw);
}

export function resolvePromptSubmitTimeout(): number {
	return resolvePromptSubmitTimeoutMs(readTimeoutEnv("SIGNET_PROMPT_SUBMIT_TIMEOUT"));
}

type CodexHookEventName = "SessionStart" | "UserPromptSubmit" | "PreToolUse";

export function buildCodexHookOutput(
	hookEventName: CodexHookEventName,
	additionalContext?: string,
): {
	readonly continue: true;
	readonly suppressOutput: true;
	readonly hookSpecificOutput: {
		readonly hookEventName: CodexHookEventName;
		readonly additionalContext?: string;
	};
} {
	const trimmed = additionalContext?.trim();
	return {
		continue: true,
		suppressOutput: true,
		hookSpecificOutput: {
			hookEventName,
			...(trimmed ? { additionalContext: trimmed } : {}),
		},
	};
}

function printCodexHookOutput(hookEventName: CodexHookEventName, additionalContext?: string): void {
	console.log(JSON.stringify(buildCodexHookOutput(hookEventName, additionalContext)));
}

export function buildSessionStartFallback(
	readStaticIdentity: HookDeps["readStaticIdentity"],
	agentsDir: string,
	reason: "offline" | "timeout" | "http" | "invalid-json",
): string | null {
	if (reason === "timeout") {
		return readStaticIdentity(agentsDir, STATIC_IDENTITY_SESSION_START_TIMEOUT_STATUS);
	}
	// offline, http error, invalid-json — all degrade to static identity
	return readStaticIdentity(agentsDir);
}

function formatHookFailure(
	name: string,
	res: {
		readonly reason: "offline" | "timeout" | "http" | "invalid-json";
		readonly status?: number;
	},
): string {
	if (res.reason === "http") {
		return `[signet] daemon ${name} failed with HTTP ${res.status ?? "unknown"}, hook skipped\n`;
	}
	if (res.reason === "invalid-json") {
		return `[signet] daemon ${name} returned invalid JSON, hook skipped\n`;
	}
	if (res.reason === "timeout") {
		return `[signet] daemon ${name} timed out, hook skipped\n`;
	}
	return "[signet] daemon not running, hook skipped\n";
}

async function fetchHookData<T>(
	deps: HookDeps,
	name: string,
	path: string,
	opts?: RequestInit & { timeout?: number },
): Promise<T | null> {
	const res = await deps.fetchDaemonResult<T>(path, {
		...opts,
		headers: legacyHookHeaders(opts?.headers),
	});
	if (res.ok) return res.data;
	process.stderr.write(formatHookFailure(name, res));
	return null;
}

export function registerHookCommands(program: Command, deps: HookDeps): void {
	const hookCmd = program.command("hook").description("Lifecycle hooks for harness integration");

	hookCmd.hook("preAction", () => {
		if (process.env.SIGNET_NO_HOOKS === "1" || process.env.SIGNET_BYPASS === "1") {
			process.exit(0);
		}
	});

	// Hook subcommands read stdin via async iteration in readJson(), which
	// registers a persistent listener on process.stdin. If the harness keeps
	// its end of the stdin pipe open (rather than closing it or killing us),
	// that listener keeps the event loop alive indefinitely — Node never exits
	// on its own. Most action handlers only call process.exit() on error/fallback
	// paths, not on success, so the happy path relied on natural event-loop drain
	// and could hang. Force a clean exit once every action settles so these
	// one-shot IPC processes can never outlive their single request/response.
	hookCmd.hook("postAction", () => {
		process.exit(0);
	});

	hookCmd
		.command("session-start")
		.description("Get context/memories for a new session")
		.requiredOption("-H, --harness <harness>", "Harness name")
		.option("--project <project>", "Project path")
		.option("--agent-id <id>", "Agent ID")
		.option("--context <context>", "Additional context")
		.option("--json", "Output as JSON")
		.option("--codex-json", "Output Codex hook JSON")
		.action(async (options) => {
			const input = await readJson();
			const res = await deps.fetchDaemonResult<{
				identity?: { name: string; description?: string };
				memories?: Array<{ content: string }>;
				stableSystemPrompt?: string;
				dynamicContext?: string;
				inject?: string;
				contextHash?: string;
				contextVersion?: number;
				error?: string;
			}>("/api/hooks/session-start", {
				method: "POST",
				headers: legacyHookHeaders(),
				body: JSON.stringify(buildSessionStartBody(input, options)),
				timeout: SESSION_START_TIMEOUT_MS,
			});
			if (!res.ok) {
				if (res.reason === "http") {
					process.stderr.write(
						`[signet] daemon session-start failed with HTTP ${res.status ?? "unknown"} — using static identity\n`,
					);
				} else if (res.reason === "invalid-json") {
					process.stderr.write("[signet] daemon session-start returned invalid JSON — using static identity\n");
				}
				const fallback = buildSessionStartFallback(deps.readStaticIdentity, deps.AGENTS_DIR, res.reason);
				if (fallback) {
					if (res.reason === "timeout") {
						process.stderr.write("[signet] daemon session-start timed out — using static identity\n");
					}
					if (res.reason === "offline") {
						process.stderr.write("[signet] daemon offline — using static identity\n");
					}
					if (options.codexJson) {
						printCodexHookOutput("SessionStart", fallback);
					} else if (options.json) {
						console.log(JSON.stringify({ inject: fallback, identity: { name: "signet" }, memories: [] }));
					} else {
						console.log(fallback);
					}
					process.exit(0);
				}
				if (res.reason === "timeout") {
					process.stderr.write("[signet] daemon session-start timed out, no identity files found\n");
				}
				if (res.reason === "offline") {
					process.stderr.write("[signet] daemon not running, no identity files found\n");
				}
				if (options.codexJson) printCodexHookOutput("SessionStart");
				process.exit(0);
			}
			const data = res.data;
			if (data.error) {
				console.error(chalk.red(`Error: ${data.error}`));
				process.exit(1);
			}
			const sessionContext = [data.stableSystemPrompt, data.dynamicContext]
				.filter((part): part is string => typeof part === "string" && part.trim().length > 0)
				.join("\n");
			const legacySessionContext = sessionContext || data.inject;
			if (options.codexJson) {
				printCodexHookOutput("SessionStart", legacySessionContext);
			} else if (options.json) {
				console.log(JSON.stringify(data, null, 2));
			} else if (legacySessionContext) {
				console.log(legacySessionContext);
			}
		});

	hookCmd
		.command("user-prompt-submit")
		.description("Get relevant memories for a user prompt")
		.requiredOption("-H, --harness <harness>", "Harness name")
		.option("--project <project>", "Project path")
		.option("--json", "Output as JSON")
		.option("--codex-json", "Output Codex hook JSON")
		.action(async (options) => {
			const input = await readJson();
			const stdinProject = pickString(input?.cwd);
			const data = await fetchHookData<{
				inject?: string;
				dynamicContext?: string;
				contextHash?: string;
				contextVersion?: number;
			}>(deps, "user-prompt-submit", "/api/hooks/user-prompt-submit", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(buildUserPromptSubmitBody(input, options.harness, options.project || stdinProject)),
				timeout: PROMPT_SUBMIT_TIMEOUT_MS,
			});
			if (!data) {
				if (options.codexJson) printCodexHookOutput("UserPromptSubmit");
				process.exit(0);
			}
			const dynamicContext = data.dynamicContext ?? data.inject;
			if (options.codexJson) {
				printCodexHookOutput("UserPromptSubmit", dynamicContext);
			} else if (options.json) {
				console.log(JSON.stringify(data, null, 2));
			} else if (dynamicContext) {
				console.log(dynamicContext);
			}
		});

	hookCmd
		.command("notifications")
		.description("Inject pending cross-agent notifications at a compatible harness hook")
		.requiredOption("-H, --harness <harness>", "Harness name")
		.requiredOption("--hook <hook>", "Native harness hook name")
		.option("--project <project>", "Project path")
		.option("--agent-id <id>", "Agent ID")
		.option("--json", "Output as JSON")
		.option("--hook-json", "Output native hook JSON with additionalContext")
		.option("--codex-json", "Alias for --hook-json")
		.action(async (options) => {
			const input = await readJson();
			const hook = pickString(options.hook);
			const data = await fetchHookData<{ inject?: string }>(deps, "notifications", "/api/hooks/notifications", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					harness: options.harness,
					hook,
					agentId: pickString(options.agentId, input?.signet_agent_id, process.env.SIGNET_AGENT_ID),
					sessionKey: pickSessionKey(input),
					project: pickString(options.project, input?.cwd),
				}),
				timeout: PROMPT_SUBMIT_TIMEOUT_MS,
			});
			if (!data) {
				if ((options.hookJson || options.codexJson) && hook === "PreToolUse") {
					printCodexHookOutput("PreToolUse");
				}
				process.exit(0);
			}
			if (options.hookJson || options.codexJson) {
				if (hook !== "PreToolUse") {
					process.stderr.write(`[signet] native hook JSON is not supported for '${hook}'\n`);
					process.exit(1);
				}
				printCodexHookOutput("PreToolUse", data.inject);
			} else if (options.json) {
				console.log(JSON.stringify(data, null, 2));
			} else if (data.inject) {
				console.log(data.inject);
			}
		});

	hookCmd
		.command("session-end")
		.description("Extract and save memories from session transcript")
		.requiredOption("-H, --harness <harness>", "Harness name")
		.action(async (options) => {
			const body = (await readJson()) ?? {};
			const data = await fetchHookData<{ memoriesSaved?: number }>(deps, "session-end", "/api/hooks/session-end", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(buildSessionEndBody(body, options.harness)),
				timeout: 60_000,
			});
			if (!data) {
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
		.option("--agent-id <id>", "Agent ID")
		.option("--message-count <count>", "Number of messages in session", Number.parseInt)
		.option("--json", "Output as JSON")
		.action(async (options) => {
			const input = await readJson();
			const sessionKey = pickSessionKey(input);
			const sessionContext = pickString(input?.session_context, input?.sessionContext);
			// Forward the transcript path so the daemon can run its skill scan at
			// compaction as a crash-resilient checkpoint (SessionEnd does the same).
			// Re-scanning the same transcript is deduped on (agent_id, harness,
			// session_id, tool_use_id), so the checkpoint can't double-count.
			const transcriptPath = pickString(input?.transcript_path, input?.transcriptPath);
			const nativeAgentId = options.harness === "claude-code" ? pickString(input?.agent_id) : "";
			const agentId = pickString(
				options.agentId,
				input?.signet_agent_id,
				input?.signetAgentId,
				input?.agentId,
				nativeAgentId ? "" : input?.agent_id,
			);
			const data = await fetchHookData<{ summaryPrompt?: string; guidelines?: string; error?: string }>(
				deps,
				"pre-compaction",
				"/api/hooks/pre-compaction",
				{
					method: "POST",
					body: JSON.stringify({
						harness: options.harness,
						messageCount: options.messageCount,
						sessionKey,
						sessionContext,
						transcriptPath,
						...(agentId ? { agentId } : {}),
						runtimePath: LEGACY_RUNTIME_PATH,
					}),
				},
			);
			if (!data) return;
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
			const data = await fetchHookData<{ success?: boolean; memoryId?: number; error?: string }>(
				deps,
				"compaction-complete",
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
			if (!data) return;
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
			const data = await fetchHookData<{
				harness?: string;
				model?: string;
				prompt?: string;
				fileCount?: number;
				error?: string;
			}>(deps, "synthesis", "/api/hooks/synthesis", {
				method: "POST",
				body: JSON.stringify({ trigger: "manual" }),
			});
			if (!data) return;
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
			const data = await fetchHookData<{ success?: boolean; error?: string }>(
				deps,
				"synthesis-complete",
				"/api/hooks/synthesis/complete",
				{
					method: "POST",
					body: JSON.stringify({ content: options.content }),
				},
			);
			if (!data) return;
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

export async function readJson(input: HookInput = process.stdin): Promise<Record<string, unknown> | null> {
	if (input.isTTY) return null;
	const chunks: Buffer[] = [];
	const stdinDone = (async (): Promise<void> => {
		for await (const chunk of input) {
			chunks.push(chunk);
		}
	})();
	try {
		const timedOut = new Promise<never>((_, reject) => {
			const timer = setTimeout(() => reject(new Error("stdin timeout")), STDIN_TIMEOUT_MS);
			timer.unref();
		});
		await Promise.race([stdinDone, timedOut]);
		const rawInput = Buffer.concat(chunks).toString("utf-8").trim();
		if (!rawInput) return null;
		const parsed = JSON.parse(rawInput);
		return toRecord(parsed);
	} catch {
		return null;
	} finally {
		// The stdin iterator survives a timeout unless the stream is explicitly
		// closed. Hook processes are one-shot, so destroy it after consuming the
		// available input and before waiting for the daemon.
		input.pause();
		input.destroy();
		await stdinDone.catch(() => undefined);
		input.removeAllListeners();
		input.unref?.();
	}
}

function toRecord(value: unknown): Record<string, unknown> | null {
	if (typeof value !== "object" || value === null) return null;
	if (Array.isArray(value)) return null;
	return Object.fromEntries(Object.entries(value));
}

function pickString(...values: unknown[]): string {
	for (const value of values) {
		if (typeof value === "string" && value.trim().length > 0) return value;
	}
	return "";
}

function hasParentReference(input: Record<string, unknown> | null): boolean {
	if (!input) return false;
	return Boolean(
		pickString(
			input.parent_session_key,
			input.parentSessionKey,
			input.parent_key,
			input.parentKey,
			input.parent_id,
			input.parentId,
			input.parentID,
		),
	);
}

export function pickSessionKey(input: Record<string, unknown> | null): string {
	if (!input) return "";
	return pickString(input.session_key, input.sessionKey, input.session_id, input.sessionId);
}

export function buildSessionStartBody(
	input: Record<string, unknown> | null,
	options: {
		readonly harness: string;
		readonly project?: string;
		readonly agentId?: string;
		readonly context?: string;
	},
): {
	harness: string;
	project: string;
	agentId?: string;
	harnessAgentId?: string;
	parentSessionKey?: string;
	context?: string;
	source?: string;
	sessionKey: string;
	runtimePath: typeof LEGACY_RUNTIME_PATH;
} {
	const body = input;
	const nativeAgentId = options.harness === "claude-code" || hasParentReference(body) ? pickString(body?.agent_id) : "";
	const signetAgentId = pickString(
		options.agentId,
		body?.signet_agent_id,
		body?.signetAgentId,
		body?.agentId,
		nativeAgentId ? "" : body?.agent_id,
	);
	const harnessAgentId = pickString(body?.harness_agent_id, body?.harnessAgentId, nativeAgentId);
	const parentSessionKey = pickString(
		body?.parent_session_key,
		body?.parentSessionKey,
		body?.parent_key,
		body?.parentKey,
		body?.parentID,
		body?.parentId,
	);
	const source = pickString(body?.source);
	return {
		harness: options.harness,
		project: pickString(options.project, body?.cwd),
		...(signetAgentId ? { agentId: signetAgentId } : {}),
		...(harnessAgentId ? { harnessAgentId } : {}),
		...(parentSessionKey ? { parentSessionKey } : {}),
		...(options.context ? { context: options.context } : {}),
		...(source ? { source } : {}),
		sessionKey: pickSessionKey(body),
		runtimePath: LEGACY_RUNTIME_PATH,
	};
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
	agentId?: string;
	harnessAgentId?: string;
	lastAssistantMessage?: string;
	runtimePath: typeof LEGACY_RUNTIME_PATH;
} {
	const body = input;
	const userPrompt = pickString(body?.prompt, body?.user_prompt, body?.userPrompt);
	const userMessage = pickString(body?.user_message, body?.userMessage, userPrompt);
	const lastAssistantMessage = readLastAssistantMessage(body);
	const nativeAgentId = harness === "claude-code" ? pickString(body?.agent_id) : "";
	const agentId = pickString(
		body?.signet_agent_id,
		body?.signetAgentId,
		body?.agentId,
		nativeAgentId ? "" : body?.agent_id,
	);
	const harnessAgentId = pickString(body?.harness_agent_id, body?.harnessAgentId, nativeAgentId);
	return {
		harness,
		project,
		userMessage,
		userPrompt,
		sessionKey: pickSessionKey(body),
		transcriptPath: pickString(body?.transcript_path, body?.transcriptPath),
		transcript: pickString(body?.transcript),
		...(agentId ? { agentId } : {}),
		...(harnessAgentId ? { harnessAgentId } : {}),
		runtimePath: LEGACY_RUNTIME_PATH,
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
	runtimePath: typeof LEGACY_RUNTIME_PATH;
} {
	const body = input;
	const agentId = pickString(
		overrides.agentId,
		body?.signet_agent_id,
		body?.signetAgentId,
		body?.agentId,
		body?.agent_id,
	);
	const sessionKey = pickString(overrides.sessionKey, pickSessionKey(body));
	const project = pickString(overrides.project, body?.project, body?.cwd);
	return {
		harness,
		summary,
		...(agentId ? { agentId } : {}),
		...(sessionKey ? { sessionKey } : {}),
		...(project ? { project } : {}),
		runtimePath: LEGACY_RUNTIME_PATH,
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
	agentId?: string;
	cwd: string;
	reason: string;
	runtimePath: typeof LEGACY_RUNTIME_PATH;
} {
	const body = input ?? {};
	const sessionKey = pickSessionKey(body);
	const sessionId = pickString(body.session_id, body.sessionId, sessionKey);
	const nativeAgentId = harness === "claude-code" ? pickString(body.agent_id) : "";
	const agentId = pickString(
		body.signet_agent_id,
		body.signetAgentId,
		body.agentId,
		nativeAgentId ? "" : body.agent_id,
	);
	return {
		harness,
		transcriptPath: pickString(body.transcript_path, body.transcriptPath),
		transcript: pickString(body.transcript),
		sessionId,
		sessionKey,
		...(agentId ? { agentId } : {}),
		cwd: pickString(body.cwd),
		reason: pickString(body.reason),
		runtimePath: LEGACY_RUNTIME_PATH,
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
