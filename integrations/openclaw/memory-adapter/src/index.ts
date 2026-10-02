import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { wrapMemoryContext } from "@signet/core";
import type { OpenClawPluginApi } from "./openclaw-types.js";
import {
	buildCompactionEventKey,
	buildScopedSessionKey,
	buildSessionlessTurnKey,
	extractCompactionSummary,
	extractLastAssistantMessage,
	extractLastUserMessage,
	extractUserMessage,
	firstNonEmptyString,
	firstNumber,
	isRecord,
	readCompactionSessionMetadata,
	resolveCompactionSessionFile,
	resolveCtx,
	type ResolvedCtx,
} from "./event-normalization.js";
import {
	DEFAULT_DAEMON_URL,
	RUNTIME_PATH,
	daemonFetch,
	daemonFetchResult,
	getDaemonPid,
	onCompactionComplete,
	onNotifications,
	onPreCompaction,
	onSessionEnd,
	onSessionStart,
	onUserPromptSubmit,
	WRITE_TIMEOUT,
	type SignetConfig,
	type UserPromptSubmitResult,
} from "./memory-operations.js";
import { registerMemoryTools } from "./memory-tools.js";
export {
	daemonFetch,
	daemonFetchResult,
	getDaemonPid,
	isDaemonRunning,
	memoryForget,
	memoryGet,
	memoryList,
	memoryModify,
	memoryRecall,
	memorySearch,
	memoryStore,
	onCompactionComplete,
	onNotifications,
	onPreCompaction,
	onSessionEnd,
	onSessionStart,
	onUserPromptSubmit,
	recall,
	remember,
	sessionSearch,
} from "./memory-operations.js";
export type {
	PreCompactionResult,
	SessionEndResult,
	SessionStartResult,
	SignetConfig,
	UserPromptSubmitResult,
} from "./memory-operations.js";

const HEARTBEAT_TIMEOUT = 2000;
const HEARTBEAT_INTERVAL_MS = 60_000;
const COMPACTION_HOOK_DEDUPE_MS = 1000;

function readContextString(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

const signetConfigSchema = {
	parse(value: unknown): SignetConfig {
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			return { daemonUrl: DEFAULT_DAEMON_URL };
		}
		const cfg = value as Record<string, unknown>;
		return {
			enabled: cfg.enabled !== false,
			daemonUrl: typeof cfg.daemonUrl === "string" ? cfg.daemonUrl : DEFAULT_DAEMON_URL,
		};
	},
};

const SESSIONLESS_DEDUPE_MS = 1_000;

export function cleanupTimedMap(map: Map<string, number>, now: number, ttlMs = SESSIONLESS_DEDUPE_MS): void {
	const expired: string[] = [];
	for (const [key, ts] of map) {
		if (now - ts > ttlMs) {
			expired.push(key);
		}
	}
	for (const key of expired) {
		map.delete(key);
	}
}
const BILLING_BLOCK = {
	type: "text",
	text: "x-anthropic-billing-header: cc_version=2.1.80.a46; cc_entrypoint=sdk-cli; cch=00000;",
} as const;
const REQUIRED_BETAS = [
	"claude-code-20250219",
	"oauth-2025-04-20",
	"interleaved-thinking-2025-05-14",
	"context-management-2025-06-27",
	"prompt-caching-scope-2026-01-05",
	"effort-2025-11-24",
] as const;
function injectBillingBlock(body: Record<string, unknown>): boolean {
	const system = body.system;
	if (Array.isArray(system)) {
		const first = system[0] as Record<string, unknown> | undefined;
		if (first && typeof first.text === "string" && first.text.includes("x-anthropic-billing-header")) {
			return false;
		}
		system.unshift({ ...BILLING_BLOCK });
		return true;
	}
	if (typeof system === "string") {
		body.system = [{ ...BILLING_BLOCK }, { type: "text", text: system }];
		return true;
	}
	body.system = [{ ...BILLING_BLOCK }];
	return true;
}
function sanitizeRequest(request: { body?: unknown }): boolean {
	if (!request.body || typeof request.body !== "string") return false;
	try {
		const body = JSON.parse(request.body) as Record<string, unknown>;
		const injected = injectBillingBlock(body);
		if (injected) {
			request.body = JSON.stringify(body);
			return true;
		}
	} catch {}
	return false;
}
function mergeBetaHeaders(headers: Record<string, string>): boolean {
	const key = Object.keys(headers).find((k) => k.toLowerCase() === "anthropic-beta") ?? "anthropic-beta";
	const existing = headers[key] ?? "";
	const betas = existing ? existing.split(",").map((b) => b.trim()) : [];
	let added = false;
	for (const required of REQUIRED_BETAS) {
		if (!betas.includes(required)) {
			betas.push(required);
			added = true;
		}
	}
	if (added) {
		headers[key] = betas.join(",");
	}
	return added;
}

