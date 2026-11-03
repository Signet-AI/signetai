import { open as openFile } from "node:fs/promises";
import { hostname as osHostname } from "node:os";
import { isAbsolute, resolve as resolvePath } from "node:path";
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
	readonly sleep?: (ms: number) => Promise<void>;
	readonly now?: () => number;
	readonly stdin?: Readable;
}

const WAKE_POLL_MS = 25_000;
const WAKE_REQUEST_GRACE_MS = 10_000;
const WAKE_NO_WAIT_TIMEOUT_MS = 4_000;
const WAKE_DEFAULT_BACKOFF_MS = 15_000;
const WAKE_DEFAULT_MAX_WAIT_SECONDS = 3300;
const WAKE_MAX_WAIT_SECONDS = 86_400;

interface WakeResponse {
	readonly wake?: boolean;
	readonly inject?: string;
	readonly reason?: string;
	readonly retryAfterMs?: number;
}

export type WakeOutcome = { readonly kind: "wake"; readonly inject: string } | { readonly kind: "none" };

export function parseWakeMaxWaitSeconds(raw: unknown): number {
	const parsed = typeof raw === "number" ? raw : Number.parseInt(String(raw ?? ""), 10);
	if (!Number.isFinite(parsed)) return WAKE_DEFAULT_MAX_WAIT_SECONDS;
	return Math.min(WAKE_MAX_WAIT_SECONDS, Math.max(1, Math.floor(parsed)));
}

export async function runWakeLoop(
	deps: Pick<HookDeps, "fetchDaemonResult" | "sleep" | "now">,
	request: {
		readonly harness: string;
		readonly sessionKey: string;
		readonly agentId: string;
		readonly project: string;
		readonly context?: PeerContext;
		readonly noWait: boolean;
		readonly maxWaitSeconds: number;
	},
): Promise<WakeOutcome> {
	const now = deps.now ?? Date.now;
	const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const deadline = now() + request.maxWaitSeconds * 1000;
	for (;;) {
		const waitMs = request.noWait ? 0 : WAKE_POLL_MS;
		const res = await deps.fetchDaemonResult<WakeResponse>("/api/cross-agent/wake", {
			method: "POST",
			headers: legacyHookHeaders(),
			body: JSON.stringify({
				harness: request.harness,
				sessionKey: request.sessionKey,
				...(request.agentId ? { agentId: request.agentId } : {}),
				...(request.project ? { project: request.project } : {}),
				...(request.context ? { context: request.context } : {}),
				waitMs,
			}),
			timeout: request.noWait ? WAKE_NO_WAIT_TIMEOUT_MS : waitMs + WAKE_REQUEST_GRACE_MS,
		});
		let backoffMs: number | null = null;
		if (res.ok) {
			const data = res.data;
			if (data?.wake === true) {
				return { kind: "wake", inject: typeof data.inject === "string" ? data.inject : "" };
			}
			const reason = data?.reason;
			if (reason === "superseded" || reason === "closed" || reason === "aborted") return { kind: "none" };
			if (reason !== "timeout") {
				backoffMs =
					typeof data?.retryAfterMs === "number" && data.retryAfterMs > 0 ? data.retryAfterMs : WAKE_DEFAULT_BACKOFF_MS;
			}
		} else {
			backoffMs = WAKE_DEFAULT_BACKOFF_MS;
		}
		if (request.noWait) return { kind: "none" };
		const remaining = deadline - now();
		if (remaining <= 0) return { kind: "none" };
		if (backoffMs !== null) {
			await sleep(Math.min(backoffMs, remaining));
			if (deadline - now() <= 0) return { kind: "none" };
		}
	}
}

export interface PeerContext {
	cwd?: string;
	hostname?: string;
	title?: string;
	modifiedFiles?: string[];
}

const PEER_LIMITS = { cwd: 512, hostname: 128, title: 160, path: 300, files: 20 } as const;
const TRANSCRIPT_TAIL_BYTES = 512 * 1024;
const MUTATING_TOOLS: ReadonlySet<string> = new Set(["write", "edit", "multiedit", "notebookedit", "apply_patch"]);

function clipText(value: string, max: number): string {
	return value.replace(/\s+/g, " ").trim().slice(0, max);
}

export function extractMutatedPaths(toolName: unknown, toolInput: unknown): string[] {
	if (typeof toolName !== "string" || !MUTATING_TOOLS.has(toolName.toLowerCase())) return [];
	if (typeof toolInput === "string") return patchHeaderPaths(toolInput);
	if (typeof toolInput !== "object" || toolInput === null) return [];
	const record = toolInput as Record<string, unknown>;
	for (const key of ["file_path", "path", "notebook_path", "filePath"]) {
		const value = record[key];
		if (typeof value === "string" && value.trim()) return [value.trim()];
	}
	for (const key of ["command", "patch", "input", "patchText"]) {
		const value = record[key];
		if (typeof value === "string") {
			const found = patchHeaderPaths(value);
			if (found.length > 0) return found;
		}
	}
	return [];
}

