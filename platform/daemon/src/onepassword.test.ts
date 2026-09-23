import { describe, expect, it, mock } from "bun:test";

// Exercise the adapter against the raw SDK v0.3 response shapes rather than
// an already-normalized OnePasswordClient supplied through clientFactory.
mock.module("@1password/sdk", () => ({
	createClient: async () => ({
		secrets: { resolve: async () => "resolved-secret" },
		vaults: {
			list: async () => [{ id: "v1", title: "Engineering Vault" }],
		},
		items: {
			list: async () => [{ id: "item-1", title: "GitHub", vaultId: "v1" }],
			get: async () => ({
				id: "item-1",
				title: "GitHub",
				fields: [
					{
						id: "credential",
						label: "credential",
						value: "ghp_v03",
						fieldType: "CONCEALED",
						purpose: "",
					},
				],
			}),
		},
	}),
}));

import {
	type OnePasswordClientFactory,
	type OnePasswordField,
	buildImportedSecretName,
	extractSecretFieldsFromItem,
	importOnePasswordSecrets,
} from "./onepassword";

describe("buildImportedSecretName", () => {
	it("sanitizes names into Signet-safe secret IDs", () => {
		const name = buildImportedSecretName("op", "Engineering Vault", "GitHub.com", "api token");

		expect(name).toBe("OP_ENGINEERING_VAULT_GITHUB_COM_API_TOKEN");
	});
});

describe("raw SDK adapter boundary", () => {
	it("imports a v0.3 vault title and concealed fieldType", async () => {
		const writes: Array<{ name: string; value: string }> = [];

		const result = await importOnePasswordSecrets({
			token: "sdk-token",
			hasSecret: () => false,
			putSecret: async (name, value) => {
				writes.push({ name, value });
			},
		});

		expect(result.vaultsScanned).toBe(1);
		expect(result.itemsScanned).toBe(1);
		expect(result.importedCount).toBe(1);
		expect(result.skippedCount).toBe(0);
		expect(result.errorCount).toBe(0);
		expect(result.imported[0]).toMatchObject({
			vaultId: "v1",
			vaultName: "Engineering Vault",
			itemId: "item-1",
			fieldId: "credential",
			fieldLabel: "credential",
		});
		expect(writes).toEqual([
			{
				name: buildImportedSecretName("OP", "Engineering Vault", "GitHub", "credential"),
				value: "ghp_v03",
			},
		]);
	});
});

describe("extractSecretFieldsFromItem", () => {
	it("prioritizes concealed/password fields and filters non-secret text fields", () => {
		const fields: readonly OnePasswordField[] = [
			{
				id: "username",
				label: "username",
				value: "nicholai",
				type: "TEXT",
				purpose: "USERNAME",
			},
			{
				id: "password",
				label: "password",
				value: "super-secret",
				type: "CONCEALED",
				purpose: "PASSWORD",
			},
			{
				id: "token",
				label: "api token",
				value: "tok_123",
				type: "CONCEALED",
				purpose: "",
			},
		];

		const result = extractSecretFieldsFromItem(fields);

		expect(result.length).toBe(2);
		expect(result[0]?.id).toBe("password");
		expect(result[1]?.id).toBe("token");
	});
});

describe("importOnePasswordSecrets", () => {
	it("imports password-like fields and suffixes conflicting names", async () => {
		const existingNames = new Set<string>();
		const basePasswordName = buildImportedSecretName("OP", "Engineering Vault", "GitHub", "password");
		existingNames.add(basePasswordName);

		const writes: Array<{ name: string; value: string }> = [];

		const clientFactory: OnePasswordClientFactory = async () => ({
			resolveSecret: async () => "",
			listVaults: async () => [{ id: "v1", name: "Engineering Vault" }],
			listItems: async (vaultId) => {
				expect(vaultId).toBe("v1");
				return [
					{ id: "item-1", title: "GitHub", vaultId: "v1" },
					{ id: "item-2", title: "Readme Note", vaultId: "v1" },
				];
			},
			getItem: async (vaultId, itemId) => {
				expect(vaultId).toBe("v1");
				if (itemId === "item-1") {
					return {
						id: "item-1",
						title: "GitHub",
						fields: [
							{
								id: "username",
								label: "username",
								value: "nicholai",
								type: "TEXT",
								purpose: "USERNAME",
							},
							{
								id: "password",
								label: "password",
								value: "ghp_123",
								type: "CONCEALED",
								purpose: "PASSWORD",
							},
							{
								id: "api-token",
								label: "api token",
								value: "tok_abc",
								type: "CONCEALED",
								purpose: "",
							},
						],
					};
				}
				if (itemId === "item-2") {
					return {
						id: "item-2",
						title: "Readme Note",
						fields: [
							{
								id: "notes",
								label: "notes",
								value: "just text",
								type: "TEXT",
								purpose: "",
							},
						],
					};
				}

				throw new Error(`unexpected item: ${itemId}`);
			},
		});

		const result = await importOnePasswordSecrets({
			token: "token",
			clientFactory,
			prefix: "OP",
			hasSecret: (name) => existingNames.has(name),
			putSecret: async (name, value) => {
				existingNames.add(name);
				writes.push({ name, value });
			},
		});

		expect(result.importedCount).toBe(2);
		expect(result.skippedCount).toBe(1);
		expect(result.errorCount).toBe(0);

		expect(writes[0]?.name).toBe(`${basePasswordName}_2`);
		expect(writes[0]?.value).toBe("ghp_123");
		expect(writes[1]?.name).toBe(buildImportedSecretName("OP", "Engineering Vault", "GitHub", "api token"));
	});
});
