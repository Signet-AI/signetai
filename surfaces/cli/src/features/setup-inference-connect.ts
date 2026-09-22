import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
export function connectableProviderIds(): readonly string[] {
	return builtinProviders().map((provider) => provider.id);
}
export function aggregateRecallProviderIds(): readonly string[] {
	return ["openrouter", ...LOCAL_SERVERS.map((server) => server.id)];
}
export const LOCAL_SERVERS = [
	{ id: "ollama", name: "Ollama (local)" },
	{ id: "llama-cpp", name: "llama.cpp (local)" },
	{ id: "openai-compatible", name: "OpenAI-compatible (LM Studio / gateway)" },
] as const;

export type ExtractionBackendKind = "cloud" | "local" | "acpx" | "none";
export function providerKeySecretName(family: string): string {
	return `SIGNET_KEY_${family.replace(/[^A-Z0-9_]/gi, "_").toUpperCase()}`;
}
export function apiAccountEntry(family: string): Record<string, unknown> {
	return { kind: "api", providerFamily: family, credentialRef: providerKeySecretName(family) };
}
export function oauthAccountEntry(family: string): Record<string, unknown> {
	return { kind: "subscription_session", providerFamily: family };
}

export interface ExtractionRouteOptions {
	readonly kind: ExtractionBackendKind;
	readonly executor: string;
	readonly model: string;
	readonly family?: string;
	readonly connectMethod?: "api" | "oauth";
	readonly endpoint?: string;
	readonly acpx?: Record<string, unknown>;
	readonly targetName?: string;
}

export interface ExtractionRoute {
	readonly targets: Record<string, unknown>;
	readonly accounts?: Record<string, unknown>;
	readonly workloads: Record<string, unknown>;
}
export function buildExtractionRoute(opts: ExtractionRouteOptions): ExtractionRoute {
	const targetName = opts.targetName ?? "background";
	const target: Record<string, unknown> = {
		executor: opts.executor,
		models: { default: { model: opts.model, reasoning: "medium" } },
	};
	let accounts: Record<string, unknown> | undefined;

	if (opts.kind === "cloud") {
		const family = opts.family ?? opts.executor;
		target.account = family;
		accounts = {
			[family]: opts.connectMethod === "oauth" ? oauthAccountEntry(family) : apiAccountEntry(family),
		};
	} else if (opts.kind === "local") {
		if (opts.executor === "openai-compatible") {
			target.endpoint = opts.endpoint ?? "http://127.0.0.1:1234/v1";
		}
	} else if (opts.kind === "acpx") {
		if (opts.acpx) target.acpx = opts.acpx;
	}

	return {
		targets: { [targetName]: target },
		...(accounts ? { accounts } : {}),
		workloads: { memoryExtraction: { target: `${targetName}/default` } },
	};
}
export function applyInferenceRoute(
	config: Record<string, unknown>,
	route: { targets: Record<string, unknown>; accounts?: Record<string, unknown>; workloads: Record<string, unknown> },
): void {
	const existing = (config.inference ?? {}) as Record<string, unknown>;
	const targets = { ...((existing.targets as Record<string, unknown>) ?? {}), ...route.targets };
	const workloads = { ...((existing.workloads as Record<string, unknown>) ?? {}), ...route.workloads };
	const accounts = route.accounts
		? { ...((existing.accounts as Record<string, unknown>) ?? {}), ...route.accounts }
		: (existing.accounts as Record<string, unknown> | undefined);
	config.inference = { ...existing, targets, workloads, ...(accounts ? { accounts } : {}) };
}
