import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { mock } from "bun:test";
import { setBitwardenClientFactoryForTests, type BitwardenItemDetails } from "../../../platform/daemon/src/bitwarden";
import { registerOAuthProviderForTests } from "../../../platform/daemon/src/inference-oauth";
import { setSecretKeyringAdapterForTests } from "../../../platform/daemon/src/secrets";
import { record, text } from "./http";

const root = process.env.TMPDIR;
assert(root && process.env.HOME?.startsWith(root), "Provider fakes require a disposable organization fixture");
const metadata: unknown = JSON.parse(await readFile(join(root, "host-fixture.json"), "utf8"));
assert(metadata && typeof metadata === "object" && "origin" in metadata && typeof metadata.origin === "string");
const origin = metadata.origin;
assert(new URL(origin).hostname === "127.0.0.1", "Fixture services must be loopback-only");
const statePath = join(root, "bitwarden.json");
const keyPath = join(root, "keyring.key");
const state = async (): Promise<BitwardenItemDetails[]> => {
	const value: unknown = JSON.parse(await readFile(statePath, "utf8"));
	assert(Array.isArray(value));
	return value.map((input) => {
		const row = record(input);
		return {
			id: text(row.id),
			name: text(row.name),
			...(typeof row.folderId === "string" ? { folderId: row.folderId } : {}),
			login: { password: text(record(row.login).password) },
		};
	});
};
setSecretKeyringAdapterForTests({
	platform: "darwin",
	service: "org-host-fixture",
	account: "fixture",
	async get() {
		return (await Bun.file(keyPath).exists())
			? { state: "found", value: await readFile(keyPath, "utf8") }
			: { state: "missing" };
	},
	async set(value) {
		await writeFile(keyPath, value, { mode: 0o600 });
		return { state: "found", value };
	},
});
setBitwardenClientFactoryForTests(async () => ({
	async status() {
		return { status: "unlocked", userEmail: "fixture@example.test", serverUrl: origin };
	},
	async listFolders() {
		return [{ id: "fixture-folder", name: "Fixture" }];
	},
	async listItems() {
		return state();
	},
	async getItem(id) {
		const item = (await state()).find((entry) => entry.id === id);
		assert(item);
		return item;
	},
	async putSecret(name, value, options) {
		const items = await state();
		const existing = items.find((item) => item.name === name);
		assert(!existing || options?.overwrite, "Duplicate fixture Bitwarden item");
		const item = { id: existing?.id ?? randomUUID(), name, folderId: options?.folderId, login: { password: value } };
		await writeFile(statePath, JSON.stringify([...items.filter((entry) => entry.name !== name), item]), {
			mode: 0o600,
		});
		return item;
	},
	async deleteSecret(name) {
		const items = await state();
		await writeFile(statePath, JSON.stringify(items.filter((item) => item.name !== name)), { mode: 0o600 });
		return items.some((item) => item.name === name);
	},
	async resolveSecret(reference) {
		const item = (await state()).find((entry) => reference.includes(entry.id) || reference.includes(entry.name));
		assert(item?.login?.password);
		return item.login.password;
	},
}));
mock.module(
	import.meta.resolve("@1password/sdk", new URL("../../../platform/daemon/src/onepassword.ts", import.meta.url).href),
	() => ({
		async createClient() {
			return {
				secrets: {
					async resolve() {
						return randomBytes(24).toString("base64url");
					},
				},
				vaults: {
					async list() {
						return [{ id: "fixture-vault", name: "Fixture" }];
					},
				},
				items: {
					async list() {
						return [{ id: "fixture-item", title: "Service", vaultId: "fixture-vault" }];
					},
					async get() {
						return {
							id: "fixture-item",
							title: "Service",
							fields: [
								{
									id: "password",
									label: "password",
									type: "CONCEALED",
									purpose: "PASSWORD",
									value: randomBytes(24).toString("base64url"),
								},
							],
						};
					},
				},
			};
		},
	}),
);
registerOAuthProviderForTests({
	id: "org-host-fixture",
	name: "Organization host fixture",
	oauth: {
		name: "Organization host fixture",
		async login(interaction) {
			interaction.notify({ type: "auth_url", url: `${origin}/oauth`, instructions: "Fixture authorization" });
			await interaction.prompt({ type: "text", message: "Account" });
			return { type: "oauth", refresh: randomUUID(), access: randomUUID(), expires: Date.now() + 60_000 };
		},
		async refresh(credentials) {
			return { ...credentials, expires: Date.now() + 60_000 };
		},
		async toAuth(credentials) {
			return { apiKey: credentials.access };
		},
	},
});
const realFetch = globalThis.fetch;
globalThis.fetch = Object.assign(
	(input: RequestInfo | URL, init?: RequestInit) => {
		const request = new Request(input, init);
		const url = new URL(request.url);
		if (["api.github.com", "discord.com"].includes(url.hostname)) {
			return realFetch(new Request(new URL(url.pathname + url.search, origin), request));
		}
		return realFetch(request);
	},
	{ preconnect: realFetch.preconnect },
);
