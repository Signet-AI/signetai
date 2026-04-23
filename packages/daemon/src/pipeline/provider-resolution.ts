import { spawn } from "node:child_process";
import type { LlmProvider, PipelineProviderChoice, SynthesisProviderChoice } from "@signet/core";
import { isPipelineProvider, isSynthesisProvider } from "@signet/core";
import {
	createAnthropicProvider,
	createClaudeCodeProvider,
	createCodexProvider,
	createOllamaProvider,
	createOpenCodeProvider,
	createOpenRouterProvider,
} from "./provider";

export type RuntimeRole = "extraction" | "synthesis";
export type RuntimeProviderName = PipelineProviderChoice;
export type RuntimeSynthesisProviderName = SynthesisProviderChoice;
export type RuntimeProviderStatus = "active" | "degraded" | "blocked" | "disabled" | "paused";

type CliPreflightResult = "ok" | "missing" | "failed";

export interface RuntimeProviderFactoryOptions {
	readonly role: RuntimeRole;
	readonly effectiveProvider: RuntimeProviderName;
	readonly configuredProvider: RuntimeProviderName;
	readonly configuredModel?: string;
	readonly timeoutMs: number;
	readonly ollamaBaseUrl: string;
	readonly ollamaFallbackBaseUrl: string;
	readonly ollamaFallbackMaxContextTokens: number;
	readonly openCodeBaseUrl: string;
	readonly openRouterBaseUrl: string;
	readonly anthropicApiKey?: string;
	readonly openRouterApiKey?: string;
	readonly openRouterReferer?: string;
	readonly openRouterTitle?: string;
}

export interface RuntimeEndpoints {
	readonly ollamaBaseUrl: string;
	readonly ollamaFallbackBaseUrl: string;
	readonly openCodeBaseUrl: string;
	readonly openRouterBaseUrl: string;
	readonly openCodeShouldManage: boolean;
}

export interface RuntimeStartupOptions {
	readonly role: RuntimeRole;
	readonly enabled: boolean;
	readonly paused: boolean;
	readonly configuredProvider: RuntimeProviderName;
	readonly configuredModel?: string;
	readonly timeoutMs: number;
	readonly fallbackProvider: "ollama" | "none";
	readonly endpoints: RuntimeEndpoints;
	readonly ollamaFallbackMaxContextTokens: number;
	readonly anthropicApiKey?: string;
	readonly openRouterApiKey?: string;
	readonly openRouterReferer?: string;
	readonly openRouterTitle?: string;
	readonly ensureOpenCodeServer?: (port: number) => Promise<boolean>;
	readonly checkProviderAvailability?: (provider: LlmProvider) => Promise<boolean>;
}

export interface RuntimeStartupResult {
	readonly provider: LlmProvider | null;
	readonly effectiveProvider: RuntimeProviderName;
	readonly effectiveModel?: string;
	readonly status: RuntimeProviderStatus;
	readonly degraded: boolean;
	readonly fallbackApplied: boolean;
	readonly reason: string | null;
	readonly since: string | null;
}

export function normalizeRuntimeBaseUrl(url: string | undefined, fallback: string): string {
	const base = normalizeBaseUrl(url) ?? fallback;
	try {
		const parsed = new URL(base);
		if (parsed.hostname === "localhost" || parsed.hostname === "::1") {
			parsed.hostname = "127.0.0.1";
		}
		return normalizeBaseUrl(parsed.toString()) ?? fallback;
	} catch {
		return base;
	}
}

function normalizeBaseUrl(raw: string | undefined): string | undefined {
	if (!raw) return undefined;
	const trimmed = raw.trim();
	if (!trimmed) return undefined;
	return trimmed.replace(/\/+$/, "");
}

export function isManagedOpenCodeLocalEndpoint(baseUrl: string): boolean {
	try {
		const parsed = new URL(baseUrl);
		const isLoopbackHost =
			parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "::1";
		if (!isLoopbackHost) return false;
		if (parsed.protocol !== "http:") return false;
		const port = parsed.port.length > 0 ? Number.parseInt(parsed.port, 10) : 80;
		return port === 4096;
	} catch {
		return false;
	}
}

export function resolveRuntimeEndpoints(
	configuredProvider: RuntimeProviderName,
	endpoint: string | undefined,
): RuntimeEndpoints {
	const ollamaBaseUrl = normalizeRuntimeBaseUrl(endpoint, "http://127.0.0.1:11434");
	const openCodeBaseUrl = normalizeRuntimeBaseUrl(endpoint, "http://127.0.0.1:4096");
	return {
		ollamaBaseUrl,
		ollamaFallbackBaseUrl: configuredProvider === "opencode" ? "http://127.0.0.1:11434" : ollamaBaseUrl,
		openCodeBaseUrl,
		openRouterBaseUrl: normalizeRuntimeBaseUrl(endpoint, "https://openrouter.ai/api/v1"),
		openCodeShouldManage: isManagedOpenCodeLocalEndpoint(openCodeBaseUrl),
	};
}

