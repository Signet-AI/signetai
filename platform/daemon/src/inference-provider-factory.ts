import {
	type Api,
	type Model,
	type OAuthCredentials,
	type ThinkingLevel,
	getSupportedThinkingLevels,
} from "@earendil-works/pi-ai";
import { getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import type { PipelineClaudeCodeConfig, RoutingAccountConfig, RoutingConfig } from "@signet/core";
import { type PiExecutorKind, createPiModelProvider } from "./pipeline/pi-provider";
import type { AcpxHooksMode, StreamCapableLlmProvider } from "./pipeline/provider";
import { createAcpxProvider } from "./pipeline/provider";

export interface CreateRoutingProviderOptions {
	readonly config: RoutingConfig;
	readonly targetId: string;
	readonly modelId: string;
	readonly acpxHooks?: AcpxHooksMode;
	/** Per-run ACPX arguments (for example, a scoped ephemeral MCP config). */
	readonly acpxExtraArgs?: readonly string[];
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

function catalogModel(providerFamily: string, modelId: string): Model<Api> | undefined {
	if (!(getBuiltinProviders() as readonly string[]).includes(providerFamily)) return undefined;
	const models = getBuiltinModels(providerFamily as Parameters<typeof getBuiltinModels>[0]) as Model<Api>[];
	return models.find((candidate) => candidate.id === modelId);
}

function resolveProviderReasoning(
	target: RoutingConfig["targets"][string],
	model: NonNullable<RoutingConfig["targets"][string]>["models"][string],
	piModel: Model<Api> | undefined,
): ThinkingLevel | undefined {
	if (target.openrouter?.reasoning?.enabled) return "medium";
	if (model.reasoning === "high") return "high";
	if (model.reasoning !== "low") return undefined;
	// Pi raises a requested low level to high when a model has no low mode.
	// Omit reasoning for a latency-sensitive low target in that case: Pi then
	// emits the model's native disabled-thinking representation rather than
	// silently spending its higher-reasoning tier.
	return piModel && !getSupportedThinkingLevels(piModel).includes("low") ? undefined : "low";
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
			extraArgs: [...(target.acpx.extraArgs ?? []), ...(opts.acpxExtraArgs ?? [])],
			model: model.model,
		});
	}

	if (FOLDED_EXECUTORS.has(target.executor)) {
		throw new Error(
			`Routing executor "${target.executor}" has been folded into the Pi + ACPX backends (#947). Reconfigure target "${opts.targetId}" to use one of: anthropic, openrouter, ollama, llama-cpp, openai-compatible, acpx. For claude-code/codex/opencode use 'executor: acpx' with an 'acpx: { agent: <name> }' block; see https://docs.signetai.sh/upgrading/. Restart the daemon to re-run the automatic one-time config migration.`,
		);
	}

	const account = target.account ? opts.config.accounts[target.account] : undefined;
	const providerFamily = account?.providerFamily ?? target.executor;
	if (
		!CUSTOM_PI_EXECUTORS.has(target.executor) &&
		!(getBuiltinProviders() as readonly string[]).includes(providerFamily)
	) {
		throw new Error(`Unsupported routing executor "${target.executor}" for target ${opts.targetId}`);
	}

	const credential = await opts.resolveCredential(account);
	// A custom transport can still use a Pi catalog model's protocol metadata.
	// This matters for compatible gateways whose model needs a non-generic tool
	// or thinking wire format, while the target endpoint remains authoritative.
	const piModel = catalogModel(providerFamily, model.model);
	if (!piModel && !CUSTOM_PI_EXECUTORS.has(target.executor)) {
		throw new Error(`Unknown pi-ai model "${model.model}" for provider "${providerFamily}"`);
	}

	return createPiModelProvider({
		executor: target.executor as PiExecutorKind,
		providerFamily,
		model: model.model,
		piModel,
		// Catalog targets use their provider's known endpoint. A custom endpoint
		// still needs a reachability probe even when its model has catalog metadata.
		skipAvailabilityProbe: piModel !== undefined && !target.endpoint,
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
		reasoning: resolveProviderReasoning(target, model, piModel),
		contextWindow: model.contextWindow,
		name: `${target.executor}:${model.model}`,
		defaultTimeoutMs: 60_000,
	});
}
