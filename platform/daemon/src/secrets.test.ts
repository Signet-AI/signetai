import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	BITWARDEN_ACTIVE_PROVIDER_SECRET,
	BITWARDEN_SESSION_SECRET,
	type BitwardenClient,
	setBitwardenClientFactoryForTests,
} from "./bitwarden.js";
import { SIGNET_SECRETS_PLUGIN_ID, getDefaultPluginHost, resetDefaultPluginHostForTests } from "./plugins/index.js";
import type { SecretKeyringAdapter, SecretKeyringResult } from "@signet/core";
import {
	__setSecretStoreWriteHookForTests,
	deleteSecret,
	execWithSecrets,
	getSecret,
	getSecretExecJob,
	hasSecret,
	invalidateSecretsCache,
	listSecrets,
	localSecretProvider,
	putSecret,
	resetSecretExecJobsForTests,
	setMachineIdResolverForTests,
	setSecretKeyringAdapterForTests,
	startSecretExecJob,
} from "./secrets.js";

const originalSignetPath = process.env.SIGNET_PATH;
const originalUser = process.env.USER;
let agentsDir = "";

function secretsFile(): string {
	return join(agentsDir, ".secrets", "secrets.enc");
}

function secretStoreTempFiles(): string[] {
	const dir = join(agentsDir, ".secrets");
	if (!existsSync(dir)) return [];
	return readdirSync(dir).filter((name) => name.startsWith("secrets.enc.tmp-"));
}

function machineIdFile(): string {
	return join(agentsDir, ".secrets", ".machine-id");
}

function makeKeyring(initial: SecretKeyringResult): SecretKeyringAdapter & { setCalls: number } {
	let stored = initial.state === "found" ? initial.value : undefined;
	let next = initial;
	const adapter = {
		platform: "test",
		service: "ai.signet.secrets",
		account: "test",
		setCalls: 0,
		async get(): Promise<SecretKeyringResult> {
			return stored === undefined ? next : { state: "found", value: stored };
		},
		async set(value: string): Promise<SecretKeyringResult> {
			adapter.setCalls += 1;
			if (next.state !== "missing" && next.state !== "found") return next;
			stored = value;
			next = { state: "found", value };
			return next;
		},
		getStatus(): SecretKeyringResult {
			return stored === undefined ? next : { state: "found", value: stored };
		},
	};
	return adapter;
}