function isAnthropicApiUrl(url: string): boolean {
	try {
		return new URL(url).hostname === "api.anthropic.com";
	} catch {
		return false;
	}
}
function readClaudeCodeOAuthToken(): string | undefined {
	try {
		const candidates = [
			join(homedir(), ".claude", ".credentials.json"),
			join(homedir(), ".claude", "credentials.json"),
		];
		for (const p of candidates) {
			if (!existsSync(p)) continue;
			const raw = readFileSync(p, "utf8");
			const creds = JSON.parse(raw) as Record<string, unknown>;
			const oauth = creds.claudeAiOauth as Record<string, unknown> | undefined;
			if (!oauth?.accessToken) continue;
			const expiresAt = oauth.expiresAt as number | undefined;
			if (expiresAt && expiresAt < Date.now()) continue;
			return oauth.accessToken as string;
		}
	} catch {}
	return undefined;
}
function swapAuthHeaders(headers: Record<string, string>, oauthToken: string): void {
	for (const key of Object.keys(headers)) {
		const lk = key.toLowerCase();
		if (lk === "x-api-key" || lk === "authorization") {
			delete headers[key];
		}
	}
	headers.authorization = `Bearer ${oauthToken}`;
}

function installFetchSanitizer(): () => void {
	const original = globalThis.fetch;
	const sanitized: typeof globalThis.fetch = (input, init) => {
		if (init?.body && typeof init.body === "string") {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			if (isAnthropicApiUrl(url)) {
				const carrier = { body: init.body };
				sanitizeRequest(carrier);
				const newBody = carrier.body as string;
				const oauthToken = readClaudeCodeOAuthToken();
				const skip = new Set(["host", "connection", "content-length", "anthropic-dangerous-direct-browser-access"]);
				const headers: Record<string, string> = {};
				if (init.headers) {
					if (init.headers instanceof Headers) {
						init.headers.forEach((v, k) => {
							if (!skip.has(k.toLowerCase())) headers[k] = v;
						});
					} else if (Array.isArray(init.headers)) {
						for (const pair of init.headers) {
							if (!skip.has(pair[0].toLowerCase())) headers[pair[0]] = pair[1];
						}
					} else {
						for (const [k, v] of Object.entries(init.headers as Record<string, string>)) {
							if (!skip.has(k.toLowerCase())) headers[k] = v;
						}
					}
				}
				mergeBetaHeaders(headers);
				headers["accept-encoding"] = "identity";
				if (oauthToken) {
					swapAuthHeaders(headers, oauthToken);
				}
				return original(input, { ...init, body: newBody, headers });
			}
		}
		return original(input, init);
	};
	globalThis.fetch = sanitized;
	return () => {
		if (globalThis.fetch === sanitized) {
			globalThis.fetch = original;
		}
	};
}
function resolveAnthropicBase(): (new (...args: unknown[]) => unknown) | undefined {
	try {
		const cache = typeof require !== "undefined" ? require.cache : undefined;
		if (cache) {
			for (const key of Object.keys(cache)) {
				if (!key.includes("@anthropic-ai") || !key.includes("sdk")) continue;
				if (!key.endsWith("/client.js") && !key.endsWith("/index.js")) continue;
				const mod = cache[key];
				const exports = mod?.exports as Record<string, unknown> | undefined;
				if (!exports) continue;
				const Base = (exports.BaseAnthropic ?? exports.Anthropic) as (new (...args: unknown[]) => unknown) | undefined;
				if (Base?.prototype && typeof Base.prototype.prepareRequest === "function") {
					return Base;
				}
			}
		}
	} catch {}
	try {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const sdk = require("@anthropic-ai/sdk") as Record<string, unknown>;
		const Base = (sdk.BaseAnthropic ?? sdk.Anthropic) as (new (...args: unknown[]) => unknown) | undefined;
		if (Base?.prototype && typeof Base.prototype.prepareRequest === "function") {
			return Base;
		}
	} catch {}
	return undefined;
}