function patchHeaderPaths(text: string): string[] {
	const out: string[] = [];
	for (const match of text.matchAll(/^\*\*\* (?:Add|Update|Delete) File:\s*(.+)$/gm)) {
		if (match[1]) out.push(match[1].trim());
	}
	return out;
}

const TRANSCRIPT_DEADLINE_MS = 750;
const REQUEST_TYPES: ReadonlySet<string> = new Set(["tool_use", "function_call", "custom_tool_call"]);
const RESULT_TYPES: ReadonlySet<string> = new Set(["tool_result", "function_call_output", "custom_tool_call_output"]);

interface TranscriptScan {
	title?: string;
	requests: Array<{ id: string; paths: string[] }>;
	failed: Set<string>;
	succeeded: Set<string>;
}

function parseMaybeJson(value: unknown): unknown {
	if (typeof value === "string" && value.trimStart().startsWith("{")) {
		try {
			return JSON.parse(value);
		} catch {
			return undefined;
		}
	}
	return value;
}

function resultFailed(record: Record<string, unknown>): boolean {
	if (record.is_error === true || record.isError === true) return true;
	if (typeof record.status === "string" && record.status !== "completed" && record.status !== "success") return true;
	const out = parseMaybeJson(record.output ?? record.content);
	if (typeof out === "object" && out !== null && !Array.isArray(out)) {
		const meta = (out as Record<string, unknown>).metadata;
		const code = typeof meta === "object" && meta !== null ? (meta as Record<string, unknown>).exit_code : undefined;
		if (typeof code === "number" && code !== 0) return true;
	}
	return false;
}

function walkTranscript(node: unknown, found: TranscriptScan, depth = 0): void {
	if (depth > 6 || typeof node !== "object" || node === null) return;
	if (Array.isArray(node)) {
		for (const item of node) walkTranscript(item, found, depth + 1);
		return;
	}
	const record = node as Record<string, unknown>;
	if (depth === 0) {
		const custom = record.customTitle;
		const ai = record.aiTitle;
		if (typeof custom === "string" && custom.trim()) found.title = custom;
		else if (typeof ai === "string" && ai.trim() && !found.title) found.title = ai;
	}
	const kind = typeof record.type === "string" ? record.type : "";
	if (REQUEST_TYPES.has(kind) && typeof record.name === "string") {
		const id = pickString(record.id, record.call_id, record.tool_use_id);
		if (id) {
			const args = parseMaybeJson(record.input ?? record.arguments);
			const paths = extractMutatedPaths(record.name, args);
			if (paths.length > 0) found.requests.push({ id, paths });
		}
	} else if (RESULT_TYPES.has(kind)) {
		const id = pickString(record.tool_use_id, record.call_id, record.id);
		if (id) (resultFailed(record) ? found.failed : found.succeeded).add(id);
	}
	for (const value of Object.values(record)) {
		if (typeof value === "object") walkTranscript(value, found, depth + 1);
	}
}

async function readTail(path: string): Promise<{ text: string; truncated: boolean }> {
	const handle = await openFile(path, "r");
	try {
		const size = (await handle.stat()).size;
		const start = Math.max(0, size - TRANSCRIPT_TAIL_BYTES);
		const buffer = Buffer.alloc(size - start);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
		return { text: buffer.toString("utf-8", 0, bytesRead), truncated: start > 0 };
	} finally {
		await handle.close();
	}
}

export async function readTranscriptSignals(path: string): Promise<{ title?: string; modifiedFiles: string[] }> {
	const found: TranscriptScan = { requests: [], failed: new Set(), succeeded: new Set() };
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const tail = await Promise.race([
			readTail(path),
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error("transcript read deadline")), TRANSCRIPT_DEADLINE_MS);
				timer.unref?.();
			}),
		]);
		const lines = tail.text.split("\n");
		if (tail.truncated) lines.shift();
		for (const line of lines) {
			if (!line.trim()) continue;
			try {
				walkTranscript(JSON.parse(line), found);
			} catch {}
		}
	} catch {
		return { modifiedFiles: [] };
	} finally {
		if (timer) clearTimeout(timer);
	}
	const paths: string[] = [];
	for (const req of found.requests) {
		if (found.succeeded.has(req.id) && !found.failed.has(req.id)) paths.push(...req.paths);
	}
	return { ...(found.title ? { title: found.title } : {}), modifiedFiles: paths };
}

