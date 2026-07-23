import { type Api, type Model, type OAuthCredentials, getModels, getProviders } from "@earendil-works/pi-ai";
import { getOAuthProvider } from "@earendil-works/pi-ai/oauth";
import type { PipelineClaudeCodeConfig, RoutingAccountConfig, RoutingConfig } from "@signet/core";
import { type PiExecutorKind, createPiModelProvider } from "./pipeline/pi-provider";
import type { AcpxHooksMode, StreamCapableLlmProvider } from "./pipeline/provider";
import { createAcpxProvider } from "./pipeline/provider";

export interface CreateRoutingProviderOptions {
	readonly config: RoutingConfig;
	readonly targetId: string;
	readonly modelId: string;
	readonly acpxHooks?: AcpxHooksMode;
	readonly claudeCode?: PipelineClaudeCodeConfig;
	resolveCredential(account: RoutingAccountConfig | undefined): Promise<ResolvedInferenceCredential | undefined>;
}

export interface ResolvedInferenceCredential {
	readonly apiKey: string;
	readonly oauthCredentials?: OAuthCredentials;
}

/**
 * Executors that have been folded into the Pi + ACPX backends (#947).
 * Encountering one means the install's agent.yaml was not migrated; the daemon
 * fails with a structured error rather than silently degrading.
 */
const FOLDED_EXECUTORS = new Set(["claude-code", "codex", "opencode", "command"]);

const CUSTOM_PI_EXECUTORS = new Set(["anthropic", "openrouter", "ollama", "llama-cpp", "openai-compatible"]);

function catalogModel(
	providerFamily: string,
	modelId: string,
	credential: ResolvedInferenceCredential | undefined,
): Model<Api> | undefined {
	if (!(getProviders() as readonly string[]).includes(providerFamily)) return undefined;
	let models = (getModels as (provider: string) => Model<Api>[])(providerFamily);
	const oauthProvider = getOAuthProvider(providerFamily);
	if (oauthProvider?.modifyModels && credential?.oauthCredentials) {
		models = oauthProvider.modifyModels(models, credential.oauthCredentials);
	}
	return models.find((candidate) => candidate.id === modelId);
}

export async function createRoutingProvider(opts: CreateRoutingProviderOptions): Promise<StreamCapableLlmProvider> {
	const target = opts.config.targets[opts.targetId];
	const model = target?.models[opts.modelId];
	if (!target || !model) {
		throw new Error(`Unknown routing target ${opts.targetId}/${opts.modelId}`);
	}

	if (target.executor === "acpx") {
		if (!target.acpx) throw new Error(`Missing ACPX config for target ${opts.targetId}`);
		return createAcpxProvider({
			...target.acpx,
			...(opts.acpxHooks ? { hooks: opts.acpxHooks } : {}),
			model: model.model,
		});
	}

	if (FOLDED_EXECUTORS.has(target.executor)) {
		throw new Error(
			`Routing executor "${target.executor}" has been folded into the Pi + ACPX backends (#947). Reconfigure target "${opts.targetId}" to use one of: anthropic, openrouter, ollama, llama-cpp, openai-compatible, acpx. For claude-code/codex/opencode use 'executor: acpx' with an 'acpx: { agent: <name> }' block; see docs/UPGRADING.md. Restart the daemon to re-run the automatic one-time config migration.`,
		);
	}

	const account = target.account ? opts.config.accounts[target.account] : undefined;
	const providerFamily = account?.providerFamily ?? target.executor;
	if (!CUSTOM_PI_EXECUTORS.has(target.executor) && !(getProviders() as readonly string[]).includes(providerFamily)) {
		throw new Error(`Unsupported routing executor "${target.executor}" for target ${opts.targetId}`);
	}

	const credential = await opts.resolveCredential(account);
	const piModel = CUSTOM_PI_EXECUTORS.has(target.executor)
		? undefined
		: catalogModel(providerFamily, model.model, credential);
	if (!piModel && !CUSTOM_PI_EXECUTORS.has(target.executor)) {
		throw new Error(`Unknown pi-ai model "${model.model}" for provider "${providerFamily}"`);
	}

	return createPiModelProvider({
		executor: target.executor as PiExecutorKind,
		providerFamily,
		model: model.model,
		piModel,
		skipAvailabilityProbe: piModel !== undefined,
		baseUrl: target.endpoint,
		apiKey: credential?.apiKey,
		// Map routing intent to a pi-ai ThinkingLevel (forwarded per-call as
		// options.reasoning). model.reasoning (RoutingReasoningDepth) defaults to
		// "medium" for every parsed model, so it cannot alone signal "enable
		// thinking" without flipping a costly default on for all routed calls.
		// Treat only explicit non-default signals as intent to emit thinking:
		// the documented OpenRouter reasoning block, or a deliberately-set
		// "high" depth. Previously this compared to a nonexistent "deep"
		// value (TS2367) and never produced a usable level.
		reasoning: target.openrouter?.reasoning?.enabled ? "medium" : model.reasoning === "high" ? "high" : undefined,
		contextWindow: model.contextWindow,
		name: `${target.executor}:${model.model}`,
		defaultTimeoutMs: 60_000,
	});
}
