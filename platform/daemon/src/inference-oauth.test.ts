import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import type { OAuthAuth } from "@earendil-works/pi-ai";
import {
	completeOAuthInteraction,
	disconnectOAuthProvider,
	listOAuthProviderMetadata,
	loadOAuthCredentials,
	registerOAuthProviderForTests,
	resetOAuthStateForTests,
	resolveOAuthCredential,
	startOAuthLogin,
	storeOAuthCredentials,
} from "./inference-oauth";
import { invalidateSecretsCache, setSecretKeyringAdapterForTests } from "./secrets";

const PROVIDER_ID = "signet-test-oauth-966";
const originalSignetPath = process.env.SIGNET_PATH;
let agentsDir = "";

function provider(overrides: Partial<OAuthAuth> = {}): {
	readonly id: string;
	readonly name: string;
	readonly oauth: OAuthAuth;
} {
	return {
		id: PROVIDER_ID,
		name: "Signet test OAuth",
		oauth: {
			name: "Signet test OAuth",
			async login(interaction) {
				interaction.notify({ type: "auth_url", url: "https://example.test/login", instructions: "Sign in" });
				const answer = await interaction.prompt({ type: "text", message: "Account", placeholder: "name" });
				return { type: "oauth", refresh: `refresh-${answer}`, access: "access-login", expires: Date.now() + 60_000 };
			},
			async refresh(credentials) {
				return { ...credentials, access: "access-refreshed", expires: Date.now() + 60_000 };
			},
			async toAuth(credentials) {
				return { apiKey: credentials.access };
			},
			...overrides,
		},
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
		registerOAuthProviderForTests(provider());
		let key: string | undefined;
		setSecretKeyringAdapterForTests({
			platform: "darwin",
			service: "test",
			account: "test",
			async get() {
				return key ? { state: "found", value: key } : { state: "missing" };
			},
			async set(value) {
				key = value;
				return { state: "found", value };
			},
		});
	});

	afterEach(() => {
		setSecretKeyringAdapterForTests(null);
		resetOAuthStateForTests();
		invalidateSecretsCache();
		if (originalSignetPath === undefined) Reflect.deleteProperty(process.env, "SIGNET_PATH");
		else process.env.SIGNET_PATH = originalSignetPath;
		rmSync(agentsDir, { recursive: true, force: true });
	});

	test("only explicit login completion can authorize a locked keyring", async () => {
		const key = Buffer.alloc(32, 9).toString("base64");
		let locked = false;
		const allowed: boolean[] = [];
		setSecretKeyringAdapterForTests({
			platform: "darwin",
			service: "test",
			account: "test",
			async get(options) {
				allowed.push(options?.allowInteraction === true);
				if (options?.allowInteraction) locked = false;
				return locked && !options?.allowInteraction ? { state: "locked" } : { state: "found", value: key };
			},
			async set() {
				throw Error("Existing key must not be replaced");
			},
		});
		await storeOAuthCredentials(PROVIDER_ID, { refresh: "fixture", access: "fixture", expires: Date.now() + 60_000 });
		locked = true;
		allowed.length = 0;
		await expect(
			storeOAuthCredentials(PROVIDER_ID, { refresh: "fixture", access: "fixture", expires: Date.now() + 60_000 }),
		).rejects.toThrow("locked");
		expect(allowed).toEqual([false]);
		registerOAuthProviderForTests(
			provider({
				async login() {
					return { type: "oauth", refresh: "fixture-login", access: "fixture-login", expires: Date.now() + 60_000 };
				},
			}),
		);
		allowed.length = 0;
		const login = startOAuthLogin(PROVIDER_ID);
		const reader = login.stream.getReader();
		const confirmation = await readUntil(reader, (text) => text.includes("event: select"));
		const event = JSON.parse(
			confirmation
				.split("\n")
				.find((line) => line.startsWith("data: ") && line.includes('"type":"select"'))
				?.slice(6) ?? "{}",
		);
		expect(confirmation).toContain("Always Allow");
		completeOAuthInteraction(login.sessionId, event.responseId, "authorize");
		const text = await readUntil(reader, (text) => text.includes("event: done"));
		expect(text).toContain("event: connected");
		expect(allowed).toEqual([false, true, false]);
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

	test("aborts an interactive login and removes its pending prompt when the request disconnects", async () => {
		const request = new AbortController();
		const login = startOAuthLogin(PROVIDER_ID, undefined, request.signal);
		const reader = login.stream.getReader();
		const initial = await readUntil(reader, (text) => text.includes('"type":"prompt"'));
		const promptData = initial
			.split("\n")
			.find((line) => line.startsWith("data: ") && line.includes('"type":"prompt"'));
		if (!promptData) throw new Error("prompt event missing");
		const prompt = JSON.parse(promptData.slice(6)) as { responseId: string };

		const nextRead = reader.read();
		request.abort();
		await expect(nextRead).rejects.toMatchObject({ name: "AbortError" });
		expect(() => completeOAuthInteraction(login.sessionId, prompt.responseId, "avery")).toThrow(
			"OAuth login session not found or expired",
		);
	});

	test("refreshes an expired token once and persists the replacement", async () => {
		const refreshToken = mock(async () => ({
			refresh: "refresh-old",
			access: "access-refreshed",
			expires: Date.now() + 60_000,
		}));
		registerOAuthProviderForTests(provider({ refresh: refreshToken }));
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
		registerOAuthProviderForTests(provider({ refresh: refreshToken }));
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
		registerOAuthProviderForTests(
			provider({
				async login(interaction) {
					const selected = await interaction.prompt({
						type: "select",
						message: "Choose a flow",
						options: [{ id: "device_code", label: "Device code" }],
					});
					return { type: "oauth", refresh: "refresh", access: selected, expires: Date.now() + 60_000 };
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