export function resolveRuntimeEndpointForLogs(
	provider: RuntimeProviderName,
	endpoints: RuntimeEndpoints,
): string | undefined {
	if (provider === "ollama") return endpoints.ollamaFallbackBaseUrl;
	if (provider === "opencode") return endpoints.openCodeBaseUrl;
	if (provider === "openrouter") return endpoints.openRouterBaseUrl;
	return undefined;
}

export function resolveRuntimeModel(
	effective: RuntimeProviderName,
	configured: RuntimeProviderName,
	model?: string,
): string | undefined {
	return (effective === "ollama" || effective === "llama-cpp") && configured !== effective ? undefined : model;
}

export function isSupportedRuntimeProvider(role: RuntimeRole, value: unknown): boolean {
	return role === "synthesis" ? isSynthesisProvider(value) : isPipelineProvider(value);
}

export function createRuntimeProvider(opts: RuntimeProviderFactoryOptions): LlmProvider | null {
	const model = resolveRuntimeModel(opts.effectiveProvider, opts.configuredProvider, opts.configuredModel);
	const usingOllamaFallback = opts.effectiveProvider === "ollama" && opts.configuredProvider !== "ollama";

	if (opts.effectiveProvider === "none") return null;
	if (opts.effectiveProvider === "command") return null;
	if (opts.effectiveProvider === "anthropic") {
		if (!opts.anthropicApiKey) return null;
		return createAnthropicProvider({
			model: model || "haiku",
			apiKey: opts.anthropicApiKey,
			defaultTimeoutMs: opts.timeoutMs,
		});
	}
	if (opts.effectiveProvider === "openrouter") {
		if (!opts.openRouterApiKey) return null;
		return createOpenRouterProvider({
			model: model || "openai/gpt-4o-mini",
			apiKey: opts.openRouterApiKey,
			baseUrl: opts.openRouterBaseUrl,
			referer: opts.openRouterReferer,
			title: opts.openRouterTitle,
			defaultTimeoutMs: opts.timeoutMs,
		});
	}
	if (opts.effectiveProvider === "opencode") {
		return createOpenCodeProvider({
			model: model || "anthropic/claude-haiku-4-5-20251001",
			baseUrl: opts.openCodeBaseUrl,
			ollamaFallbackBaseUrl: opts.ollamaFallbackBaseUrl,
			ollamaFallbackMaxContextTokens: opts.ollamaFallbackMaxContextTokens,
			defaultTimeoutMs: opts.timeoutMs,
		});
	}
	if (opts.effectiveProvider === "claude-code") {
		return createClaudeCodeProvider({
			model: model || "haiku",
			defaultTimeoutMs: opts.timeoutMs,
		});
	}
	if (opts.effectiveProvider === "codex") {
		return createCodexProvider({
			model: model || "gpt-5-codex-mini",
			defaultTimeoutMs: opts.timeoutMs,
		});
	}
	return createOllamaProvider({
		...(model ? { model } : {}),
		baseUrl: usingOllamaFallback ? opts.ollamaFallbackBaseUrl : opts.ollamaBaseUrl,
		defaultTimeoutMs: opts.timeoutMs,
		...(usingOllamaFallback
			? {
					maxContextTokens: opts.ollamaFallbackMaxContextTokens,
				}
			: {}),
	});
}

function createRuntimeProviderFromStartupOptions(
	opts: RuntimeStartupOptions,
	effectiveProvider: RuntimeProviderName,
): LlmProvider | null {
	return createRuntimeProvider({
		role: opts.role,
		effectiveProvider,
		configuredProvider: opts.configuredProvider,
		configuredModel: opts.configuredModel,
		timeoutMs: opts.timeoutMs,
		ollamaBaseUrl: opts.endpoints.ollamaBaseUrl,
		ollamaFallbackBaseUrl: opts.endpoints.ollamaFallbackBaseUrl,
		ollamaFallbackMaxContextTokens: opts.ollamaFallbackMaxContextTokens,
		openCodeBaseUrl: opts.endpoints.openCodeBaseUrl,
		openRouterBaseUrl: opts.endpoints.openRouterBaseUrl,
		anthropicApiKey: opts.anthropicApiKey,
		openRouterApiKey: opts.openRouterApiKey,
		openRouterReferer: opts.openRouterReferer,
		openRouterTitle: opts.openRouterTitle,
	});
}

async function isRuntimeProviderAvailable(opts: RuntimeStartupOptions, provider: LlmProvider): Promise<boolean> {
	return (await (opts.checkProviderAvailability?.(provider) ?? provider.available())) === true;
}

