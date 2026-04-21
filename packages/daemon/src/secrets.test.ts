import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SIGNET_SECRETS_PLUGIN_ID, getDefaultPluginHost, resetDefaultPluginHostForTests } from "./plugins/index.js";
import {
	deleteSecret,
	execWithSecrets,
	getSecret,
	hasSecret,
	listSecrets,
	localSecretProvider,
	putSecret,
} from "./secrets.js";

const originalSignetPath = process.env.SIGNET_PATH;
let agentsDir = "";

function secretsFile(): string {
	return join(agentsDir, ".secrets", "secrets.enc");
}

describe("local secrets provider", () => {
	beforeEach(() => {
		agentsDir = join(tmpdir(), `signet-secrets-provider-${process.pid}-${Date.now()}`);
		process.env.SIGNET_PATH = agentsDir;
		mkdirSync(agentsDir, { recursive: true });
	});

	afterEach(() => {
		resetDefaultPluginHostForTests();
		if (originalSignetPath === undefined) {
			Reflect.deleteProperty(process.env, "SIGNET_PATH");
		} else {
			process.env.SIGNET_PATH = originalSignetPath;
		}
		if (agentsDir && existsSync(agentsDir)) {
			rmSync(agentsDir, { recursive: true, force: true });
		}
	});

	test("bare names and local:// references resolve through the same local store", async () => {
		await putSecret("OPENAI_API_KEY", "sk-test-local");

		expect(listSecrets()).toEqual(["OPENAI_API_KEY"]);
		expect(hasSecret("local://OPENAI_API_KEY")).toBe(true);
		expect(await getSecret("local://OPENAI_API_KEY")).toBe("sk-test-local");

		const resolved = await localSecretProvider.resolve("OPENAI_API_KEY", {});
		expect(resolved.ref).toBe("local://OPENAI_API_KEY");
		expect(resolved.value).toBe("sk-test-local");

		const descriptors = await localSecretProvider.list({});
		expect(descriptors[0]?.ref).toBe("local://OPENAI_API_KEY");
	});

	test("existing secrets.enc store remains readable without rewrite", async () => {
		await putSecret("OPENAI_API_KEY", "sk-test-local");
		const before = readFileSync(secretsFile(), "utf-8");

		expect(listSecrets()).toEqual(["OPENAI_API_KEY"]);
		expect(await localSecretProvider.resolve("local://OPENAI_API_KEY", {})).toMatchObject({
			ref: "local://OPENAI_API_KEY",
			providerId: "local",
			value: "sk-test-local",
		});
		expect(readFileSync(secretsFile(), "utf-8")).toBe(before);
	});

	test("storing a local secret writes the existing v1 encrypted store format", async () => {
		await putSecret("OPENAI_API_KEY", "sk-test-local");

		const store = JSON.parse(readFileSync(secretsFile(), "utf-8")) as {
			version: number;
			secrets: Record<string, { ciphertext: string; created: string; updated: string }>;
		};
		expect(store.version).toBe(1);
		expect(Object.keys(store.secrets)).toEqual(["OPENAI_API_KEY"]);
		expect(typeof store.secrets.OPENAI_API_KEY?.ciphertext).toBe("string");
		expect(store.secrets.OPENAI_API_KEY?.ciphertext).not.toContain("sk-test-local");
		expect(Date.parse(store.secrets.OPENAI_API_KEY?.created ?? "")).toBeGreaterThan(0);
		expect(Date.parse(store.secrets.OPENAI_API_KEY?.updated ?? "")).toBeGreaterThan(0);
	});

	test("execWithSecrets injects secrets and redacts stdout and stderr", async () => {
		await putSecret("OPENAI_API_KEY", "sk-test-local");
		const script = join(agentsDir, "print-secret.mjs");
		writeFileSync(
			script,
			[
				"process.stdout.write(process.env.OPENAI_API_KEY);",
				"process.stderr.write(`err:${process.env.OPENAI_API_KEY}`);",
			].join("\n"),
		);

		const result = await execWithSecrets(`bun ${script}`, {
			OPENAI_API_KEY: "OPENAI_API_KEY",
		});

		expect(result.code).toBe(0);
		expect(result.stdout).toBe("[REDACTED]");
		expect(result.stderr).toBe("err:[REDACTED]");
		expect(result.stdout).not.toContain("sk-test-local");
		expect(result.stderr).not.toContain("sk-test-local");
	});

	test("corrupt stores fail clearly and are not overwritten by list or health checks", async () => {
		mkdirSync(join(agentsDir, ".secrets"), { recursive: true });
		writeFileSync(secretsFile(), "not-json", { mode: 0o600 });

		expect(() => listSecrets()).toThrow("Failed to read secrets store");
		const health = await localSecretProvider.health({});
		expect(health.status).toBe("unhealthy");
		expect(readFileSync(secretsFile(), "utf-8")).toBe("not-json");
	});

	test("machine-mismatched or corrupted ciphertext fails clearly and is not overwritten", async () => {
		await putSecret("OPENAI_API_KEY", "sk-test-local");
		const store = JSON.parse(readFileSync(secretsFile(), "utf-8")) as {
			secrets: { OPENAI_API_KEY: { ciphertext: string } };
		};
		store.secrets.OPENAI_API_KEY.ciphertext = corruptBase64(store.secrets.OPENAI_API_KEY.ciphertext);
		const mismatchedStore = JSON.stringify(store, null, 2);
		writeFileSync(secretsFile(), mismatchedStore, { mode: 0o600 });

		await expect(getSecret("OPENAI_API_KEY")).rejects.toThrow("Decryption failed");
		await expect(localSecretProvider.resolve("local://OPENAI_API_KEY", {})).rejects.toThrow("Decryption failed");
		expect(readFileSync(secretsFile(), "utf-8")).toBe(mismatchedStore);
	});

	test("default signet.secrets plugin degrades when the local provider is unhealthy", () => {
		mkdirSync(join(agentsDir, ".secrets"), { recursive: true });
		writeFileSync(secretsFile(), "not-json", { mode: 0o600 });
		resetDefaultPluginHostForTests();

		const plugin = getDefaultPluginHost().get(SIGNET_SECRETS_PLUGIN_ID);

		expect(plugin?.state).toBe("degraded");
		expect(plugin?.health?.status).toBe("unhealthy");
		expect(plugin?.stateReason).toContain("Failed to read secrets store");
	});

	test("delete accepts local:// compatibility references", async () => {
		await putSecret("GITHUB_TOKEN", "ghp_test");
		expect(deleteSecret("local://GITHUB_TOKEN")).toBe(true);
		expect(listSecrets()).toEqual([]);
	});
});

function corruptBase64(value: string): string {
	const index = value.search(/[A-Za-z0-9+/]/);
	if (index < 0) return "A";
	const replacement = value[index] === "A" ? "B" : "A";
	return `${value.slice(0, index)}${replacement}${value.slice(index + 1)}`;
}