function installSdkSanitizer(): () => void {
	type PrepareRequestFn = (request: RequestInit, context: { url: string; options: unknown }) => Promise<void>;

	let Base: (new (...args: unknown[]) => unknown) | undefined;
	let original: PrepareRequestFn | undefined;
	let timer: ReturnType<typeof setInterval> | null = null;

	function applyPatch(): boolean {
		const found = resolveAnthropicBase();
		if (!found) return false;
		Base = found;
		const previous = Base.prototype.prepareRequest as PrepareRequestFn;
		original = previous;
		Base.prototype.prepareRequest = async function (
			request: RequestInit,
			context: { url: string; options: unknown },
		): Promise<void> {
			sanitizeRequest(request as { body?: unknown });
			return previous.call(this, request, context);
		};
		return true;
	}

	if (!applyPatch()) {
		let attempts = 0;
		timer = setInterval(() => {
			attempts++;
			if (applyPatch() || attempts >= 30) {
				if (timer) {
					clearInterval(timer);
					timer = null;
				}
			}
		}, 200);
	}

	return () => {
		if (timer) {
			clearInterval(timer);
			timer = null;
		}
		if (Base && original) {
			Base.prototype.prepareRequest = original;
		}
	};
}

function buildInjectionResult(result: UserPromptSubmitResult): { prependContext: string } | undefined {
	const dynamicContext = readContextString(result.dynamicContext) || readContextString(result.inject);
	const clockContext = readContextString(result.clockContext);
	if (!dynamicContext && !clockContext) {
		return undefined;
	}
	let context = "";
	if (dynamicContext) {
		const queryAttr = result.queryTerms ? ` query="${result.queryTerms.replace(/"/g, "'").slice(0, 100)}"` : "";
		const attrs = `source="auto-recall"${queryAttr} results="${result.memoryCount}" engine="${result.engine ?? "fts+decay"}"`;
		context = wrapMemoryContext(dynamicContext, "auto-recall").replace(
			'<signet-memory source="auto-recall">',
			`<signet-memory ${attrs}>`,
		);
	}
	return {
		prependContext: [context, clockContext].filter((part) => part.length > 0).join("\n\n"),
	};
}

const REG_KEY = "__signet_openclaw_registered__signet-memory-openclaw";

function readRegistered(): boolean {
	const value = Reflect.get(globalThis, REG_KEY);
	return value === true;
}

function writeRegistered(value: boolean): void {
	Reflect.set(globalThis, REG_KEY, value);
}

function buildMemoryPromptSection({
	availableTools,
	citationsMode,
}: {
	availableTools: Set<string>;
	citationsMode?: "auto" | "on" | "off";
}): string[] {
	const hasSearch = availableTools.has("memory_search");
	const hasGet = availableTools.has("memory_get");
	if (!hasSearch && !hasGet) return [];

	const guidance = hasSearch
		? `Before answering about prior work, decisions, dates, people, preferences, or todos, use memory_search${
				hasGet ? "; then use memory_get when an exact memory must be inspected" : ""
			}. Signet results are scoped and provenance-backed; if recall is inconclusive, say that you checked.`
		: "When a request points to a specific remembered item, use memory_get before answering. Signet results are scoped and provenance-backed; if the lookup is inconclusive, say that you checked.";

	const lines = ["## Signet Memory", guidance];
	if (citationsMode === "off") {
		lines.push("Do not expose source identifiers or provenance in the reply unless the user asks for them.");
	} else {
		lines.push("Include provenance when it materially helps the user verify a recalled claim.");
	}
	lines.push("");
	return lines;
}

