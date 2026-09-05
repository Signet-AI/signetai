import { describe, expect, it } from "bun:test";
import {
	apiAccountEntry,
	buildExtractionRoute,
	oauthAccountEntry,
	providerKeySecretName,
} from "./setup-inference-connect";

describe("secret naming (mirrors dashboard/daemon)", () => {
	it("providerKeySecretName matches the dashboard formula", () => {
		expect(providerKeySecretName("anthropic")).toBe("SIGNET_KEY_ANTHROPIC");
		expect(providerKeySecretName("openrouter")).toBe("SIGNET_KEY_OPENROUTER");
		expect(providerKeySecretName("google-vertex")).toBe("SIGNET_KEY_GOOGLE_VERTEX");
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
