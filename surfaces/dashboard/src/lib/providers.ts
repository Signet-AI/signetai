import type { InferenceCatalog } from "@/lib/api";
export const OAUTH_ONLY_PROVIDERS = new Set(["openai-codex", "github-copilot"]);
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
export const LOCAL_EXECUTORS = [
	{ value: "openai-compatible", label: "OpenAI-compatible (LM Studio / gateway)" },
	{ value: "ollama", label: "Ollama (local)" },
	{ value: "llama-cpp", label: "llama.cpp (local)" },
] as const;

export const ACPX_AGENTS = ["claude", "codex", "opencode", "gemini", "pi", "openclaw", "kimi"] as const;

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
export function isProviderConnected(accounts: AccountsMap, family: string): boolean {
	for (const a of Object.values(accounts)) {
		if (a.providerFamily !== family) continue;
		if (a.kind === "subscription_session") return true;
		if (a.kind === "api" && a.credentialRef) return true;
	}
	return false;
}
export function accountForFamily(accounts: AccountsMap, family: string): string | null {
	const names = Object.keys(accounts).filter((n) => accounts[n].providerFamily === family);
	if (names.length === 0) return null;
	return names.includes(family) ? family : names[0];
}
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
		return {
			id,
			name: PROVIDER_NAMES[id] ?? titleCase(id),
			supportsOAuth,
			supportsApiKey,
			connected,
			isOAuth: supportsOAuth,
		};
	});
}
export function backendKind(exec: string): "none" | "provider" | "local" | "acpx" {
	if (!exec) return "none";
	if (exec === "acpx") return "acpx";
	if (LOCAL_EXECUTORS.some((e) => e.value === exec)) return "local";
	return "provider";
}
export function backendFamily(exec: string): string {
	if (backendKind(exec) === "local") return exec === "openai-compatible" ? "openai" : "";
	return exec;
}
export function secretNameFor(exec: string): string {
	const family = backendFamily(exec) || "KEY";
	return `${family.replace(/-/g, "_").toUpperCase()}_API_KEY`;
}