export async function resolveRuntimeProviderStartup(opts: RuntimeStartupOptions): Promise<RuntimeStartupResult> {
	let effectiveProvider = opts.configuredProvider;
	let status: RuntimeProviderStatus = "active";
	let degraded = false;
	let fallbackApplied = false;
	let reason: string | null = null;
	let since: string | null = null;

	const markUnavailable = (message: string): void => {
		reason = message;
		since = since ?? new Date().toISOString();
		degraded = true;
		if (opts.fallbackProvider === "ollama" && effectiveProvider !== "ollama") {
			effectiveProvider = "ollama";
			status = "degraded";
			fallbackApplied = true;
			return;
		}
		effectiveProvider = "none";
		status = "blocked";
		fallbackApplied = false;
	};

	if (opts.paused) {
		return {
			provider: null,
			effectiveProvider: "none",
			status: "paused",
			degraded: false,
			fallbackApplied: false,
			reason: null,
			since: null,
		};
	}
	if (!opts.enabled || effectiveProvider === "none") {
		return {
			provider: null,
			effectiveProvider: "none",
			status: "disabled",
			degraded: false,
			fallbackApplied: false,
			reason: null,
			since: null,
		};
	}
	if (effectiveProvider === "command") {
		return {
			provider: null,
			effectiveProvider,
			effectiveModel: resolveRuntimeModel(effectiveProvider, opts.configuredProvider, opts.configuredModel),
			status,
			degraded,
			fallbackApplied,
			reason,
			since,
		};
	}
	if (effectiveProvider === "opencode") {
		if (opts.endpoints.openCodeShouldManage) {
			const serverReady = await opts.ensureOpenCodeServer?.(4096);
			if (!serverReady) {
				markUnavailable(`OpenCode server not available for ${opts.role} startup preflight`);
			}
		}
	} else if (effectiveProvider === "anthropic") {
		if (!opts.anthropicApiKey) {
			markUnavailable(`ANTHROPIC_API_KEY not found for ${opts.role} startup preflight`);
		}
	} else if (effectiveProvider === "openrouter") {
		if (!opts.openRouterApiKey) {
			markUnavailable(`OPENROUTER_API_KEY not found for ${opts.role} startup preflight`);
		}
	} else if (effectiveProvider === "claude-code") {
		const cliResult = await preflightCliCommand("claude", { SIGNET_NO_HOOKS: "1" });
		if (cliResult === "missing") {
			markUnavailable(`Claude Code CLI not found during ${opts.role} startup preflight`);
		}
		if (cliResult === "failed") {
			markUnavailable(`Claude Code CLI failed ${opts.role} startup preflight`);
		}
	} else if (effectiveProvider === "codex") {
		const cliResult = await preflightCliCommand("codex", {
			SIGNET_NO_HOOKS: "1",
			SIGNET_CODEX_BYPASS_WRAPPER: "1",
		});
		if (cliResult === "missing") {
			markUnavailable(`Codex CLI not found during ${opts.role} startup preflight`);
		}
		if (cliResult === "failed") {
			markUnavailable(`Codex CLI failed ${opts.role} startup preflight`);
		}
	}

	let provider = createRuntimeProviderFromStartupOptions(opts, effectiveProvider);
	if (provider) {
		const preflightOk = await isRuntimeProviderAvailable(opts, provider);
		if (!preflightOk) {
			const failedProvider = effectiveProvider;
			const failedReason = reason ?? `${capitalizeRole(opts.role)} provider ${failedProvider} failed startup preflight`;
			if (failedProvider !== "ollama" && opts.fallbackProvider === "ollama") {
				reason = failedReason;
				since = since ?? new Date().toISOString();
				degraded = true;
				fallbackApplied = true;
				status = "degraded";
				effectiveProvider = "ollama";
				provider = createRuntimeProviderFromStartupOptions(opts, effectiveProvider);
				if (!provider || !(await isRuntimeProviderAvailable(opts, provider))) {
					effectiveProvider = "none";
					status = "blocked";
					fallbackApplied = false;
					reason = `${failedReason}; ollama fallback startup preflight failed`;
					provider = null;
				}
			} else {
				effectiveProvider = "none";
				status = "blocked";
				degraded = true;
				fallbackApplied = false;
				reason = opts.fallbackProvider === "none" ? `${failedReason}; fallbackProvider is none` : failedReason;
				since = since ?? new Date().toISOString();
				provider = null;
			}
		}
	}

	return {
		provider,
		effectiveProvider,
		effectiveModel: resolveRuntimeModel(effectiveProvider, opts.configuredProvider, opts.configuredModel),
		status,
		degraded,
		fallbackApplied,
		reason,
		since,
	};
}

function capitalizeRole(role: RuntimeRole): string {
	return role[0].toUpperCase() + role.slice(1);
}

async function preflightCliCommand(
	bin: "claude" | "codex",
	extraEnv: Record<string, string>,
): Promise<CliPreflightResult> {
	const resolved = Bun.which(bin);
	if (resolved === null) return "missing";
	try {
		const exitCode = await new Promise<number>((resolve) => {
			const proc = spawn(resolved, ["--version"], {
				stdio: "pipe",
				windowsHide: true,
				env: { ...process.env, ...extraEnv },
			});
			proc.on("close", (code) => resolve(code ?? 1));
			proc.on("error", () => resolve(1));
		});
		return exitCode === 0 ? "ok" : "failed";
	} catch {
		return "failed";
	}
}
