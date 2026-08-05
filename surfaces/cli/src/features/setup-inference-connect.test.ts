import { describe, expect, it } from "bun:test";
import {
	apiAccountEntry,
	apiKeyProviderOptions,
	buildExtractionRoute,
	modelOptions,
	oauthAccountEntry,
	oauthProviderOptions,
	oauthSecretName,
	providerKeySecretName,
} from "./setup-inference-connect";

describe("provider catalog (sourced from pi-ai)", () => {
	it("lists the OAuth-login providers from pi-ai", () => {
		const ids = oauthProviderOptions()
			.map((p) => p.id)
			.sort();
		// pi-ai 0.83 OAuth catalog (auth.oauth on the runtime providers):
		// anthropic, openai-codex, github-copilot, xai, radius, kimi-coding, openrouter.
		expect(ids).toEqual(["anthropic", "github-copilot", "kimi-coding", "openai-codex", "openrouter", "radius", "xai"]);
	});

	it("excludes OAuth-only providers from the API-key list but keeps anthropic", () => {
		const ids = apiKeyProviderOptions().map((p) => p.id);
		expect(ids).toContain("anthropic");
		expect(ids).toContain("openrouter");
		expect(ids).toContain("github-copilot");
		// openai-codex is the only subscription-only provider with no API-key surface.
		expect(ids).not.toContain("openai-codex");
	});

	it("returns the real model list for a family (no guesses)", () => {
		const models = modelOptions("anthropic");
		expect(models.length).toBeGreaterThan(0);
		expect(models.some((m) => m.id.includes("claude"))).toBe(true);
	});
});

describe("secret naming (mirrors dashboard/daemon)", () => {
	it("providerKeySecretName matches the dashboard formula", () => {
		expect(providerKeySecretName("anthropic")).toBe("SIGNET_KEY_ANTHROPIC");
		expect(providerKeySecretName("openrouter")).toBe("SIGNET_KEY_OPENROUTER");
		expect(providerKeySecretName("google-vertex")).toBe("SIGNET_KEY_GOOGLE_VERTEX");
	});

	it("oauthSecretName matches the daemon formula (SIGNET_OAUTH_<upperhex>)", () => {
		expect(oauthSecretName("anthropic")).toBe(
			`SIGNET_OAUTH_${Buffer.from("anthropic", "utf8").toString("hex").toUpperCase()}`,
		);
		expect(oauthSecretName("anthropic")).not.toBe(oauthSecretName("openai-codex"));
	});
});

describe("account entries", () => {
	it("api account references the key secret", () => {
		expect(apiAccountEntry("openrouter")).toEqual({
			kind: "api",
			providerFamily: "openrouter",
			credentialRef: "SIGNET_KEY_OPENROUTER",
		});
	});

	it("oauth account omits credentialRef (subscription_session)", () => {
		expect(oauthAccountEntry("anthropic")).toEqual({
			kind: "subscription_session",
			providerFamily: "anthropic",
		});
		expect(oauthAccountEntry("anthropic")).not.toHaveProperty("credentialRef");
	});
});

describe("buildExtractionRoute", () => {
	it("binds an API-key cloud provider to memoryExtraction with an account", () => {
		const route = buildExtractionRoute({
			kind: "cloud",
			executor: "openrouter",
			family: "openrouter",
			connectMethod: "api",
			model: "anthropic/claude-3.5-sonnet",
		});
		expect(route.targets.background).toMatchObject({
			executor: "openrouter",
			account: "openrouter",
			models: { default: { model: "anthropic/claude-3.5-sonnet", reasoning: "medium" } },
		});
		expect(route.accounts?.openrouter).toEqual({
			kind: "api",
			providerFamily: "openrouter",
			credentialRef: "SIGNET_KEY_OPENROUTER",
		});
		expect(route.workloads.memoryExtraction).toEqual({ target: "background/default" });
	});

	it("binds an OAuth cloud provider as subscription_session", () => {
		const route = buildExtractionRoute({
			kind: "cloud",
			executor: "anthropic",
			family: "anthropic",
			connectMethod: "oauth",
			model: "claude-3-5-sonnet-20241022",
		});
		expect(route.accounts?.anthropic).toEqual({ kind: "subscription_session", providerFamily: "anthropic" });
	});

	it("local openai-compatible carries an endpoint", () => {
		const route = buildExtractionRoute({
			kind: "local",
			executor: "openai-compatible",
			model: "m",
			endpoint: "http://gw:8000/v1",
		});
		expect(route.targets.background).toMatchObject({ executor: "openai-compatible", endpoint: "http://gw:8000/v1" });
	});
});
