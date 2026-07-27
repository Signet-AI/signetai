/**
 * Provider-connect model for `signet setup` — mirrors the dashboard's
 * InferenceSection so the CLI offers the same provider/login UX.
 *
 * The dashboard drives everything through the daemon HTTP API against a live
 * daemon. This module holds the PURE pieces (catalog, naming, config shapes)
 * so they are unit-testable; the imperative connect steps (OAuth SSE, secret
 * writes) live in setup-connect.ts and talk to the daemon the same way the
 * dashboard does. Nothing here touches the network or filesystem.
 *
 * Config shapes are verified against:
 *  - dashboard `InferenceSection.writeTarget` / `ensureAccount`
 *  - dashboard `ConnectProviderDialog.linkAccountForApiKey` / `linkOAuthAccountForProvider`
 *  - daemon `inference-oauth.secretName` (SIGNET_OAUTH_<hex>) and `secrets.putSecret`
 */

/** A cloud provider the user can connect via API key and/or OAuth login. */
export interface ConnectableProvider {
	readonly id: string; // pi-ai family id; also the routing executor
	readonly name: string;
	readonly supportsOAuth: boolean;
	readonly supportsApiKey: boolean;
}

/**
 * Curated connectable providers. Mirrors the dashboard's featured list +
 * auth capabilities (pi-ai OAuth providers: anthropic, openai-codex,
 * github-copilot). The live model catalog is fetched from the daemon after it
 * starts; this list only drives the selection menu.
 */
export const CONNECTABLE_PROVIDERS: readonly ConnectableProvider[] = [
	{ id: "anthropic", name: "Anthropic (Claude)", supportsOAuth: true, supportsApiKey: true },
	{ id: "openai-codex", name: "ChatGPT / Codex (subscription)", supportsOAuth: true, supportsApiKey: false },
	{ id: "github-copilot", name: "GitHub Copilot", supportsOAuth: true, supportsApiKey: false },
	{ id: "openrouter", name: "OpenRouter", supportsOAuth: false, supportsApiKey: true },
	{ id: "openai", name: "OpenAI", supportsOAuth: false, supportsApiKey: true },
	{ id: "google", name: "Google (Gemini)", supportsOAuth: false, supportsApiKey: true },
	{ id: "xai", name: "xAI (Grok)", supportsOAuth: false, supportsApiKey: true },
	{ id: "groq", name: "Groq", supportsOAuth: false, supportsApiKey: true },
	{ id: "deepseek", name: "DeepSeek", supportsOAuth: false, supportsApiKey: true },
	{ id: "mistral", name: "Mistral", supportsOAuth: false, supportsApiKey: true },
];

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
			[family]:
				opts.connectMethod === "oauth" ? oauthAccountEntry(family) : apiAccountEntry(family),
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

/** Find a connectable provider by id (OAuth/API-key menu uses this). */
export function findConnectableProvider(id: string): ConnectableProvider | undefined {
	return CONNECTABLE_PROVIDERS.find((p) => p.id === id);
}
