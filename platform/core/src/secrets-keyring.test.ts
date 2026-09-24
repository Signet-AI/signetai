import { afterEach, describe, expect, test } from "bun:test";
import { closeSync, openSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
	getSecretKeyring,
	resetSecretKeyringModuleForTests,
	setSecretKeyringHelperForTests,
	type SecretKeyringAdapter,
	type SecretKeyringResult,
	type SecretKeyringState,
} from "./secrets-keyring";
import {
	getLocalSecretProviderHealth,
	getLocalSecretValue,
	putLocalSecret,
	setSecretKeyringAdapterForTests,
} from "./secrets";

const directories: string[] = [];
const originalSignetPath = process.env.SIGNET_PATH;

afterEach(async () => {
	setSecretKeyringHelperForTests(null);
	resetSecretKeyringModuleForTests();
	setSecretKeyringAdapterForTests(null);
	if (originalSignetPath === undefined) delete process.env.SIGNET_PATH;
	else process.env.SIGNET_PATH = originalSignetPath;
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function fixedKeyring(state: SecretKeyringState): SecretKeyringAdapter {
	const result: SecretKeyringResult = { state, message: `test keyring ${state}` };
	return {
		platform: "test",
		service: "test",
		account: "test",
		async get() {
			return result;
		},
		async set() {
			return result;
		},
	};
}

async function useNativeModule(directory: string, modulePath: string): Promise<void> {
	const busctl = join(directory, "busctl");
	const helperPath = join(directory, "keyring-helper.ts");
	await writeFile(busctl, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
	const childModule = new URL("./secrets-keyring-child.ts", import.meta.url).href;
	await writeFile(
		helperPath,
		[
			`import { runSecretKeyringChild } from ${JSON.stringify(childModule)};`,
			`process.env.PATH = ${JSON.stringify(directory)} + ${JSON.stringify(delimiter)} + (process.env.PATH ?? "");`,
			'process.env.DBUS_SESSION_BUS_ADDRESS = "unix:path=/signet-test";',
			`process.env.SIGNET_KEYRING_NATIVE_MODULE_PATH = ${JSON.stringify(modulePath)};`,
			"await runSecretKeyringChild();",
		].join("\n"),
	);
	setSecretKeyringHelperForTests({ entryPath: helperPath, deadlineMs: 2_000 });
}

describe("native secret keyring containment", () => {
	test("kills and reaps a helper that blocks native keyring work without blocking timers", async () => {
		const directory = await mkdtemp(join(tmpdir(), "signet-keyring-helper-"));
		directories.push(directory);
		const pidPath = join(directory, "pid.txt");
		const helperPath = join(directory, "hang.ts");
		await writeFile(
			helperPath,
			`import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
new Int32Array(new SharedArrayBuffer(4));
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
`,
		);
		setSecretKeyringHelperForTests({ entryPath: helperPath, deadlineMs: 100 });
		let timerAdvanced = false;
		setTimeout(() => {
			timerAdvanced = true;
		}, 10);

		const descriptors = Array.from({ length: 1_100 }, () => openSync(devNull, "r"));
		const adapter = getSecretKeyring(directory);
		const getStatus = adapter.getStatus;
		if (getStatus === undefined) throw new Error("expected keyring status operation");
		let result: SecretKeyringResult;
		try {
			result = await getStatus.call(adapter);
		} finally {
			for (const descriptor of descriptors) closeSync(descriptor);
		}

		expect(result).toMatchObject({ state: "unavailable" });
		expect(result.message).toContain("deadline");
		expect(timerAdvanced).toBe(true);
		const pid = Number(await readFile(pidPath, "utf8"));
		expect(() => process.kill(pid, 0)).toThrow();
	});

	test("keeps the native addon import outside the parent adapter", async () => {
		const source = await readFile(new URL("./secrets-keyring.ts", import.meta.url), "utf8");
		expect(source).not.toContain('from "@napi-rs/keyring"');
		expect(source).not.toContain('require("@napi-rs/keyring")');
	});

	test("falls back to the encrypted local store when the native module is missing", async () => {
		const directory = await mkdtemp(join(tmpdir(), "signet-keyring-missing-module-"));
		directories.push(directory);
		process.env.SIGNET_PATH = directory;
		await useNativeModule(directory, join(directory, "missing-keyring.node"));

		const result = await getSecretKeyring(directory).get();
		expect(result).toMatchObject({ state: "unavailable" });
		await putLocalSecret("MISSING_MODULE_KEY", "local-value");
		expect(await getLocalSecretValue("MISSING_MODULE_KEY")).toBe("local-value");
		expect(await getLocalSecretProviderHealth()).toMatchObject({ status: "degraded" });
	});

	test("treats native module loader failures as unavailable before parsing their message", async () => {
		const directory = await mkdtemp(join(tmpdir(), "signet-keyring-loader-error-"));
		directories.push(directory);
		const modulePath = join(directory, "misleading-keyring-module.cjs");
		await writeFile(
			modulePath,
			'const error = new Error("native keyring module does not exist"); error.code = "MODULE_NOT_FOUND"; throw error;\n',
		);
		await useNativeModule(directory, modulePath);

		const result = await getSecretKeyring(directory).get();
		expect(result).toMatchObject({ state: "unavailable" });
	});

	test("keeps keyring-backed stores closed when the keyring is unavailable", async () => {
		const directory = await mkdtemp(join(tmpdir(), "signet-keyring-backed-store-"));
		directories.push(directory);
		process.env.SIGNET_PATH = directory;
		const secretsDirectory = join(directory, ".secrets");
		await mkdir(secretsDirectory, { recursive: true });
		await writeFile(
			join(secretsDirectory, "secrets.enc"),
			JSON.stringify({ version: 2, provider: "native-keyring", secrets: {} }),
		);
		setSecretKeyringAdapterForTests(fixedKeyring("unavailable"));

		await expect(getLocalSecretValue("MISSING_KEY")).rejects.toMatchObject({ state: "unavailable" });
	});

	test("does not fall back for locked or permission-denied keyrings", async () => {
		const directory = await mkdtemp(join(tmpdir(), "signet-keyring-denied-"));
		directories.push(directory);
		process.env.SIGNET_PATH = directory;

		for (const state of ["locked", "permission-denied"] as const) {
			setSecretKeyringAdapterForTests(fixedKeyring(state));
			await expect(putLocalSecret(`KEY_${state.replaceAll("-", "_")}`, "value")).rejects.toMatchObject({ state });
		}
	});
});