export async function buildPeerContext(
	input: Record<string, unknown> | null,
	options: { readonly project?: string },
): Promise<PeerContext | undefined> {
	const cwd = pickString(options.project, input?.cwd);
	const context: PeerContext = {};
	if (cwd && cwd.length <= PEER_LIMITS.cwd) context.cwd = cwd;
	const host = osHostname();
	if (host && host.length <= PEER_LIMITS.hostname) context.hostname = host;
	let title = clipText(
		pickString(input?.session_name, input?.sessionName, input?.thread_name, input?.session_title, input?.title),
		PEER_LIMITS.title,
	);
	const transcriptPath = pickString(input?.transcript_path, input?.transcriptPath);
	const signals = transcriptPath ? await readTranscriptSignals(transcriptPath) : { modifiedFiles: [] as string[] };
	if (!title && signals.title) title = clipText(signals.title, PEER_LIMITS.title);
	if (title) context.title = title;
	const files: string[] = [];
	for (const raw of signals.modifiedFiles) {
		const full = cwd && !isAbsolute(raw) ? resolvePath(cwd, raw) : raw;
		if (full.length > PEER_LIMITS.path) continue;
		const path = full;
		const at = files.indexOf(path);
		if (at >= 0) files.splice(at, 1);
		files.push(path);
	}
	if (files.length > 0) context.modifiedFiles = files.slice(-PEER_LIMITS.files);
	return Object.keys(context).length > 0 ? context : undefined;
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
			const input = await readJson(deps.stdin);
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
				body: JSON.stringify(
					withPeerContext(
						buildSessionStartBody(input, options),
						await buildPeerContext(input, { project: options.project }),
					),
				),
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
			const input = await readJson(deps.stdin);
			const stdinProject = pickString(input?.cwd);
			const data = await fetchHookData<{
				inject?: string;
				dynamicContext?: string;
				clockContext?: string;
				contextHash?: string;
				contextVersion?: number;
			}>(deps, "user-prompt-submit", "/api/hooks/user-prompt-submit", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(
					withPeerContext(
						buildUserPromptSubmitBody(input, options.harness, options.project || stdinProject),
						await buildPeerContext(input, { project: options.project || stdinProject }),
					),
				),
				timeout: PROMPT_SUBMIT_TIMEOUT_MS,
			});
			if (!data) {
				if (options.codexJson) printCodexHookOutput("UserPromptSubmit");
				process.exit(0);
			}
			const dynamicContext = [data.dynamicContext ?? data.inject, data.clockContext]
				.filter((part): part is string => typeof part === "string" && part.trim().length > 0)
				.join("\n\n");
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
			const input = await readJson(deps.stdin);
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
					...peerContextField(await buildPeerContext(input, { project: options.project })),
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
		.command("wake")
		.description("Wait for a direct message and wake the harness session")
		.requiredOption("-H, --harness <harness>", "Harness name")
		.option("--project <project>", "Project path")
		.option("--agent-id <id>", "Agent ID")
		.option("--max-wait-seconds <n>", "Overall wait budget in seconds", String(WAKE_DEFAULT_MAX_WAIT_SECONDS))
		.option("--no-wait", "Claim once without waiting")
		.option("--hook-json", "Output Codex Stop hook JSON")
		.action(async (options) => {
			const hookJson = Boolean(options.hookJson);
			let outcome: WakeOutcome = { kind: "none" };
			try {
				const input = await readJson(deps.stdin);
				const sessionKey = pickSessionKey(input);
				if (sessionKey) {
					outcome = await runWakeLoop(deps, {
						harness: String(options.harness),
						sessionKey,
						agentId: pickString(options.agentId, input?.signet_agent_id, process.env.SIGNET_AGENT_ID),
						project: pickString(options.project, input?.cwd),
						context: await buildPeerContext(input, { project: options.project }),
						noWait: options.wait === false,
						maxWaitSeconds: parseWakeMaxWaitSeconds(options.maxWaitSeconds),
					});
				}
			} catch (err) {
				if (!hookJson) {
					process.stderr.write(`[signet] wake failed: ${err instanceof Error ? err.message : String(err)}\n`);
				}
			}
			if (hookJson) {
				console.log(JSON.stringify(outcome.kind === "wake" ? { decision: "block", reason: outcome.inject } : {}));
				process.exit(0);
				return;
			}
			if (outcome.kind === "wake") {
				process.stderr.write(`${outcome.inject}\n`);
				process.exit(2);
				return;
			}
			process.exit(0);
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
			const input = await readJson(deps.stdin);
			const sessionKey = pickSessionKey(input);
			const sessionContext = pickString(input?.session_context, input?.sessionContext);
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

function peerContextField(context: PeerContext | undefined): { context?: PeerContext } {
	return context ? { context } : {};
}

function withPeerContext<T extends { context?: unknown }>(body: T, context: PeerContext | undefined): T {
	if (!context || typeof body.context === "string") return body;
	return { ...body, context };
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
	lastAssistantMessage?: string;
	runtimePath: typeof LEGACY_RUNTIME_PATH;
} {
	const body = input ?? {};
	const sessionKey = pickSessionKey(body);
	const sessionId = pickString(body.session_id, body.sessionId, sessionKey);
	const lastAssistantMessage = readLastAssistantMessage(body);
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
		...(lastAssistantMessage ? { lastAssistantMessage } : {}),
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
