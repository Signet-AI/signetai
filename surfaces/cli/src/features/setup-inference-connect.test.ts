import { describe, expect, it } from "bun:test";
import {
	CONNECTABLE_PROVIDERS,
	apiAccountEntry,
	buildExtractionRoute,
	findConnectableProvider,
	oauthAccountEntry,
	oauthSecretName,
	providerKeySecretName,
} from "./setup-inference-connect";

describe("provider catalog", () => {
	it("marks the three pi-ai OAuth providers", () => {
		const oauth = CONNECTABLE_PROVIDERS.filter((p) => p.supportsOAuth).map((p) => p.id);
		expect(oauth.sort()).toEqual(["anthropic", "github-copilot", "openai-codex"]);
	});

	it("lets anthropic choose between OAuth and API key", () => {
		const anthropic = findConnectableProvider("anthropic");
		expect(anthropic?.supportsOAuth).toBe(true);
		expect(anthropic?.supportsApiKey).toBe(true);
	});

	it("findConnectableProvider returns undefined for unknown ids", () => {
		expect(findConnectableProvider("nope")).toBeUndefined();
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
		// daemon resolves the same name, so the credential round-trips.
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

	it("local ollama is keyless with no account", () => {
		const route = buildExtractionRoute({ kind: "local", executor: "ollama", model: "qwen3:4b" });
		expect(route.targets.background).toMatchObject({ executor: "ollama" });
		expect(route.targets.background).not.toHaveProperty("account");
		expect(route.accounts).toBeUndefined();
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

	it("acpx carries the agent block", () => {
		const route = buildExtractionRoute({
			kind: "acpx",
			executor: "acpx",
			model: "haiku",
			acpx: { agent: "claude", bin: "/usr/bin/bunx" },
		});
		expect(route.targets.background).toMatchObject({ executor: "acpx", acpx: { agent: "claude" } });
	});
});
