import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import type { OAuthProviderInterface } from "@earendil-works/pi-ai";
import { registerOAuthProvider, unregisterOAuthProvider } from "@earendil-works/pi-ai/oauth";
import {
	completeOAuthInteraction,
	disconnectOAuthProvider,
	listOAuthProviderMetadata,
	loadOAuthCredentials,
	resetOAuthStateForTests,
	resolveOAuthCredential,
	startOAuthLogin,
	storeOAuthCredentials,
} from "./inference-oauth";
import { invalidateSecretsCache } from "./secrets";

const PROVIDER_ID = "signet-test-oauth-966";
const originalSignetPath = process.env.SIGNET_PATH;
let agentsDir = "";

function provider(overrides: Partial<OAuthProviderInterface> = {}): OAuthProviderInterface {
	return {
		id: PROVIDER_ID,
		name: "Signet test OAuth",
		async login(callbacks) {
			callbacks.onAuth({ url: "https://example.test/login", instructions: "Sign in" });
			const answer = await callbacks.onPrompt({ message: "Account", placeholder: "name" });
			return { refresh: `refresh-${answer}`, access: "access-login", expires: Date.now() + 60_000 };
		},
		async refreshToken(credentials) {
			return { ...credentials, access: "access-refreshed", expires: Date.now() + 60_000 };
		},
		getApiKey(credentials) {
			return credentials.access;
		},
		...overrides,
	};
}

async function readUntil(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	predicate: (text: string) => boolean,
): Promise<string> {
	const decoder = new TextDecoder();
	let text = "";
	while (!predicate(text)) {
		const next = await reader.read();
		if (next.done) break;
		text += decoder.decode(next.value, { stream: true });
	}
	return text;
}

describe("inference OAuth", () => {
	beforeEach(() => {
		agentsDir = mkdtempSync(`${tmpdir()}/signet-oauth-`);
		mkdirSync(agentsDir, { recursive: true });
		process.env.SIGNET_PATH = agentsDir;
		registerOAuthProvider(provider());
	});

	afterEach(() => {
		resetOAuthStateForTests();
		unregisterOAuthProvider(PROVIDER_ID);
		invalidateSecretsCache();
		if (originalSignetPath === undefined) Reflect.deleteProperty(process.env, "SIGNET_PATH");
		else process.env.SIGNET_PATH = originalSignetPath;
		rmSync(agentsDir, { recursive: true, force: true });
	});

	test("streams interactive login events and stores credentials only in the daemon", async () => {
		expect(listOAuthProviderMetadata()).toContainEqual({
			id: PROVIDER_ID,
			name: "Signet test OAuth",
			usesCallbackServer: false,
		});

		const login = startOAuthLogin(PROVIDER_ID);
		const reader = login.stream.getReader();
		const initial = await readUntil(reader, (text) => text.includes('"type":"prompt"'));
		expect(initial).toContain("https://example.test/login");
		const promptData = initial
			.split("\n")
			.find((line) => line.startsWith("data: ") && line.includes('"type":"prompt"'));
		expect(promptData).toBeDefined();
		if (!promptData) throw new Error("prompt event missing");
		const prompt = JSON.parse(promptData.slice(6)) as { responseId: string };

		completeOAuthInteraction(login.sessionId, prompt.responseId, "avery");
		const completed = await readUntil(reader, (text) => text.includes('"type":"done"'));
		expect(completed).toContain('"type":"connected"');
		expect(await loadOAuthCredentials(PROVIDER_ID)).toMatchObject({
			refresh: "refresh-avery",
			access: "access-login",
		});
		expect(await disconnectOAuthProvider(PROVIDER_ID)).toBe(true);
		expect(await loadOAuthCredentials(PROVIDER_ID)).toBeNull();
	});

	test("refreshes an expired token once and persists the replacement", async () => {
		const refreshToken = mock(async () => ({
			refresh: "refresh-old",
			access: "access-refreshed",
			expires: Date.now() + 60_000,
		}));
		registerOAuthProvider(provider({ refreshToken }));
		await storeOAuthCredentials(PROVIDER_ID, {
			refresh: "refresh-old",
			access: "access-expired",
			expires: Date.now() - 1,
		});

		const [first, second] = await Promise.all([
			resolveOAuthCredential(PROVIDER_ID),
			resolveOAuthCredential(PROVIDER_ID),
		]);

		expect(refreshToken).toHaveBeenCalledTimes(1);
		expect(first?.apiKey).toBe("access-refreshed");
		expect(second?.apiKey).toBe("access-refreshed");
		expect((await loadOAuthCredentials(PROVIDER_ID))?.access).toBe("access-refreshed");
	});

	test("treats a rejected token refresh as an unavailable credential", async () => {
		const refreshToken = mock(async () => {
			throw new Error("revoked refresh token");
		});
		registerOAuthProvider(provider({ refreshToken }));
		await storeOAuthCredentials(PROVIDER_ID, {
			refresh: "refresh-revoked",
			access: "access-expired",
			expires: Date.now() - 1,
		});

		expect(await resolveOAuthCredential(PROVIDER_ID)).toBeNull();
		expect(refreshToken).toHaveBeenCalledTimes(1);
		expect((await loadOAuthCredentials(PROVIDER_ID))?.access).toBe("access-expired");
	});

	test("rejects invalid provider ids before touching secret storage", async () => {
		await expect(loadOAuthCredentials("../../escape")).rejects.toThrow("Invalid OAuth provider id");
		expect(() => startOAuthLogin("missing-provider")).toThrow("Unknown OAuth provider");
	});

	test("accepts only selection values offered by the OAuth provider", async () => {
		registerOAuthProvider(
			provider({
				async login(callbacks) {
					const selected = await callbacks.onSelect({
						message: "Choose a flow",
						options: [{ id: "device_code", label: "Device code" }],
					});
					return { refresh: "refresh", access: selected ?? "none", expires: Date.now() + 60_000 };
				},
			}),
		);
		const login = startOAuthLogin(PROVIDER_ID);
		const reader = login.stream.getReader();
		const initial = await readUntil(reader, (text) => text.includes('"type":"select"'));
		const selectData = initial
			.split("\n")
			.find((line) => line.startsWith("data: ") && line.includes('"type":"select"'));
		if (!selectData) throw new Error("select event missing");
		const select = JSON.parse(selectData.slice(6)) as { responseId: string };

		expect(() => completeOAuthInteraction(login.sessionId, select.responseId, "browser")).toThrow(
			"not one of the offered options",
		);
		completeOAuthInteraction(login.sessionId, select.responseId, "device_code");
		await readUntil(reader, (text) => text.includes('"type":"done"'));
	});
});
