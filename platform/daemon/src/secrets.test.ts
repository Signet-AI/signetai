import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	BITWARDEN_ACTIVE_PROVIDER_SECRET,
	BITWARDEN_SESSION_SECRET,
	type BitwardenClient,
	setBitwardenClientFactoryForTests,
} from "./bitwarden.js";
import { SIGNET_SECRETS_PLUGIN_ID, getDefaultPluginHost, resetDefaultPluginHostForTests } from "./plugins/index.js";
import {
	deleteSecret,
	execWithSecrets,
	getSecret,
	getSecretExecJob,
	hasSecret,
	listSecrets,
	localSecretProvider,
	putSecret,
	resetSecretExecJobsForTests,
	startSecretExecJob,
	invalidateSecretsCache,
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
		resetSecretExecJobsForTests();
		setBitwardenClientFactoryForTests(null);
		invalidateSecretsCache();
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

		expect(await listSecrets()).toEqual(["OPENAI_API_KEY"]);
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

		expect(await listSecrets()).toEqual(["OPENAI_API_KEY"]);
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

	test("execWithSecrets times out bounded subprocesses", async () => {
		await putSecret("OPENAI_API_KEY", "sk-timeout");
		const script = join(agentsDir, "sleep-secret.mjs");
		writeFileSync(script, "setTimeout(() => process.stdout.write(process.env.OPENAI_API_KEY), 2000);\n");

		const result = await execWithSecrets(`bun ${script}`, { OPENAI_API_KEY: "OPENAI_API_KEY" }, { timeoutMs: 1000 });

		expect(result.code).toBe(124);
		expect(result.timedOut).toBe(true);
		expect(result.stdout).not.toContain("sk-timeout");
		expect(result.stderr).toContain("timed out");
	});

	test("execWithSecrets redacts before output truncation can leak secret prefixes", async () => {
		await putSecret("OPENAI_API_KEY", "sk-partial-secret");
		const script = join(agentsDir, "partial-secret.mjs");
		writeFileSync(script, `process.stdout.write(${JSON.stringify("A".repeat(1020))} + process.env.OPENAI_API_KEY);\n`);

		const result = await execWithSecrets(
			`bun ${script}`,
			{ OPENAI_API_KEY: "OPENAI_API_KEY" },
			{ timeoutMs: 1000, maxOutputBytes: 1024 },
		);

		expect(result.code).toBe(0);
		expect(result.stdout).not.toContain("sk-");
		expect(result.stdout).not.toContain("sk-partial-secret");
		expect(result.stdout).toContain("stdout truncated");
	});

	test("execWithSecrets kills subprocess children on timeout", async () => {
		await putSecret("OPENAI_API_KEY", "sk-child-timeout");
		const marker = join(agentsDir, "child-survived.txt");
		const child = join(agentsDir, "timeout-child.mjs");
		const parent = join(agentsDir, "timeout-parent.mjs");
		writeFileSync(child, "setTimeout(() => Bun.write(process.env.MARKER_PATH, process.env.OPENAI_API_KEY), 1200);\n");
		writeFileSync(
			parent,
			[
				'import { spawn } from "node:child_process";',
				'spawn(process.execPath, [process.env.CHILD_SCRIPT], { env: process.env, stdio: "ignore" });',
				"setTimeout(() => {}, 5000);",
			].join("\n"),
		);

		process.env.MARKER_PATH = marker;
		process.env.CHILD_SCRIPT = child;
		const result = await execWithSecrets(`bun ${parent}`, { OPENAI_API_KEY: "OPENAI_API_KEY" }, { timeoutMs: 200 });
		process.env.MARKER_PATH = undefined;
		process.env.CHILD_SCRIPT = undefined;
		await new Promise((resolve) => setTimeout(resolve, 1400));

		expect(result.code).toBe(124);
		expect(result.timedOut).toBe(true);
		expect(existsSync(marker)).toBe(false);
	});

	test("startSecretExecJob returns immediately and completes in the background", async () => {
		await putSecret("OPENAI_API_KEY", "sk-background");
		const script = join(agentsDir, "background-secret.mjs");
		writeFileSync(script, "setTimeout(() => process.stdout.write(process.env.OPENAI_API_KEY), 25);\n");

		const job = startSecretExecJob(`bun ${script}`, { OPENAI_API_KEY: "OPENAI_API_KEY" }, { timeoutMs: 1000 });

		expect(job.id.length).toBeGreaterThan(0);
		expect(["queued", "running"]).toContain(job.status);
		expect(job.result).toBeUndefined();

		let finished = getSecretExecJob(job.id);
		for (let i = 0; i < 20 && finished?.status !== "completed"; i++) {
			await new Promise((resolve) => setTimeout(resolve, 25));
			finished = getSecretExecJob(job.id);
		}

		expect(finished?.status).toBe("completed");
		expect(finished?.result?.code).toBe(0);
		expect(finished?.result?.stdout).toBe("[REDACTED]");
		expect(finished?.result?.stdout).not.toContain("sk-background");
	});

	test("startSecretExecJob limits concurrently running jobs", async () => {
		await putSecret("OPENAI_API_KEY", "sk-queued");
		const script = join(agentsDir, "queued-secret.mjs");
		writeFileSync(script, "setTimeout(() => process.stdout.write(process.env.OPENAI_API_KEY), 200);\n");

		const jobs = Array.from({ length: 6 }, () =>
			startSecretExecJob(`bun ${script}`, { OPENAI_API_KEY: "OPENAI_API_KEY" }, { timeoutMs: 1000 }),
		);
		await new Promise((resolve) => setTimeout(resolve, 25));
		const statuses = jobs.map((job) => getSecretExecJob(job.id)?.status);

		expect(statuses.filter((status) => status === "running")).toHaveLength(4);
		expect(statuses.filter((status) => status === "queued")).toHaveLength(2);
	});

	test("startSecretExecJob evicts retained completed job results instead of blocking new work", async () => {
		await putSecret("OPENAI_API_KEY", "sk-retained");
		const jobs = [];

		for (let i = 0; i < 150; i++) {
			const job = startSecretExecJob("bun --version", { OPENAI_API_KEY: "OPENAI_API_KEY" }, { timeoutMs: 1000 });
			jobs.push(job);
			for (let poll = 0; poll < 80; poll++) {
				if (getSecretExecJob(job.id)?.status === "completed") break;
				await new Promise((resolve) => setTimeout(resolve, 25));
			}
		}

		const next = startSecretExecJob("bun --version", { OPENAI_API_KEY: "OPENAI_API_KEY" }, { timeoutMs: 1000 });

		expect(["queued", "running"]).toContain(next.status);
		expect(jobs.some((job) => !getSecretExecJob(job.id))).toBe(true);
	});

	test("corrupt stores fail clearly and are not overwritten by list or health checks", async () => {
		mkdirSync(join(agentsDir, ".secrets"), { recursive: true });
		writeFileSync(secretsFile(), "not-json", { mode: 0o600 });

		await expect(listSecrets()).rejects.toThrow("Failed to read secrets store");
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
		resetSecretExecJobsForTests();

		const plugin = getDefaultPluginHost().get(SIGNET_SECRETS_PLUGIN_ID);

		expect(plugin?.state).toBe("degraded");
		expect(plugin?.health?.status).toBe("unhealthy");
		expect(plugin?.stateReason).toContain("Failed to read secrets store");
	});

	test("active Bitwarden provider resolves bare names with the same canonical name used on write", async () => {
		const client: BitwardenClient = {
			async status() {
				return { status: "unlocked" };
			},
			async listFolders() {
				return [];
			},
			async listItems() {
				return [{ id: "item-1", name: "anthropic_key", folderId: null }];
			},
			async getItem(id: string) {
				expect(id).toBe("item-1");
				return { id, name: "anthropic_key", folderId: null, login: { username: "signet", password: "sk-bw" } };
			},
			async putSecret() {
				throw new Error("not used");
			},
			async deleteSecret() {
				return false;
			},
			async resolveSecret(ref: string) {
				expect(ref).toBe("bw://name/anthropic_key");
				return "sk-bw";
			},
		};
		setBitwardenClientFactoryForTests(async () => client);
		await putSecret(BITWARDEN_SESSION_SECRET, "bw-session");
		await putSecret(BITWARDEN_ACTIVE_PROVIDER_SECRET, "bitwarden");

		expect(await getSecret("anthropic_key")).toBe("sk-bw");
	});

	test("delete accepts local:// compatibility references", async () => {
		await putSecret("GITHUB_TOKEN", "ghp_test");
		expect(deleteSecret("local://GITHUB_TOKEN")).toBe(true);
		expect(await listSecrets()).toEqual([]);
	});
});

function corruptBase64(value: string): string {
	const index = value.search(/[A-Za-z0-9+/]/);
	if (index < 0) return "A";
	const replacement = value[index] === "A" ? "B" : "A";
	return `${value.slice(0, index)}${replacement}${value.slice(index + 1)}`;
}
