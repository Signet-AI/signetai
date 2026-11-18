import { describe, expect, mock, test } from "bun:test";
import { parseRoutingConfig } from "@signet/core";
import { createRoutingProvider } from "./inference-provider-factory";
import { logger } from "./logger";

function codexConfig(model = "gpt-6-luna") {
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

		expect(provider.name).toBe("openai-codex:gpt-6-luna");
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
						models: { default: { model: "deepseek-v4.1-flash", reasoning: "low" } },
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
				model: "deepseek-v4.1-flash",
				locality: "remote",
			});
			await expect(provider.generate("test")).resolves.toBe("done");
			expect(requestBody?.thinking).toEqual({ type: "enabled" });
			expect(requestBody?.reasoning_effort).toBe("low");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("warns once when a custom target names a missing catalog model", async () => {
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
		const warnings: string[] = [];
		const originalWarn = logger.warn;
		logger.warn = ((_category: unknown, message: unknown) => {
			warnings.push(String(message));
		}) as typeof logger.warn;
		try {
			await createRoutingProvider({
				config: parsed.value,
				targetId: "gateway",
				modelId: "default",
				async resolveCredential() {
					return { apiKey: "test-key" };
				},
			});
		} finally {
			logger.warn = originalWarn;
		}
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("deepseek-v4-flash");
		expect(warnings[0]).toContain("opencode-go");
	});

	test("does not probe a local server's context window for plain completions", async () => {
		const parsed = parseRoutingConfig({
			inference: {
				targets: {
					local: {
						executor: "openai-compatible",
						endpoint: "http://127.0.0.1:65530/v1",
						models: { default: { model: "local-model" } },
					},
				},
			},
		});
		if (!parsed.ok) throw new Error(parsed.error.message);
		const originalFetch = globalThis.fetch;
		const requests: string[] = [];
		globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
			requests.push(`${init?.method ?? "GET"} ${new URL(String(input)).pathname}`);
			return new Response(
				`data: ${JSON.stringify({ choices: [{ delta: { content: "done" } }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
				{ status: 200, headers: { "content-type": "text/event-stream" } },
			);
		}) as unknown as typeof fetch;
		try {
			const provider = await createRoutingProvider({
				config: parsed.value,
				targetId: "local",
				modelId: "default",
				async resolveCredential() {
					return {};
				},
			});
			expect(requests).toEqual([]);
			await expect(provider.generate("test")).resolves.toBe("done");
			expect(requests).toEqual(["POST /v1/chat/completions"]);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("fails clearly when Kimi is configured as a direct executor", async () => {
		const parsed = parseRoutingConfig({
			inference: {
				targets: {
					kimi: { executor: "kimi", models: { default: { model: "kimi-k2.5" } } },
				},
			},
		});
		if (!parsed.ok) throw new Error(parsed.error.message);

		await expect(
			createRoutingProvider({
				config: parsed.value,
				targetId: "kimi",
				modelId: "default",
				async resolveCredential() {
					return undefined;
				},
			}),
		).rejects.toThrow('Routing executor "kimi" has been folded into the Pi + ACPX backends');
	});
});
