import { describe, expect, test } from "bun:test";
import { apiKeyFormat, providerKeySecretName, validateApiKey } from "./inference-keys";

// The connect dialog's instant key feedback (#966/#968 UI half). Validation is
// advisory — a non-match never blocks save, it only nudges with a format hint.
describe("api key validation", () => {
	test("recognizes known provider key shapes", () => {
		expect(validateApiKey("anthropic", "sk-ant-api03-xxxxxxxx")).toBe("valid");
		expect(validateApiKey("openai", "sk-proj-deadbeef")).toBe("valid");
		expect(validateApiKey("openrouter", "sk-or-v1-abc")).toBe("valid");
		expect(validateApiKey("google", "AIzaSyXXXXXXXX")).toBe("valid");
		expect(validateApiKey("xai", "xai-abcdef")).toBe("valid");
		expect(validateApiKey("groq", "gsk_abc123")).toBe("valid");
	});

	test("flags format mismatches as unsure, never blocks", () => {
		// A real-looking key that doesn't match the usual prefix.
		expect(validateApiKey("anthropic", "not-an-anthropic-key")).toBe("unsure");
		// Empty is the only state that disables the connect button.
		expect(validateApiKey("anthropic", "   ")).toBe("empty");
		expect(validateApiKey("anthropic", "")).toBe("empty");
	});

	test("falls back leniently for providers without a known prefix", () => {
		// A provider we have no strict pattern for: never disable Connect on a
		// non-empty key (legitimate short keys for custom gateways / some Bedrock
		// shapes). Surface "unsure" so the hint shows and the button stays on.
		expect(validateApiKey("amazon-bedrock", "a".repeat(24))).toBe("unsure");
		expect(validateApiKey("amazon-bedrock", "short")).toBe("unsure");
		expect(validateApiKey("amazon-bedrock", "")).toBe("empty");
		expect(apiKeyFormat("amazon-bedrock")).toBeNull();
		// Providers with a lenient length-only pattern still validate honestly.
		expect(validateApiKey("together", "a".repeat(24))).toBe("valid");
		expect(apiKeyFormat("together")?.hint).toBe("a Together API key");
	});

	test("trims whitespace before checking", () => {
		// Paste often includes a trailing newline/space.
		expect(validateApiKey("openrouter", "  sk-or-v1-abc\n")).toBe("valid");
	});
});

describe("provider key secret naming", () => {
	test("produces stable, human-meaningful, uppercase secret names", () => {
		expect(providerKeySecretName("anthropic")).toBe("SIGNET_KEY_ANTHROPIC");
		expect(providerKeySecretName("openrouter")).toBe("SIGNET_KEY_OPENROUTER");
	});

	test("sanitizes non-alphanumeric families", () => {
		// google-vertex → GOOGLE_VERTEX so the secret name stays a valid env/secret key.
		expect(providerKeySecretName("google-vertex")).toBe("SIGNET_KEY_GOOGLE_VERTEX");
	});
});
