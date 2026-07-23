/**
 * Per-provider API-key format hints + validation. Dependency-free so it is
 * unit-testable outside the SvelteKit runtime (api.ts pulls in $app/environment).
 *
 * Used by the connect dialog for instant client-side feedback — no network
 * round-trip. Validation is advisory: a non-match never blocks save (providers
 * change formats and custom gateways accept arbitrary keys); it only nudges.
 * Patterns reflect the common shipped key shapes as of mid-2026.
 */
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
		// No known format: never disable Connect for a non-empty key (that would
		// silently block legitimate short keys for custom gateways / some Bedrock
		// shapes). Surface it as "unsure" so the hint shows and the button stays on.
		return "unsure";
	}
	return format.pattern.test(trimmed) ? "valid" : "unsure";
}

/**
 * Stable secret name for a stored provider API key. Kept provider-keyed so a
 * user can hold one key per provider and the name is human-meaningful in the
 * secrets list. Collisions with real env vars are implausible for this prefix.
 */
export function providerKeySecretName(providerFamily: string): string {
	return `SIGNET_KEY_${providerFamily.replace(/[^A-Z0-9_]/gi, "_").toUpperCase()}`;
}