const signetPlugin = {
	id: "signet-memory-openclaw",
	name: "Signet Memory",
	description: "Signet agent memory — persistent, searchable, identity-aware memory for AI agents",
	kind: "memory" as const,
	configSchema: signetConfigSchema,

	register(api: OpenClawPluginApi): void {
		const mode = api.registrationMode ?? "full";
		if (mode === "discovery") {
			api.registerMemoryCapability({ promptBuilder: buildMemoryPromptSection });
			return;
		}

		if (["cli-metadata", "setup-only", "setup-runtime"].includes(mode)) {
			return;
		}
		if (mode !== "full" && mode !== "tool-discovery") {
			api.logger.warn(`signet-memory: skipping runtime registration for unknown mode=${mode}`);
			return;
		}

		if (mode === "full" && readRegistered()) {
			api.logger.warn("signet-memory: register() called twice with non-cli mode, skipping duplicate");
			return;
		}
		let claimed = false;
		try {
			const cfg = signetConfigSchema.parse(api.pluginConfig);
			const daemonUrl = cfg.daemonUrl || DEFAULT_DAEMON_URL;
			const opts = {
				daemonUrl,
				harness: "openclaw",
				workspace: process.env.SIGNET_WORKSPACE ?? process.cwd(),
				channel: process.env.SIGNET_CHANNEL,
			};
			if (mode === "full") {
				api.registerMemoryCapability({ promptBuilder: buildMemoryPromptSection });
				writeRegistered(true);
				claimed = true;
			}
			const removeFetchSanitizer = mode === "full" ? installFetchSanitizer() : () => {};
			const removeSdkSanitizer = mode === "full" ? installSdkSanitizer() : () => {};
			let daemonReachable = true;
			let knownPid: number | null = null;
			let healthTimer: ReturnType<typeof setInterval> | null = null;
			const hooksRegistered = [
				"before_prompt_build",
				"before_agent_start",
				"message_received",
				"before_tool_call",
				"agent_end",
				"before_compaction",
				"after_compaction",
			];
			let healthError: string | null = null;
			let heartbeatInFlight = false;

			const pluginVersion = typeof api.version === "string" && api.version.trim() ? api.version : "unknown";
			const sendHeartbeat = async (): Promise<void> => {
				if (heartbeatInFlight) return;
				heartbeatInFlight = true;
				try {
					await daemonFetchResult<{ ok: boolean }>(daemonUrl, "/api/diagnostics/openclaw/heartbeat", {
						method: "POST",
						body: {
							pluginVersion,
							hooksRegistered,
							lastHookCall: null,
							lastError: healthError,
							latencyMs: 0,
							hooksSucceeded: 0,
							hooksFailed: healthError ? 1 : 0,
						},
						timeout: HEARTBEAT_TIMEOUT,
					});
				} finally {
					heartbeatInFlight = false;
				}
			};

			if (mode === "full") {
				api.logger.info(`signet-memory: registered (daemon: ${daemonUrl})`);
			}
			if (mode === "full") {
				getDaemonPid(daemonUrl).then((pid) => {
					daemonReachable = pid !== null;
					knownPid = pid;
					if (!daemonReachable) {
						healthError = `daemon unreachable at ${daemonUrl}; memory hooks are disabled until Signet is healthy`;
						api.logger.warn(
							`signet-memory: daemon unreachable at ${daemonUrl}. Memory hooks are disabled until daemon health recovers; run \`signet status\` or \`signet doctor\` for diagnostics.`,
						);
					} else {
						healthError = null;
						void sendHeartbeat();
					}
				});
			}

			registerMemoryTools(api, opts);
			if (mode === "tool-discovery") return;

			const claimedSessions = new Set<string>();
			type SessionStartContext = {
				stableSystemPrompt: string;
				dynamicContext: string;
				delivered: boolean;
			};
			const sessionStartContexts = new Map<string, SessionStartContext>();
			const sessionlessSessionStartContexts = new Map<string, SessionStartContext>();
			const sessionlessSessionStarts = new Map<string, number>();
			const SESSION_TURN_TTL_MS = 4 * 60 * 60 * 1000;
			const injectedTurns = new Map<string, { count: number; at: number }>();
			const inFlightTurns = new Set<string>();
			const pendingNotifications = new Map<string, { inject: string; at: number }>();
			const beforeCompactions = new Map<string, number>();
			const afterCompactions = new Map<string, number>();
			const CHECKPOINT_TURN_THRESHOLD = 20;
			const checkpointTurns = new Map<string, { count: number; lastMsgCount: number | undefined; at: number }>();
			const bpbGen = new Map<string, number>();
			const basGen = new Map<string, number>();

			const maybeFireCheckpoint = (
				sessionKey: string | undefined,
				agentId: string | undefined,
				project: string | undefined,
				sessionFile: string | undefined,
				msgCount: number | undefined,
				messages: readonly unknown[] | undefined,
			): void => {
				const scopedKey = buildScopedSessionKey(sessionKey, agentId);
				if (!scopedKey || !sessionKey) return;

				const now = Date.now();
				const state = checkpointTurns.get(scopedKey);
				if (state && now - state.at > SESSION_TURN_TTL_MS) {
					checkpointTurns.delete(scopedKey);
				} else {
					sessionlessSessionStartContexts.clear();
					sessionlessSessionStarts.clear();
				}
				if (msgCount !== undefined && checkpointTurns.get(scopedKey)?.lastMsgCount === msgCount) return;

				const newCount = (checkpointTurns.get(scopedKey)?.count ?? 0) + 1;
				checkpointTurns.set(scopedKey, {
					count: newCount >= CHECKPOINT_TURN_THRESHOLD ? 0 : newCount,
					lastMsgCount: msgCount,
					at: now,
				});

				if (newCount < CHECKPOINT_TURN_THRESHOLD) return;
				const inlineTranscript =
					!sessionFile && Array.isArray(messages) && messages.length > 0
						? messages.map((m) => JSON.stringify(m)).join("\n")
						: undefined;
				void daemonFetch(daemonUrl, "/api/hooks/session-checkpoint-extract", {
					method: "POST",
					body: {
						harness: "openclaw",
						sessionKey,
						agentId,
						project,
						transcriptPath: sessionFile,
						...(inlineTranscript && { transcript: inlineTranscript }),
						runtimePath: RUNTIME_PATH,
					},
					timeout: WRITE_TIMEOUT,
				})
					.then((resp) => {
						if (isRecord(resp) && resp.skipped === true) {
							const cur = checkpointTurns.get(scopedKey);
							if (cur && cur.count < CHECKPOINT_TURN_THRESHOLD - 1)
								checkpointTurns.set(scopedKey, { ...cur, count: CHECKPOINT_TURN_THRESHOLD - 1 });
						}
					})
					.catch((err) => {
						api.logger.warn(
							`signet-memory: checkpoint extract failed: ${err instanceof Error ? err.message : String(err)}`,
						);
						const cur = checkpointTurns.get(scopedKey);
						if (cur && cur.count < CHECKPOINT_TURN_THRESHOLD - 1)
							checkpointTurns.set(scopedKey, { ...cur, count: CHECKPOINT_TURN_THRESHOLD - 1 });
					});
			};

			const resolveCompactionProject = (
				event: Record<string, unknown>,
				resolved: ResolvedCtx,
				sessionFileProject: string | undefined,
			): string | undefined => {
				const compaction = isRecord(event.compaction) ? event.compaction : undefined;
				return firstNonEmptyString(
					event.cwd,
					event.project,
					event.workspace,
					compaction?.project,
					compaction?.cwd,
					compaction?.workspace,
					resolved.project,
					sessionFileProject,
				);
			};

			const dedupeCompaction = (map: Map<string, number>, key: string): boolean => {
				const now = Date.now();
				cleanupTimedMap(map, now, COMPACTION_HOOK_DEDUPE_MS);
				const seenAt = map.get(key);
				if (typeof seenAt === "number" && now - seenAt <= COMPACTION_HOOK_DEDUPE_MS) {
					return true;
				}
				map.set(key, now);
				return false;
			};

			const handleBeforeCompaction = async (event: Record<string, unknown>, ctx: unknown): Promise<unknown> => {
				if (!cfg.enabled || !daemonReachable) return undefined;
				const resolved = resolveCtx(event, ctx);
				const compaction = isRecord(event.compaction) ? event.compaction : undefined;
				const messageCount = firstNumber(
					event.messageCount,
					event.compactingCount,
					event.compactedCount,
					compaction?.compactingCount,
					compaction?.compactedCount,
				);
				const dedupeKey = buildCompactionEventKey(event, {
					agentId: resolved.agentId,
					sessionKey: resolved.sessionKey,
				});
				if (dedupeCompaction(beforeCompactions, dedupeKey)) {
					return undefined;
				}

				const result = await onPreCompaction("openclaw", {
					...opts,
					sessionKey: resolved.sessionKey,
					messageCount,
				});
				const parts = [result?.summaryPrompt, result?.guidelines].filter(
					(value) => typeof value === "string" && value.length > 0,
				);
				if (parts.length === 0) {
					return undefined;
				}
				return {
					prependContext: parts.join("\n\n"),
				};
			};

			const handleAfterCompaction = async (event: Record<string, unknown>, ctx: unknown): Promise<void> => {
				if (!cfg.enabled || !daemonReachable) return;
				const resolved = resolveCtx(event, ctx);
				const scopedKey = buildScopedSessionKey(resolved.sessionKey, resolved.agentId);
				if (scopedKey) {
					injectedTurns.delete(scopedKey);
					const sessionStartContext = sessionStartContexts.get(scopedKey);
					if (sessionStartContext) {
						sessionStartContext.dynamicContext = "";
						sessionStartContext.delivered = false;
					}
					checkpointTurns.delete(scopedKey);
				}
				const sessionFile = resolveCompactionSessionFile(event, resolved.sessionFile);
				const eventSummary = extractCompactionSummary(event);
				const sessionMetadata = readCompactionSessionMetadata(sessionFile, !eventSummary);
				const summary = eventSummary ?? sessionMetadata.summary;
				if (!summary) {
					api.logger.warn(
						`signet-memory: compaction summary unavailable, skipping save${sessionFile ? ` (${sessionFile})` : ""}`,
					);
					return;
				}

				const dedupeKey = buildCompactionEventKey(event, {
					agentId: resolved.agentId,
					sessionKey: resolved.sessionKey,
					summary,
				});
				if (dedupeCompaction(afterCompactions, dedupeKey)) {
					return;
				}

				await onCompactionComplete("openclaw", summary, {
					...opts,
					agentId: resolved.agentId,
					project: resolveCompactionProject(event, resolved, sessionMetadata.project),
					sessionKey: resolved.sessionKey,
				});
			};

			const ensureSessionStarted = async (
				event: Record<string, unknown>,
				sessionKey: string | undefined,
				agentId: string | undefined,
			): Promise<SessionStartContext | undefined> => {
				if (!sessionKey) {
					const now = Date.now();
					cleanupTimedMap(sessionlessSessionStarts, now);
					for (const key of sessionlessSessionStartContexts.keys()) {
						if (!sessionlessSessionStarts.has(key)) sessionlessSessionStartContexts.delete(key);
					}
					const sessionlessKey = buildSessionlessTurnKey(event, agentId);
					const recentStartAt = sessionlessSessionStarts.get(sessionlessKey);
					if (typeof recentStartAt === "number" && now - recentStartAt <= SESSIONLESS_DEDUPE_MS) {
						return sessionlessSessionStartContexts.get(sessionlessKey);
					}

					const startResult = await onSessionStart("openclaw", {
						...opts,
						sessionKey,
						agentId,
					});
					if (!startResult) return undefined;
					const context: SessionStartContext = {
						stableSystemPrompt: readContextString(startResult.stableSystemPrompt),
						dynamicContext: readContextString(startResult.dynamicContext) || readContextString(startResult.inject),
						delivered: false,
					};
					sessionlessSessionStarts.set(sessionlessKey, Date.now());
					sessionlessSessionStartContexts.set(sessionlessKey, context);
					return context;
				}

				const scopedKey = buildScopedSessionKey(sessionKey, agentId);
				if (scopedKey && claimedSessions.has(scopedKey)) {
					return sessionStartContexts.get(scopedKey);
				}

				const startResult = await onSessionStart("openclaw", {
					...opts,
					sessionKey,
					agentId,
				});
				if (!startResult) return undefined;
				const context: SessionStartContext = {
					stableSystemPrompt: readContextString(startResult.stableSystemPrompt),
					dynamicContext: readContextString(startResult.dynamicContext) || readContextString(startResult.inject),
					delivered: false,
				};
				if (scopedKey) {
					claimedSessions.add(scopedKey);
					sessionStartContexts.set(scopedKey, context);
				}
				return context;
			};

			const runPromptInjection = async (
				event: Record<string, unknown>,
				sessionKey: string | undefined,
				agentId: string | undefined,
			): Promise<unknown> => {
				if (!daemonReachable) return undefined;

				const scopedKey = buildScopedSessionKey(sessionKey, agentId);
				const sessionlessKey = scopedKey ? undefined : buildSessionlessTurnKey(event, agentId);
				const pendingNotification = scopedKey ? pendingNotifications.get(scopedKey)?.inject : undefined;
				const takeSessionStartInjection = (): string | undefined => {
					const context = scopedKey
						? sessionStartContexts.get(scopedKey)
						: sessionlessKey
							? sessionlessSessionStartContexts.get(sessionlessKey)
							: undefined;
					if (!context || context.delivered) return undefined;
					context.delivered = true;
					if (sessionlessKey) sessionlessSessionStartContexts.delete(sessionlessKey);
					return wrapMemoryContext(
						[context.stableSystemPrompt, context.dynamicContext].filter((part) => part.length > 0).join("\n\n"),
						"session-start",
					);
				};
				const rawPrompt = typeof event.prompt === "string" ? event.prompt : undefined;
				const prompt =
					extractLastUserMessage(event.messages) ?? (rawPrompt ? extractUserMessage(rawPrompt) : undefined);
				if (!prompt || prompt.length <= 3) {
					return pendingNotification ? { prependContext: pendingNotification } : undefined;
				}
				const count = Array.isArray(event.messages) ? event.messages.length : undefined;
				const sig = scopedKey && typeof count === "number" ? `${scopedKey}|${count}` : undefined;
				if (sig) {
					const now = Date.now();
					for (const [k, v] of injectedTurns) {
						if (now - v.at > SESSION_TURN_TTL_MS) injectedTurns.delete(k);
					}
					for (const [k, v] of pendingNotifications) {
						if (now - v.at > SESSION_TURN_TTL_MS) pendingNotifications.delete(k);
					}
				}
				if (
					sig &&
					(inFlightTurns.has(sig) || (scopedKey !== undefined && injectedTurns.get(scopedKey)?.count === count))
				) {
					const notifications = await onNotifications("openclaw", "before_prompt_build", {
						...opts,
						agentId,
						sessionKey,
					});
					if (notifications?.inject) return { prependContext: notifications.inject };
					return pendingNotification ? { prependContext: pendingNotification } : undefined;
				}
				if (sig) inFlightTurns.add(sig);

				const lastAssistantMessage = extractLastAssistantMessage(event);
				const result = await onUserPromptSubmit("openclaw", {
					...opts,
					agentId,
					userMessage: prompt,
					lastAssistantMessage,
					sessionKey,
				});
				if (sig) inFlightTurns.delete(sig);
				if (!result) {
					return pendingNotification ? { prependContext: pendingNotification } : undefined;
				}
				if (scopedKey) pendingNotifications.delete(scopedKey);
				if (scopedKey && typeof count === "number") {
					injectedTurns.set(scopedKey, { count, at: Date.now() });
				}
				const sessionStartInjection = takeSessionStartInjection();
				const promptInjection = buildInjectionResult(result)?.prependContext;
				const parts = [sessionStartInjection, promptInjection].filter((value): value is string => Boolean(value));
				return parts.length > 0 ? { prependContext: parts.join("\n\n") } : undefined;
			};
			api.on(
				"before_prompt_build",
				async (event: Record<string, unknown>, ctx: unknown): Promise<unknown> => {
					if (!cfg.enabled) return undefined;

					const resolved = resolveCtx(event, ctx);
					await ensureSessionStarted(event, resolved.sessionKey, resolved.agentId);
					const result = await runPromptInjection(event, resolved.sessionKey, resolved.agentId);
					const msgs = Array.isArray(event.messages) ? (event.messages as readonly unknown[]) : undefined;
					const msgCount = msgs?.length;
					const bpbKey = buildScopedSessionKey(resolved.sessionKey, resolved.agentId);
					if (bpbKey) bpbGen.set(bpbKey, (bpbGen.get(bpbKey) ?? 0) + 1);
					maybeFireCheckpoint(
						resolved.sessionKey,
						resolved.agentId,
						resolved.project,
						resolved.sessionFile,
						msgCount,
						msgs,
					);
					return result;
				},
				{ priority: 20 },
			);
			api.on("before_agent_start", async (event: Record<string, unknown>, ctx: unknown): Promise<unknown> => {
				if (!cfg.enabled) return undefined;

				const resolved = resolveCtx(event, ctx);
				await ensureSessionStarted(event, resolved.sessionKey, resolved.agentId);
				const result = await runPromptInjection(event, resolved.sessionKey, resolved.agentId);
				const msgs = Array.isArray(event.messages) ? (event.messages as readonly unknown[]) : undefined;
				const msgCount = msgs?.length;
				const basKey = buildScopedSessionKey(resolved.sessionKey, resolved.agentId);
				const latestBpb = basKey ? (bpbGen.get(basKey) ?? 0) : 0;
				const lastConsumed = basKey ? (basGen.get(basKey) ?? 0) : 0;
				const coveredByBpb = latestBpb > lastConsumed;
				if (basKey && coveredByBpb) basGen.set(basKey, latestBpb);
				if (!coveredByBpb || msgCount !== undefined) {
					maybeFireCheckpoint(
						resolved.sessionKey,
						resolved.agentId,
						resolved.project,
						resolved.sessionFile,
						msgCount,
						msgs,
					);
				}
				return result;
			});

			const cacheNotificationHook = async (
				event: Record<string, unknown>,
				ctx: unknown,
				hook: string,
			): Promise<void> => {
				if (!cfg.enabled || !daemonReachable) return;
				const resolved = resolveCtx(event, ctx);
				const scopedKey = buildScopedSessionKey(resolved.sessionKey, resolved.agentId);
				if (!scopedKey) return;
				const result = await onNotifications("openclaw", hook, {
					...opts,
					agentId: resolved.agentId,
					sessionKey: resolved.sessionKey,
					project: resolved.project,
				});
				if (result?.inject) {
					pendingNotifications.set(scopedKey, { inject: result.inject, at: Date.now() });
				} else {
					pendingNotifications.delete(scopedKey);
				}
			};

			api.on("message_received", async (event: Record<string, unknown>, ctx: unknown): Promise<void> => {
				await cacheNotificationHook(event, ctx, "message_received");
			});
			api.on("before_tool_call", async (event: Record<string, unknown>, ctx: unknown): Promise<void> => {
				await cacheNotificationHook(event, ctx, "before_tool_call");
			});

			api.on("agent_end", async (event: Record<string, unknown>, ctx: unknown): Promise<unknown> => {
				if (!cfg.enabled) return undefined;

				const resolved = resolveCtx(event, ctx);
				const scopedKey = buildScopedSessionKey(resolved.sessionKey, resolved.agentId);
				const endMsgs = Array.isArray(event.messages) ? (event.messages as readonly unknown[]) : undefined;
				const endTranscript =
					!resolved.sessionFile && endMsgs && endMsgs.length > 0
						? endMsgs.map((m) => JSON.stringify(m)).join("\n")
						: undefined;
				await onSessionEnd("openclaw", {
					...opts,
					agentId: resolved.agentId,
					cwd: resolved.project,
					sessionId: resolved.sessionId,
					sessionKey: resolved.sessionKey,
					transcriptPath: resolved.sessionFile,
					...(endTranscript && { transcript: endTranscript }),
				});
				if (scopedKey) {
					claimedSessions.delete(scopedKey);
					sessionStartContexts.delete(scopedKey);
					injectedTurns.delete(scopedKey);
					pendingNotifications.delete(scopedKey);
					checkpointTurns.delete(scopedKey);
					bpbGen.delete(scopedKey);
					basGen.delete(scopedKey);
				}
				return undefined;
			});

			api.on("before_compaction", async (event: Record<string, unknown>, ctx: unknown): Promise<unknown> => {
				return handleBeforeCompaction(event, ctx);
			});

			api.on("after_compaction", async (event: Record<string, unknown>, ctx: unknown): Promise<unknown> => {
				await handleAfterCompaction(event, ctx);
				return undefined;
			});

			api.registerService({
				id: "signet-memory-openclaw",
				start() {
					api.logger.info(`signet-memory: service started (daemon: ${daemonUrl})`);
					healthTimer = setInterval(async () => {
						const pid = await getDaemonPid(daemonUrl);
						const ok = pid !== null;
						if (ok !== daemonReachable) {
							daemonReachable = ok;
							if (ok) {
								healthError = null;
								api.logger.info("signet-memory: daemon reconnected");
								void sendHeartbeat();
							} else {
								healthError = `daemon became unreachable at ${daemonUrl}; memory hooks are disabled`;
								api.logger.warn(
									"signet-memory: daemon became unreachable; memory hooks are disabled until health recovers",
								);
							}
						} else if (ok) {
							void sendHeartbeat();
						}
						if (ok && knownPid !== null && pid !== knownPid) {
							api.logger.info(`signet-memory: daemon restarted (pid ${knownPid} -> ${pid}), re-initializing sessions`);
							claimedSessions.clear();
							sessionStartContexts.clear();
							sessionlessSessionStartContexts.clear();
							injectedTurns.clear();
							inFlightTurns.clear();
							pendingNotifications.clear();
							sessionlessSessionStarts.clear();
						}
						knownPid = pid;
					}, HEARTBEAT_INTERVAL_MS);
				},
				stop() {
					api.logger.info("signet-memory: service stopped");
					try {
						removeFetchSanitizer();
						removeSdkSanitizer();
						if (healthTimer) {
							clearInterval(healthTimer);
							healthTimer = null;
						}
					} finally {
						writeRegistered(false);
					}
				},
			});
		} catch (err) {
			if (claimed) {
				writeRegistered(false);
				api.logger.error(
					`signet-memory: registration failed after guard was claimed; guard reset before rethrow: ${String(err)}`,
				);
			}
			throw err;
		}
	},
};
export function _resetRegistration(): void {
	if (process.env.NODE_ENV === "test") {
		writeRegistered(false);
	}
}
export const _sanitization = {
	isAnthropicApiUrl,
	injectBillingBlock,
	sanitizeRequest,
	mergeBetaHeaders,
	readClaudeCodeOAuthToken,
	swapAuthHeaders,
	installFetchSanitizer,
	resolveAnthropicBase,
	installSdkSanitizer,
	BILLING_BLOCK,
	REQUIRED_BETAS,
} as const;

export default signetPlugin;
