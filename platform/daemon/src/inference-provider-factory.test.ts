import { describe, expect, mock, test } from "bun:test";
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

	test("uses catalog protocol metadata with a custom compatible endpoint", async () => {
		const parsed = parseRoutingConfig({
			inference: {
				accounts: { gateway: { kind: "api", providerFamily: "opencode-go", credentialRef: "TEST_KEY" } },
				targets: {
					gateway: {
						executor: "openai-compatible",
						account: "gateway",
						endpoint: "https://opencode.ai/zen/go",
						models: { default: { model: "deepseek-v4-flash", reasoning: "low" } },
					},
				},
			},
		});
		if (!parsed.ok) throw new Error(parsed.error.message);
		const originalFetch = globalThis.fetch;
		let requestBody: Record<string, unknown> | undefined;
		globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
			requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
			return new Response(
				`data: ${JSON.stringify({ choices: [{ delta: { content: "done" } }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
				{ status: 200, headers: { "content-type": "text/event-stream" } },
			);
		}) as unknown as typeof fetch;
		try {
			const provider = await createRoutingProvider({
				config: parsed.value,
				targetId: "gateway",
				modelId: "default",
				async resolveCredential() {
					return { apiKey: "test-key" };
				},
			});
			expect(provider.telemetryAttribution).toEqual({
				executor: "openai-compatible",
				provider: "opencode-go",
				model: "deepseek-v4-flash",
				locality: "remote",
			});
			await expect(provider.generate("test")).resolves.toBe("done");
			expect(requestBody?.thinking).toEqual({ type: "disabled" });
			expect(requestBody?.reasoning_effort).toBeUndefined();
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
