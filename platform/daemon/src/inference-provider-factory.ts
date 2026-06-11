import type { RoutingConfig } from "@signetai/core";
import {
	type AcpxHooksMode,
	type StreamCapableLlmProvider,
	createAcpxProvider,
	createAnthropicProvider,
	createClaudeCodeProvider,
	createCodexProvider,
	createCommandLineProvider,
	createOllamaProvider,
	createOpenAiCompatibleProvider,
	createOpenCodeProvider,
	createOpenRouterProvider,
	resolveDefaultOllamaFallbackMaxContextTokens,
} from "./pipeline/provider";

const DEFAULT_OPENCODE_BASE_URL = "http://127.0.0.1:4096";
const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434";
const DEFAULT_OPENAI_COMPATIBLE_BASE_URL = "http://127.0.0.1:1234/v1";
const DEFAULT_LLAMA_CPP_BASE_URL = "http://127.0.0.1:8080";

export interface CreateRoutingProviderOptions {
	readonly config: RoutingConfig;
	readonly targetId: string;
	readonly modelId: string;
	readonly acpxHooks?: AcpxHooksMode;
	resolveCredential(credentialRef: string | undefined): Promise<string | undefined>;
}

function withOpenAiVersionPath(baseUrl: string): string {
	const trimmed = baseUrl.trim().replace(/\/+$/, "");
	if (trimmed.endsWith("/v1")) return trimmed;
	return `${trimmed}/v1`;
}

export async function createRoutingProvider(opts: CreateRoutingProviderOptions): Promise<StreamCapableLlmProvider> {
	const target = opts.config.targets[opts.targetId];
	const model = target?.models[opts.modelId];
	if (!target || !model) {
		throw new Error(`Unknown routing target ${opts.targetId}/${opts.modelId}`);
	}

	const account = target.account ? opts.config.accounts[target.account] : undefined;
	const credential = await opts.resolveCredential(account?.credentialRef);
	switch (target.executor) {
		case "acpx":
			if (!target.acpx) throw new Error(`Missing ACPX config for target ${opts.targetId}`);
			return createAcpxProvider({
				...target.acpx,
				...(opts.acpxHooks ? { hooks: opts.acpxHooks } : {}),
				model: model.model,
			});
		case "anthropic":
			if (!credential) throw new Error(`Missing credential for account ${target.account ?? "anthropic"}`);
			return createAnthropicProvider({
				model: model.model,
				apiKey: credential,
				baseUrl: target.endpoint ?? "https://api.anthropic.com",
			});
		case "openrouter":
			if (!credential) throw new Error(`Missing credential for account ${target.account ?? "openrouter"}`);
			return createOpenRouterProvider({
				model: model.model,
				apiKey: credential,
				baseUrl: target.endpoint ?? "https://openrouter.ai/api/v1",
				reasoning: target.openrouter?.reasoning,
				referer: process.env.OPENROUTER_HTTP_REFERER,
				title: process.env.OPENROUTER_TITLE,
			});
		case "ollama":
			return createOllamaProvider({
				model: model.model,
				baseUrl: target.endpoint ?? DEFAULT_OLLAMA_BASE_URL,
			});
		case "claude-code":
			return createClaudeCodeProvider({ model: model.model });
		case "codex":
			return createCodexProvider({ model: model.model });
		case "opencode":
			return createOpenCodeProvider({
				model: model.model,
				baseUrl: target.endpoint ?? DEFAULT_OPENCODE_BASE_URL,
				ollamaFallbackBaseUrl: DEFAULT_OLLAMA_BASE_URL,
				ollamaFallbackMaxContextTokens: resolveDefaultOllamaFallbackMaxContextTokens(),
			});
		case "openai-compatible":
			return createOpenAiCompatibleProvider({
				name: `openai-compatible:${model.model}`,
				model: model.model,
				baseUrl: target.endpoint ?? DEFAULT_OPENAI_COMPATIBLE_BASE_URL,
				apiKey: credential,
				defaultTimeoutMs: 60_000,
			});
		case "llama-cpp":
			return createOpenAiCompatibleProvider({
				name: `llama-cpp:${model.model}`,
				model: model.model,
				baseUrl: withOpenAiVersionPath(target.endpoint ?? DEFAULT_LLAMA_CPP_BASE_URL),
				apiKey: credential,
				defaultTimeoutMs: 60_000,
			});
		case "command": {
			if (!target.command) throw new Error(`Missing command config for target ${opts.targetId}`);
			return createCommandLineProvider({
				name: `command:${opts.targetId}`,
				bin: target.command.bin,
				args: target.command.args,
				cwd: target.command.cwd,
				env: target.command.env,
				defaultTimeoutMs: 60_000,
			});
		}
	}
}
