import type { PipelineClaudeCodeConfig, RoutingConfig } from "@signet/core";
import type { AcpxHooksMode, StreamCapableLlmProvider } from "./pipeline/provider";
import { createAcpxProvider } from "./pipeline/provider";
import { createPiModelProvider, type PiExecutorKind } from "./pipeline/pi-provider";

export interface CreateRoutingProviderOptions {
	readonly config: RoutingConfig;
	readonly targetId: string;
	readonly modelId: string;
	readonly acpxHooks?: AcpxHooksMode;
	readonly claudeCode?: PipelineClaudeCodeConfig;
	resolveCredential(credentialRef: string | undefined): Promise<string | undefined>;
}

/**
 * Executors that have been folded into the Pi + ACPX backends (#947).
 * Encountering one means the install's agent.yaml was not migrated; the daemon
 * fails with a structured error rather than silently degrading.
 */
const FOLDED_EXECUTORS = new Set(["claude-code", "codex", "opencode", "command"]);

/** Executors routed through the Pi (pi-ai) backend. */
const PI_EXECUTORS = new Set<PiExecutorKind>([
	"anthropic",
	"openrouter",
	"ollama",
	"llama-cpp",
	"openai-compatible",
]);

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
			`Routing executor "${target.executor}" has been folded into the Pi + ACPX backends (#947). ` +
				`Reconfigure target "${opts.targetId}" to use one of: anthropic, openrouter, ollama, llama-cpp, openai-compatible, acpx. ` +
				`For claude-code/codex/opencode use 'executor: acpx' with an 'acpx: { agent: <name> }' block; ` +
				`see docs/UPGRADING.md. Restart the daemon to re-run the automatic one-time config migration.`,
		);
	}

	if (!PI_EXECUTORS.has(target.executor as PiExecutorKind)) {
		throw new Error(`Unsupported routing executor "${target.executor}" for target ${opts.targetId}`);
	}

	const account = target.account ? opts.config.accounts[target.account] : undefined;
	const credential = await opts.resolveCredential(account?.credentialRef);

	return createPiModelProvider({
		executor: target.executor as PiExecutorKind,
		model: model.model,
		baseUrl: target.endpoint,
		apiKey: credential,
		reasoning:
			target.openrouter?.reasoning?.enabled ??
			(model.reasoning !== undefined ? model.reasoning === "deep" : undefined),
		contextWindow: model.contextWindow,
		name: `${target.executor}:${model.model}`,
		defaultTimeoutMs: 60_000,
	});
}
