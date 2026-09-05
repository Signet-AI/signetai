/** Canonical routing fragments for scripted setup. Provider login belongs to the daemon. */
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";

/** All connectable provider ids (OAuth + API-key families). */
export function connectableProviderIds(): readonly string[] {
	return builtinProviders().map((provider) => provider.id);
}

/**
 * Provider ids valid for aggregate recall during fresh setup.
 *
 * The dashboard can route any provider that is already connected. Fresh setup
 * cannot safely serialize a second provider credential into a headless plan,
 * so it only offers the keyless local servers plus OpenRouter, whose existing
 * `OPENROUTER_API_KEY` environment contract is understood by the router.
 */
export function aggregateRecallProviderIds(): readonly string[] {
	return ["openrouter", ...LOCAL_SERVERS.map((server) => server.id)];
}

/** Local keyless servers offered as extraction backends. */
export const LOCAL_SERVERS = [
	{ id: "ollama", name: "Ollama (local)" },
	{ id: "llama-cpp", name: "llama.cpp (local)" },
	{ id: "openai-compatible", name: "OpenAI-compatible (LM Studio / gateway)" },
] as const;

export type ExtractionBackendKind = "cloud" | "local" | "acpx" | "none";

/**
 * Stable secret name for a stored provider API key. Mirrors the dashboard's
 * `providerKeySecretName` so the daemon resolves the same credential the
 * dashboard would write.
 */
export function providerKeySecretName(family: string): string {
	return `SIGNET_KEY_${family.replace(/[^A-Z0-9_]/gi, "_").toUpperCase()}`;
}

/** Routing account entry for an API-key-connected provider. */
export function apiAccountEntry(family: string): Record<string, unknown> {
	return { kind: "api", providerFamily: family, credentialRef: providerKeySecretName(family) };
}

/** Routing account entry for an OAuth-connected (subscription) provider. */
export function oauthAccountEntry(family: string): Record<string, unknown> {
	// No credentialRef — the daemon resolves the OAuth credential from the
	// SIGNET_OAUTH_* secret at call time (isOAuthBackedAccount recognizes
	// kind: subscription_session).
	return { kind: "subscription_session", providerFamily: family };
}

export interface ExtractionRouteOptions {
	/** Backend kind: determines target shape. */
	readonly kind: ExtractionBackendKind;
	/** pi-ai family / executor id (cloud provider, local server, or "acpx"). */
	readonly executor: string;
	readonly model: string;
	/** Cloud provider family; used to name + author the account entry. */
	readonly family?: string;
	/** "api" | "oauth" — how a cloud provider was connected. */
	readonly connectMethod?: "api" | "oauth";
	/** openai-compatible gateway URL. */
	readonly endpoint?: string;
	/** ACPX agent block (agent/bin/...). */
	readonly acpx?: Record<string, unknown>;
	/** Target name in inference.targets (default "background"). */
	readonly targetName?: string;
}

export interface ExtractionRoute {
	readonly targets: Record<string, unknown>;
	readonly accounts?: Record<string, unknown>;
	readonly workloads: Record<string, unknown>;
}

/**
 * Build the modern routing-config fragment that binds an extraction backend to
 * the memoryExtraction workload. Mirrors the dashboard's writeTarget +
 * ensureAccount + linkAccount* so the resulting agent.yaml is identical to what
 * the dashboard produces for the same selection.
 */
export function buildExtractionRoute(opts: ExtractionRouteOptions): ExtractionRoute {
	const targetName = opts.targetName ?? "background";
	const target: Record<string, unknown> = {
		executor: opts.executor,
		models: { default: { model: opts.model, reasoning: "medium" } },
	};
	let accounts: Record<string, unknown> | undefined;

	if (opts.kind === "cloud") {
		const family = opts.family ?? opts.executor;
		// Provider backends reference an account by family; the credential is
		// resolved from the secret the connect step wrote.
		target.account = family;
		accounts = {
			[family]: opts.connectMethod === "oauth" ? oauthAccountEntry(family) : apiAccountEntry(family),
		};
	} else if (opts.kind === "local") {
		if (opts.executor === "openai-compatible") {
			target.endpoint = opts.endpoint ?? "http://127.0.0.1:1234/v1";
		}
		// ollama / llama-cpp / openai-compatible(localhost) are keyless.
	} else if (opts.kind === "acpx") {
		if (opts.acpx) target.acpx = opts.acpx;
	}

	return {
		targets: { [targetName]: target },
		...(accounts ? { accounts } : {}),
		workloads: { memoryExtraction: { target: `${targetName}/default` } },
	};
}

/** Merge an inference route fragment (targets/accounts/workloads) into
 * config.inference, creating it if absent. Used for the extraction target and
 * (via buildSetupAggregateRecall) the aggregate-recall target. */
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
