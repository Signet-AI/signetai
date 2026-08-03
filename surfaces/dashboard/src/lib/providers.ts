/**
 * Provider catalog logic — ported from the old Svelte dashboard's
 * InferenceSection. The connect wall is built from the LIVE pi-ai catalog
 * (no hand-picked allowlist): a provider added upstream shows up without a
 * dashboard change. These maps only control display names + ordering.
 */
import type { InferenceCatalog } from "@/lib/api";

/** OAuth-only subscription providers (no direct API-key path). */
export const OAUTH_ONLY_PROVIDERS = new Set(["openai-codex", "github-copilot"]);

/** Friendly names for known provider families; others fall back to title case. */
export const PROVIDER_NAMES: Record<string, string> = {
	anthropic: "Anthropic (Claude)",
	"openai-codex": "ChatGPT / Codex",
	"github-copilot": "GitHub Copilot",
	openrouter: "OpenRouter",
	openai: "OpenAI",
	google: "Google (Gemini)",
	xai: "xAI (Grok)",
	groq: "Groq",
	mistral: "Mistral",
	deepseek: "DeepSeek",
	zai: "ZAI",
	"zai-coding-cn": "ZAI Coding (CN)",
	voyage: "Voyage AI",
	cohere: "Cohere",
	together: "Together AI",
	fireworks: "Fireworks AI",
	perplexity: "Perplexity",
	ollama: "Ollama",
};

/** Known providers float to the top in this order; everything else sorts after. */
export const FEATURED_ORDER = [
	"anthropic",
	"openai-codex",
	"github-copilot",
	"openrouter",
	"openai",
	"google",
	"xai",
	"groq",
	"mistral",
	"deepseek",
	"zai",
	"zai-coding-cn",
];

/** Local OpenAI-compatible executors (backend pickers include these). */
export const LOCAL_EXECUTORS = [
	{ value: "openai-compatible", label: "OpenAI-compatible (LM Studio / gateway)" },
	{ value: "ollama", label: "Ollama (local)" },
	{ value: "llama-cpp", label: "llama.cpp (local)" },
] as const;

export const ACPX_AGENTS = ["claude", "codex", "opencode", "gemini", "pi", "openclaw"] as const;

export interface ConnectableProvider {
	id: string;
	name: string;
	supportsOAuth: boolean;
	supportsApiKey: boolean;
	connected: boolean;
	isOAuth: boolean;
}

export interface InferenceAccount {
	kind?: string;
	providerFamily?: string;
	credentialRef?: string;
}

export type AccountsMap = Record<string, InferenceAccount>;

export function titleCase(id: string): string {
	return id.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** True if any account backs this provider family with usable credentials
 * (api with a credentialRef, or an OAuth subscription_session). */
export function isProviderConnected(accounts: AccountsMap, family: string): boolean {
	for (const a of Object.values(accounts)) {
		if (a.providerFamily !== family) continue;
		if (a.kind === "subscription_session") return true;
		if (a.kind === "api" && a.credentialRef) return true;
	}
	return false;
}

/** Pick the account name backing a provider family — prefer the literal
 * family name, else the first account with that family. */
export function accountForFamily(accounts: AccountsMap, family: string): string | null {
	const names = Object.keys(accounts).filter((n) => accounts[n].providerFamily === family);
	if (names.length === 0) return null;
	return names.includes(family) ? family : names[0];
}

/** Build the connect wall from the live catalog + OAuth provider statuses. */
export function connectableProviders(catalog: InferenceCatalog | null, accounts: AccountsMap): ConnectableProvider[] {
	if (!catalog) return [];
	const oauthIds = new Set(catalog.oauthProviders.map((p) => p.id));
	const oauthStatus = new Map(catalog.oauthProviders.map((p) => [p.id, p] as const));
	const allIds = new Set<string>([...catalog.providers, ...oauthIds]);
	const sortedIds = [...allIds].sort((a, b) => {
		const ia = FEATURED_ORDER.indexOf(a);
		const ib = FEATURED_ORDER.indexOf(b);
		if (ia !== -1 && ib !== -1) return ia - ib;
		if (ia !== -1) return -1;
		if (ib !== -1) return 1;
		return a.localeCompare(b);
	});
	return sortedIds.map((id) => {
		const supportsOAuth = oauthIds.has(id);
		const supportsApiKey = catalog.providers.includes(id) && !OAUTH_ONLY_PROVIDERS.has(id);
		const connected = supportsOAuth
			? (oauthStatus.get(id)?.connected ?? false) || isProviderConnected(accounts, id)
			: isProviderConnected(accounts, id);
		return { id, name: PROVIDER_NAMES[id] ?? titleCase(id), supportsOAuth, supportsApiKey, connected, isOAuth: supportsOAuth };
	});
}

/** Classify a stored executor value into a backend kind. */
export function backendKind(exec: string): "none" | "provider" | "local" | "acpx" {
	if (!exec) return "none";
	if (exec === "acpx") return "acpx";
	if (LOCAL_EXECUTORS.some((e) => e.value === exec)) return "local";
	return "provider";
}

/** Catalog family whose models apply to an executor. openai-compatible local
 * servers map to the OpenAI catalog; ollama/llama-cpp have no catalog. */
export function backendFamily(exec: string): string {
	if (backendKind(exec) === "local") return exec === "openai-compatible" ? "openai" : "";
	return exec;
}

/** Conventional secret name hint for an executor's provider family. */
export function secretNameFor(exec: string): string {
	const family = backendFamily(exec) || "KEY";
	return `${family.replace(/-/g, "_").toUpperCase()}_API_KEY`;
}
