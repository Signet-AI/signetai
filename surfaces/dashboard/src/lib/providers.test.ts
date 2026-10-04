import { describe, expect, it } from "bun:test";
import type { InferenceCatalog } from "@/lib/api";
import { connectableProviders } from "@/lib/providers";

function catalog(codexConnected: boolean): InferenceCatalog {
	return {
		providers: ["openai"],
		models: {},
		modelErrors: {},
		acpxAgents: [],
		oauthProviders: [
			{ id: "openai-codex", name: "ChatGPT / Codex", usesCallbackServer: false, connected: codexConnected },
			{ id: "openai", name: "OpenAI", usesCallbackServer: false, connected: false },
		],
	};
}

function connected(
	codexConnected: boolean,
	accounts: Parameters<typeof connectableProviders>[1],
): Record<string, boolean> {
	return Object.fromEntries(connectableProviders(catalog(codexConnected), accounts).map((p) => [p.id, p.connected]));
}

describe("connectableProviders", () => {
	it("does not treat a configured subscription account as signed in until the daemon has its credential", () => {
		const accounts = { memorybench: { kind: "subscription_session", providerFamily: "openai-codex" } };
		expect(connected(false, accounts)["openai-codex"]).toBe(false);
		expect(connected(true, accounts)["openai-codex"]).toBe(true);
	});

	it("still treats an API key account as connected for a provider that also offers sign-in", () => {
		const accounts = { openai: { kind: "api", providerFamily: "openai", credentialRef: "OPENAI_API_KEY" } };
		expect(connected(false, accounts).openai).toBe(true);
	});
});
