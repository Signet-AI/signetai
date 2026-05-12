import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
	type BitwardenClient,
	type BitwardenItemDetails,
	buildBitwardenManagedSecretName,
	isBitwardenReference,
	migrateLocalSecretsToBitwarden,
	readBitwardenReference,
} from "./bitwarden.js";

function mockClient(): BitwardenClient {
	const items = new Map<string, BitwardenItemDetails>();
	return {
		async status() {
			return { status: "unlocked", userEmail: "user@example.com", serverUrl: "https://vault.bitwarden.com" };
		},
		async listFolders() {
			return [{ id: "folder-1", name: "Signet" }];
		},
		async listItems() {
			return Array.from(items.values()).map((item) => ({ id: item.id, name: item.name, folderId: item.folderId }));
		},
		async getItem(id: string) {
			const item = items.get(id);
			if (!item) throw new Error(`missing ${id}`);
			return item;
		},
		async putSecret(name: string, value: string, options = {}) {
			const existing = Array.from(items.values()).find((item) => item.name === name);
			if (existing && options.overwrite !== true) throw new Error(`Bitwarden item '${name}' already exists`);
			const item = {
				id: existing?.id ?? `item-${items.size + 1}`,
				name,
				folderId: options.folderId ?? existing?.folderId ?? null,
				login: { username: "signet", password: value },
				notes: "Managed by Signet secrets",
			};
			items.set(item.id, item);
			return item;
		},
		async deleteSecret(name: string) {
			const existing = Array.from(items.values()).find((item) => item.name === name);
			if (!existing) return false;
			items.delete(existing.id);
			return true;
		},
		async resolveSecret(ref: string) {
			const item = ref.startsWith("bw://item/")
				? items.get(ref.split("/")[3] ?? "")
				: Array.from(items.values()).find(
						(entry) => entry.name === decodeURIComponent(ref.split("/")[3] ?? ref.slice("bw://".length)),
					);
			if (typeof item?.login?.password !== "string") throw new Error("missing password");
			return item.login.password;
		},
	};
}

describe("Bitwarden secrets provider", () => {
	test("recognizes bw:// references and normalizes Signet secret names", () => {
		expect(isBitwardenReference("bw://name/OPENAI_API_KEY")).toBe(true);
		expect(isBitwardenReference("OPENAI_API_KEY")).toBe(false);
		expect(buildBitwardenManagedSecretName("anthropic_key")).toBe("anthropic_key");
		expect(buildBitwardenManagedSecretName("ANTHROPIC_KEY")).toBe("ANTHROPIC_KEY");
		expect(buildBitwardenManagedSecretName("OpenAI API Key")).toBe("OPENAI_API_KEY");
		expect(buildBitwardenManagedSecretName("1password-token")).toBe("SECRET_1PASSWORD_TOKEN");
	});

	test("resolves Bitwarden references through the injected client factory", async () => {
		const client = mockClient();
		await client.putSecret("OPENAI_API_KEY", "sk-bw", { overwrite: true });
		const value = await readBitwardenReference("bw://name/OPENAI_API_KEY", "session", async () => client);
		expect(value).toBe("sk-bw");
	});

	test("round-trips empty Bitwarden secret values", async () => {
		const client = mockClient();
		await client.putSecret("EMPTY_SECRET", "", { overwrite: true });
		expect(await readBitwardenReference("bw://name/EMPTY_SECRET", "session", async () => client)).toBe("");
	});

	test("migrates local Signet secrets into Bitwarden without deleting local copies by default", async () => {
		const client = mockClient();
		const local = new Map([
			["OPENAI_API_KEY", "sk-local"],
			["Anthropic Key", "sk-ant"],
		]);
		const result = await migrateLocalSecretsToBitwarden({
			session: "session",
			localNames: Array.from(local.keys()),
			getLocalSecret: async (name) => local.get(name) ?? "",
			folderId: "folder-1",
			overwrite: true,
			clientFactory: async () => client,
		});

		expect(result.migratedCount).toBe(2);
		expect(result.deletedLocalCount).toBe(0);
		expect(await readBitwardenReference("bw://name/OPENAI_API_KEY", "session", async () => client)).toBe("sk-local");
		expect(await readBitwardenReference("bw://name/ANTHROPIC_KEY", "session", async () => client)).toBe("sk-ant");
	});

	test("dry-run migration does not read or write secret values", async () => {
		let readCount = 0;
		const result = await migrateLocalSecretsToBitwarden({
			session: "session",
			localNames: ["OPENAI_API_KEY"],
			getLocalSecret: async () => {
				readCount += 1;
				return "sk-local";
			},
			dryRun: true,
			clientFactory: async () => mockClient(),
		});

		expect(result.dryRun).toBe(true);
		expect(result.skippedCount).toBe(1);
		expect(readCount).toBe(0);
	});
	test("Bitwarden CLI writes use stdin-supported create/edit payloads and keep secrets out of argv", () => {
		const source = readFileSync(new URL("./bitwarden.ts", import.meta.url), "utf8");
		expect(source).not.toContain('"--session"');
		expect(source).not.toContain('["create", "item", encoded.trim()]');
		expect(source).not.toContain('["edit", "item", existing.id, encoded.trim()]');
		expect(source).toContain('runBw(["create", "item"], { input: encoded.trim(), session: this.session })');
		expect(source).toContain('runBw(["edit", "item", existing.id], { input: encoded.trim(), session: this.session })');
		expect(source).toContain("password: readOptionalString(login.password)");
		expect(source).toContain("value: readOptionalString(field.value)");
	});
});