describe("local secrets provider", () => {
	beforeEach(() => {
		agentsDir = join(tmpdir(), `signet-secrets-provider-${process.pid}-${Date.now()}`);
		process.env.SIGNET_PATH = agentsDir;
		mkdirSync(agentsDir, { recursive: true });
		setSecretKeyringAdapterForTests({
			platform: "test",
			service: "test",
			account: "test",
			async get() {
				return { state: "unavailable", message: "test keyring unavailable" };
			},
			async set() {
				return { state: "unavailable", message: "test keyring unavailable" };
			},
		});
	});

	afterEach(() => {
		resetDefaultPluginHostForTests();
		resetSecretExecJobsForTests();
		setBitwardenClientFactoryForTests(null);
		__setSecretStoreWriteHookForTests(null);
		setMachineIdResolverForTests(null);
		setSecretKeyringAdapterForTests(null);
		invalidateSecretsCache();
		if (originalSignetPath === undefined) {
			Reflect.deleteProperty(process.env, "SIGNET_PATH");
		} else {
			process.env.SIGNET_PATH = originalSignetPath;
		}
		if (originalUser === undefined) {
			Reflect.deleteProperty(process.env, "USER");
		} else {
			process.env.USER = originalUser;
		}
		if (agentsDir && existsSync(agentsDir)) {
			rmSync(agentsDir, { recursive: true, force: true });
		}
	});

	test("new local stores use a random native-keyring master key", async () => {
		const keyring = makeKeyring({ state: "missing" });
		setSecretKeyringAdapterForTests(keyring);

		await putSecret("OPENAI_API_KEY", "native-secret");
		const store = JSON.parse(readFileSync(secretsFile(), "utf-8")) as { version: number; provider: string };

		expect(store).toMatchObject({ version: 2, provider: "native-keyring" });
		expect(keyring.setCalls).toBe(1);
		expect(await getSecret("OPENAI_API_KEY")).toBe("native-secret");
	});

	test("locked native keyrings never fall back or report no credentials", async () => {
		setSecretKeyringAdapterForTests(makeKeyring({ state: "locked", message: "keychain is locked" }));

		await expect(putSecret("OPENAI_API_KEY", "locked-secret")).rejects.toMatchObject({
			name: "SecretKeyringError",
			state: "locked",
			retryable: true,
		});
		expect(existsSync(secretsFile())).toBe(false);
	});

	test("native keyring unavailability stays retryable after a store exists", async () => {
		const keyring = makeKeyring({ state: "missing" });
		setSecretKeyringAdapterForTests(keyring);
		await putSecret("OPENAI_API_KEY", "native-secret");

		setSecretKeyringAdapterForTests({
			platform: "test",
			service: "test",
			account: "test",
			async get() {
				return { state: "unavailable", message: "keyring daemon unavailable" };
			},
			async set() {
				return { state: "unavailable", message: "keyring daemon unavailable" };
			},
		});
		await expect(getSecret("OPENAI_API_KEY")).rejects.toMatchObject({
			name: "SecretKeyringError",
			state: "unavailable",
			retryable: true,
		});
	});

	test("legacy stores migrate once keyring access is restored", async () => {
		await putSecret("OPENAI_API_KEY", "legacy-secret");
		const legacyStore = JSON.parse(readFileSync(secretsFile(), "utf-8")) as { version: number };
		expect(legacyStore.version).toBe(1);

		const keyring = makeKeyring({ state: "missing" });
		setSecretKeyringAdapterForTests(keyring);
		expect(await getSecret("OPENAI_API_KEY")).toBe("legacy-secret");
		const migratedStore = JSON.parse(readFileSync(secretsFile(), "utf-8")) as { version: number; provider: string };
		expect(migratedStore).toMatchObject({ version: 2, provider: "native-keyring" });
		expect(keyring.setCalls).toBe(1);
		expect((await localSecretProvider.health({})).status).toBe("healthy");

		expect(await getSecret("OPENAI_API_KEY")).toBe("legacy-secret");
		expect(keyring.setCalls).toBe(1);
	});

	test("native v2 health reflects a locked keyring instead of reporting healthy", async () => {
		const keyring = makeKeyring({ state: "missing" });
		setSecretKeyringAdapterForTests(keyring);
		await putSecret("OPENAI_API_KEY", "native-secret");

		setSecretKeyringAdapterForTests(makeKeyring({ state: "locked", message: "keychain is locked" }));
		const health = await localSecretProvider.health({});

		expect(health.status).toBe("degraded");
		expect(health.message).toContain("keychain is locked");
	});

	test("native v2 health reports a missing keyring item as degraded", async () => {
		const keyring = makeKeyring({ state: "missing" });
		setSecretKeyringAdapterForTests(keyring);
		await putSecret("OPENAI_API_KEY", "native-secret");

		setSecretKeyringAdapterForTests(makeKeyring({ state: "missing" }));
		const health = await localSecretProvider.health({});

		expect(health.status).toBe("degraded");
		expect(health.message).toContain("Native secrets keyring is missing");
	});

	test("native v2 health degrades for a malformed keyring value and reads fail closed", async () => {
		const keyring = makeKeyring({ state: "missing" });
		setSecretKeyringAdapterForTests(keyring);
		await putSecret("OPENAI_API_KEY", "native-secret");

		setSecretKeyringAdapterForTests(makeKeyring({ state: "found", value: "malformed-keyring-value" }));
		const health = await localSecretProvider.health({});

		expect(health.status).toBe("degraded");
		expect(health.message).toContain("Native secrets keyring is corrupt");
		await expect(getSecret("OPENAI_API_KEY")).rejects.toMatchObject({
			name: "SecretKeyringError",
			state: "corrupt",
			retryable: false,
		});
	});

	test("native v2 health rejects a non-canonical 32-byte-looking keyring value", async () => {
		const keyring = makeKeyring({ state: "missing" });
		setSecretKeyringAdapterForTests(keyring);
		await putSecret("OPENAI_API_KEY", "native-secret");

		setSecretKeyringAdapterForTests(makeKeyring({ state: "found", value: `${"A".repeat(43)}!` }));
		const health = await localSecretProvider.health({});

		expect(health.status).toBe("degraded");
		expect(health.message).toContain("Native secrets keyring is corrupt");
		await expect(getSecret("OPENAI_API_KEY")).rejects.toMatchObject({
			name: "SecretKeyringError",
			state: "corrupt",
			retryable: false,
		});
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

	test("a kill during store replacement leaves the previous store and load removes the orphan temp", async () => {
		await putSecret("OPENAI_API_KEY", "before-kill");
		const script = join(agentsDir, "kill-during-secrets-write.ts");
		writeFileSync(
			script,
			[
				`import { __setSecretStoreWriteHookForTests, putSecret } from ${JSON.stringify(join(import.meta.dir, "secrets.ts"))};`,
				'__setSecretStoreWriteHookForTests((stage) => { if (stage === "after-write") process.kill(process.pid, "SIGKILL"); });',
				'await putSecret("OPENAI_API_KEY", "after-kill");',
			].join("\n"),
			"utf-8",
		);

		const child = spawn(process.execPath, [script], {
			env: { ...process.env, SIGNET_PATH: agentsDir },
			stdio: "ignore",
		});
		const result = await new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
			child.once("error", reject);
			child.once("close", (code, signal) => resolve({ code, signal }));
		});

		expect(result).toEqual({ code: null, signal: "SIGKILL" });
		expect(secretStoreTempFiles()).toHaveLength(1);
		expect(await getSecret("OPENAI_API_KEY")).toBe("before-kill");
		expect(secretStoreTempFiles()).toEqual([]);
	});

	test("store replacement removes its temp file when closing the fd fails", async () => {
		await putSecret("OPENAI_API_KEY", "before-close-failure");
		__setSecretStoreWriteHookForTests((stage, fd) => {
			if (stage === "before-close" && fd !== undefined) closeSync(fd);
		});

		await expect(putSecret("OPENAI_API_KEY", "after-close-failure")).rejects.toThrow();

		expect(secretStoreTempFiles()).toEqual([]);
		__setSecretStoreWriteHookForTests(null);
		expect(await getSecret("OPENAI_API_KEY")).toBe("before-close-failure");
	});

	test("transient machine-id failure keeps the secrets key stable across restarts", async () => {
		process.env.USER = "signet-secrets-test-user";
		setMachineIdResolverForTests(() => undefined);

		await putSecret("OPENAI_API_KEY", "«redacted:sk-…»");
		const persistedMachineId = readFileSync(machineIdFile(), "utf-8");

		expect(persistedMachineId.trim()).not.toBe("");
		if (process.platform !== "win32") {
			expect(statSync(machineIdFile()).mode & 0o777).toBe(0o600);
		}

		// Re-derive the key as a fresh process would, after the platform resolver recovers.
		setMachineIdResolverForTests(() => "ioreg-id-after-transient-failure");
		expect(await getSecret("OPENAI_API_KEY")).toBe("«redacted:sk-…»");
		expect(readFileSync(machineIdFile(), "utf-8")).toBe(persistedMachineId);
	});

	test("existing v1 store stays recoverable when the machine-id resolver is unavailable during upgrade", async () => {
		process.env.USER = "signet-secrets-test-user";
		setMachineIdResolverForTests(() => "legacy-machine-id");
		await putSecret("OPENAI_API_KEY", "«redacted:sk-…»");
		const before = readFileSync(secretsFile(), "utf-8");
		rmSync(machineIdFile());

		setMachineIdResolverForTests(() => undefined);
		await expect(putSecret("GITHUB_TOKEN", "new-value")).rejects.toThrow("could not be verified");
		expect(existsSync(machineIdFile())).toBe(false);
		expect(readFileSync(secretsFile(), "utf-8")).toBe(before);
		await expect(getSecret("OPENAI_API_KEY")).rejects.toThrow("Decryption failed");
		expect(existsSync(machineIdFile())).toBe(false);

		setMachineIdResolverForTests(() => "legacy-machine-id");
		expect(await getSecret("OPENAI_API_KEY")).toBe("«redacted:sk-…»");
		expect(readFileSync(machineIdFile(), "utf-8")).toBe("legacy-machine-id\n");
	});

	test("execWithSecrets injects secrets and redacts stdout and stderr", async () => {
		await putSecret("OPENAI_API_KEY", "sk-test-local");
		const script = join(agentsDir, "print-secret.mjs");
		writeFileSync(
			script,
			[
				"process.stdout.write(process.env.OPENAI_API_KEY);",
				'process.stderr.write("err:" + process.env.OPENAI_API_KEY);',
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
		expect(await deleteSecret("local://GITHUB_TOKEN")).toBe(true);
		expect(await listSecrets()).toEqual([]);
	});
});

function corruptBase64(value: string): string {
	const index = value.search(/[A-Za-z0-9+/]/);
	if (index < 0) return "A";
	const replacement = value[index] === "A" ? "B" : "A";
	return `${value.slice(0, index)}${replacement}${value.slice(index + 1)}`;
}
