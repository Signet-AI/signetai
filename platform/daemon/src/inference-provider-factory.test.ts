import { describe, expect, test } from "bun:test";
import { parseRoutingConfig } from "@signet/core";
import { createRoutingProvider } from "./inference-provider-factory";

function codexConfig(model = "gpt-5.4") {
	const parsed = parseRoutingConfig({
		inference: {
			accounts: {
				codex: { kind: "subscription_session", providerFamily: "openai-codex" },
			},
			targets: {
				codex: {
					executor: "openai-codex",
					account: "codex",
					models: { default: { model } },
				},
			},
		},
	});
	if (!parsed.ok) throw new Error(parsed.error.message);
	return parsed.value;
}

describe("inference provider factory", () => {
	test("constructs native pi-ai OAuth providers from catalog model metadata", async () => {
		const provider = await createRoutingProvider({
			config: codexConfig(),
			targetId: "codex",
			modelId: "default",
			async resolveCredential() {
				return {
					apiKey: "oauth-access",
					oauthCredentials: { refresh: "oauth-refresh", access: "oauth-access", expires: Date.now() + 60_000 },
				};
			},
		});

		expect(provider.name).toBe("openai-codex:gpt-5.4");
		expect(await provider.available()).toBe(true);
	});

	test("fails clearly when a dynamic provider model is absent from pi-ai", async () => {
		await expect(
			createRoutingProvider({
				config: codexConfig("not-a-real-model"),
				targetId: "codex",
				modelId: "default",
				async resolveCredential() {
					return { apiKey: "oauth-access" };
				},
			}),
		).rejects.toThrow('Unknown pi-ai model "not-a-real-model" for provider "openai-codex"');
	});
});
