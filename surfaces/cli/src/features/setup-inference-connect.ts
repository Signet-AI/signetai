/**
 * Provider-connect model for `signet setup` — sources providers and models
 * directly from pi-ai (the SAME catalog the dashboard and daemon use), so
 * there is a single source of truth and no hand-maintained list to drift.
 *
 * The dashboard drives connect through the daemon HTTP API; this module holds
 * the PURE pieces (catalog lookups, naming, config shapes) for unit testing.
 * The imperative connect steps (OAuth SSE, secret writes) live in
 * setup-connect.ts and talk to the daemon the same way the dashboard does.
 *
 * Config shapes are verified against:
 *  - dashboard `InferenceSection.writeTarget` / `ensureAccount`
 *  - dashboard `ConnectProviderDialog.linkAccountForApiKey` / `linkOAuthAccountForProvider`
 *  - daemon `inference-oauth.secretName` (SIGNET_OAUTH_<hex>) and `secrets.putSecret`
 */
import { getModels, getProviders } from "@earendil-works/pi-ai";
import { getOAuthProviders } from "@earendil-works/pi-ai/oauth";

export interface ProviderOption {
	readonly id: string;
	readonly name: string;
}

function titleCase(id: string): string {
	return id
		.split(/[-_]/)
		.map((w) => (w.length > 0 ? w[0].toUpperCase() + w.slice(1) : w))
		.join(" ");
}

/**
 * Providers that accept a login (OAuth subscription) — from pi-ai's OAuth
 * registry (Claude Max / ChatGPT / GitHub Copilot). These are the only ids the
 * daemon's `/api/inference/oauth/login/:id` will accept.
 */
export function oauthProviderOptions(): ProviderOption[] {
	return getOAuthProviders().map((p) => ({ id: p.id, name: p.name }));
}

/**
 * Providers that accept a pasted API key — the pi-ai catalog families, minus the
 * OAuth-only subscription providers (which have no API-key surface). anthropic
 * is kept because it accepts BOTH OAuth and an API key.
 */
export function apiKeyProviderOptions(): ProviderOption[] {
	const oauthOnly = getOAuthProviders()
		.map((p) => p.id)
		.filter((id) => id !== "anthropic");
	return getProviders()
		.filter((id) => !oauthOnly.includes(id))
		.map((id) => ({ id, name: titleCase(id) }));
}

/**
 * The real model list for a provider family — from pi-ai's model registry, the
 * same data the dashboard's model picker uses. Never a guess.
 */
export function modelOptions(family: string): ProviderOption[] {
	return getModels(family).map((m) => ({ id: m.id, name: m.name || m.id }));
}

/** All connectable provider ids (OAuth + API-key families). */
export function connectableProviderIds(): readonly string[] {
	return [...new Set([...getProviders(), ...getOAuthProviders().map((p) => p.id)])];
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

/**
 * Stable secret name for stored OAuth credentials. Mirrors the daemon's
 * `inference-oauth.secretName` (SIGNET_OAUTH_<UPPERHEX>) so the daemon's
 * `loadOAuthCredentials` finds what setup wrote.
 */
export function oauthSecretName(providerId: string): string {
	return `SIGNET_OAUTH_${Buffer.from(providerId, "utf8").toString("hex").toUpperCase()}`;
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
			target.endpoint = opts.endpoint ?? "http://localhost:1234/v1";
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
