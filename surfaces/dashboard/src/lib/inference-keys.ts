export interface ApiKeyFormat {
	readonly hint: string;
	readonly pattern: RegExp;
}

const STRICT_KEY_FORMATS: Record<string, ApiKeyFormat> = {
	anthropic: { hint: "starts with sk-ant-", pattern: /^sk-ant-/i },
	openai: { hint: "starts with sk-", pattern: /^sk-/i },
	openrouter: { hint: "starts with sk-or-", pattern: /^sk-or-/i },
	google: { hint: "starts with AIza", pattern: /^AIza/i },
	"google-vertex": { hint: "starts with AIza", pattern: /^AIza/i },
	xai: { hint: "starts with xai-", pattern: /^xai-/i },
	groq: { hint: "starts with gsk_", pattern: /^gsk_/i },
	mistral: { hint: "a Mistral platform key", pattern: /^[A-Za-z0-9_-]{20,}$/ },
	deepseek: { hint: "starts with sk-", pattern: /^sk-/i },
	together: { hint: "a Together API key", pattern: /^[A-Za-z0-9_-]{20,}$/ },
	fireworks: { hint: "a Fireworks API key", pattern: /^[A-Za-z0-9_-]{20,}$/ },
	nvidia: { hint: "starts with nvapi-", pattern: /^nvapi-/i },
};

export function apiKeyFormat(providerFamily: string): ApiKeyFormat | null {
	return STRICT_KEY_FORMATS[providerFamily] ?? null;
}

export type KeyValidationState = "empty" | "valid" | "unsure";

export function validateApiKey(providerFamily: string, value: string): KeyValidationState {
	const trimmed = value.trim();
	if (!trimmed) return "empty";
	const format = apiKeyFormat(providerFamily);
	if (!format) {
		return "unsure";
	}
	return format.pattern.test(trimmed) ? "valid" : "unsure";
}
export function providerKeySecretName(providerFamily: string): string {
	return `SIGNET_KEY_${providerFamily.replace(/[^A-Z0-9_]/gi, "_").toUpperCase()}`;
}
