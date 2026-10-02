import { afterEach, describe, expect, test } from "bun:test";
import { closeSync, existsSync, openSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSyncHidden } from "./child-process";
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
	hasLocalSecret,
	listLocalSecretNames,
	deleteLocalSecret,
	putLocalSecret,
	setSecretKeyringAdapterForTests,
	setMachineIdResolverForTests,
} from "./secrets";

const directories: string[] = [];
const originalSignetPath = process.env.SIGNET_PATH;

afterEach(async () => {
	setSecretKeyringHelperForTests(null);
	resetSecretKeyringModuleForTests();
	setSecretKeyringAdapterForTests(null);
	setMachineIdResolverForTests(null);
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
	const childModule = fileURLToPath(new URL("./secrets-keyring-child.ts", import.meta.url));
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

		let result: SecretKeyringResult;
		try {
			result = await adapter.get();
		} finally {
			for (const descriptor of descriptors) closeSync(descriptor);
		}

		expect(result).toMatchObject({ state: "unavailable" });
		expect(result.message).toContain("deadline");
		expect(timerAdvanced).toBe(true);
		const pid = Number(await readFile(pidPath, "utf8"));
		expect(() => process.kill(pid, 0)).toThrow();
	});

	test("health observes access without launching a helper or returning key material", async () => {
		const directory = await mkdtemp(join(tmpdir(), "signet-keyring-observe-"));
		directories.push(directory);
		const countPath = join(directory, "calls");
		const helperPath = join(directory, "read.ts");
		const value = Buffer.alloc(32, 7).toString("base64");
		await writeFile(
			helperPath,
			`import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(countPath)}, "read\\n");
setTimeout(() => process.stdout.write(JSON.stringify({ ok: true, result: { state: "found", value: ${JSON.stringify(value)} } })), 100);
`,
		);
		setSecretKeyringHelperForTests({ entryPath: helperPath, deadlineMs: 2_000 });
		const adapter = getSecretKeyring(directory);
		expect(await adapter.getStatus?.()).toMatchObject({ state: "unchecked" });
		expect(existsSync(countPath)).toBe(false);
		const results = await Promise.all(Array.from({ length: 20 }, () => getSecretKeyring(directory).get()));
		expect(results.every((result) => result.value === value)).toBe(true);
		expect(await readFile(countPath, "utf8")).toBe("read\n");
		expect(await adapter.getStatus?.()).toEqual({ state: "found", message: undefined });
		expect(await readFile(countPath, "utf8")).toBe("read\n");
	});

	test("health retains validated master-key integrity without retaining key material or retrying reads", async () => {
		const directory = await mkdtemp(join(tmpdir(), "signet-keyring-integrity-"));
		directories.push(directory);
		process.env.SIGNET_PATH = directory;
		const secretsDirectory = join(directory, ".secrets");
		await mkdir(secretsDirectory);
		await writeFile(
			join(secretsDirectory, "secrets.enc"),
			JSON.stringify({
				version: 2,
				provider: "native-keyring",
				secrets: { EXISTING_KEY: { ciphertext: "fixture", created: "fixture", updated: "fixture" } },
			}),
		);
		const statePath = join(directory, "result.json");
		const callsPath = join(directory, "calls");
		const helperPath = join(directory, "read.ts");
		await writeFile(
			helperPath,
			`import { appendFileSync, readFileSync } from "node:fs";
appendFileSync(${JSON.stringify(callsPath)}, "read\\n");
process.stdout.write(JSON.stringify({ ok: true, result: JSON.parse(readFileSync(${JSON.stringify(statePath)}, "utf8")) }));
`,
		);
		setSecretKeyringHelperForTests({ entryPath: helperPath, deadlineMs: 2_000 });
		const adapter = getSecretKeyring(`workspace:${directory}`);
		for (const value of [undefined, "malformed-keyring-value", `${"A".repeat(43)}!`]) {
			await writeFile(statePath, JSON.stringify({ state: "found", value }));
			await expect(getLocalSecretValue("EXISTING_KEY")).rejects.toMatchObject({ state: "corrupt" });
			const calls = await readFile(callsPath, "utf8");
			expect(await adapter.getStatus?.()).toMatchObject({ state: "corrupt" });
			expect((await adapter.getStatus?.())?.value).toBeUndefined();
			expect(await getLocalSecretProviderHealth()).toMatchObject({ status: "unhealthy" });
			expect(await readFile(callsPath, "utf8")).toBe(calls);
		}
		await writeFile(statePath, JSON.stringify({ state: "found", value: Buffer.alloc(32, 7).toString("base64") }));
		await adapter.get();
		const calls = await readFile(callsPath, "utf8");
		expect(await getLocalSecretProviderHealth()).toMatchObject({ status: "healthy" });
		expect((await adapter.getStatus?.())?.value).toBeUndefined();
		expect(await readFile(callsPath, "utf8")).toBe(calls);
	});

	test("macOS native calls run with Security.framework interaction disabled", async () => {
		if (process.platform !== "darwin") return;
		const directory = await mkdtemp(join(tmpdir(), "signet-keyring-no-ui-"));
		directories.push(directory);
		const modulePath = join(directory, "probe.cjs");
		const restoredPath = join(directory, "restored");
		await writeFile(
			modulePath,
			`const { dlopen, FFIType, ptr } = require("bun:ffi");
const security = dlopen("/System/Library/Frameworks/Security.framework/Security", {
  SecKeychainGetUserInteractionAllowed: { args: [FFIType.ptr], returns: FFIType.i32 },
  SecKeychainSetUserInteractionAllowed: { args: [FFIType.bool], returns: FFIType.i32 }
});
const initial = new Uint8Array(1);
security.symbols.SecKeychainGetUserInteractionAllowed(ptr(initial));
process.once("beforeExit", () => {
  const restored = new Uint8Array(1);
  security.symbols.SecKeychainGetUserInteractionAllowed(ptr(restored));
  require("node:fs").appendFileSync(${JSON.stringify(restoredPath)}, String(restored[0]));
});
function probe() {
  const allowed = new Uint8Array([1]);
  const status = security.symbols.SecKeychainGetUserInteractionAllowed(ptr(allowed));
  if (status !== 0 || allowed[0] !== 0) throw new Error("interaction still enabled");
}
module.exports.AsyncEntry = class {
  constructor() { probe(); }
  async getPassword() { probe(); throw new Error("User interaction is not allowed"); }
  async setPassword() { probe(); throw new Error("User interaction is not allowed"); }
};
`,
		);
		await useNativeModule(directory, modulePath);
		const adapter = getSecretKeyring(directory);
		expect(await adapter.get()).toMatchObject({ state: "locked", message: "User interaction is not allowed" });
		expect(await adapter.set("fixture")).toMatchObject({ state: "locked", message: "User interaction is not allowed" });
		const binary = join(directory, "compiled-helper");
		const helperPath = join(directory, "keyring-helper.ts");
		const build = spawnSyncHidden(
			process.execPath,
			["build", "--compile", "--external", "@napi-rs/keyring", helperPath, "--outfile", binary],
			{ encoding: "utf8", timeout: 30_000 },
		);
		if (build.status !== 0) throw new Error(build.stderr);
		for (const op of ["get", "set"] as const) {
			const result = spawnSyncHidden(binary, [], {
				input: JSON.stringify({ op, service: "fixture", account: "fixture", value: "fixture" }),
				encoding: "utf8",
				timeout: 10_000,
			});
			expect(result.status).toBe(0);
			const response = JSON.parse(result.stdout);
			expect(response.result ?? response).toMatchObject({
				state: "locked",
				message: "User interaction is not allowed",
			});
		}
		expect(await readFile(restoredPath, "utf8")).toBe("1111");
		const source = await readFile(modulePath, "utf8");
		await writeFile(
			modulePath,
			source.replace(
				"const initial =",
				"security.symbols.SecKeychainSetUserInteractionAllowed(false);\nconst initial =",
			),
		);
		expect(await adapter.get()).toMatchObject({ state: "locked" });
		expect(await readFile(restoredPath, "utf8")).toBe("11110");
	}, 40_000);

	test("missing secret lookups never access or create a keyring item", async () => {
		const directory = await mkdtemp(join(tmpdir(), "signet-keyring-absent-"));
		directories.push(directory);
		process.env.SIGNET_PATH = directory;
		const helperPath = join(directory, "must-not-run.ts");
		const callsPath = join(directory, "calls");
		await writeFile(
			helperPath,
			`import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(callsPath)}, "unexpected keyring access");`,
		);
		setSecretKeyringHelperForTests({ entryPath: helperPath, deadlineMs: 100 });
		for (const name of ["BITWARDEN_SESSION", "constructor", "toString", "valueOf", "__proto__"]) {
			expect(hasLocalSecret(name)).toBe(false);
			await expect(getLocalSecretValue(name)).rejects.toThrow("not found");
		}
		expect(existsSync(callsPath)).toBe(false);
	});
	test("legacy reads wait for an admitted write and check the committed store before accessing the keyring", async () => {
		const directory = await mkdtemp(join(tmpdir(), "signet-keyring-order-"));
		directories.push(directory);
		process.env.SIGNET_PATH = directory;
		setMachineIdResolverForTests(() => "fixture");
		await mkdir(join(directory, ".secrets"));
		await writeFile(join(directory, ".secrets", "secrets.enc"), JSON.stringify({ version: 1, secrets: {} }));
		let enter = (): void => {};
		const entered = new Promise<void>((resolve) => {
			enter = resolve;
		});
		let release = (): void => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		setSecretKeyringAdapterForTests({
			...fixedKeyring("found"),
			async get() {
				enter();
				await gate;
				return { state: "found", value: Buffer.alloc(32, 7).toString("base64") };
			},
		});
		const put = putLocalSecret("NEW_KEY", "fixture-value");
		await entered;
		const read = getLocalSecretValue("NEW_KEY");
		let settled = false;
		void read.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		try {
			await new Promise<void>((resolve) => setTimeout(resolve, 20));
			expect(settled).toBe(false);
			release();
			await put;
			expect(await read).toBe("fixture-value");
		} finally {
			release();
			await Promise.allSettled([put, read]);
		}
	});
	test("supported prototype-like names survive encrypted store round trips", async () => {
		const directory = await mkdtemp(join(tmpdir(), "signet-keyring-names-"));
		directories.push(directory);
		process.env.SIGNET_PATH = directory;
		setSecretKeyringAdapterForTests({
			...fixedKeyring("found"),
			async get() {
				return { state: "found", value: Buffer.alloc(32, 7).toString("base64") };
			},
		});
		const names = ["constructor", "toString", "valueOf", "__proto__"];
		for (const name of names) await putLocalSecret(name, `fixture-${name}`);
		expect(listLocalSecretNames()).toEqual([...names].sort());
		for (const name of names) {
			expect(hasLocalSecret(name)).toBe(true);
			expect(await getLocalSecretValue(name)).toBe(`fixture-${name}`);
			expect(await deleteLocalSecret(name)).toBe(true);
			expect(hasLocalSecret(name)).toBe(false);
		}
		expect(listLocalSecretNames()).toEqual([]);
	});
	test("keeps the native addon import outside the parent adapter", async () => {
		const source = await readFile(new URL("./secrets-keyring.ts", import.meta.url), "utf8");
		expect(source).not.toContain('from "@napi-rs/keyring"');
		expect(source).not.toContain('require("@napi-rs/keyring")');
	});

	test("refuses to create secrets when the native keyring is unavailable", async () => {
		const directory = await mkdtemp(join(tmpdir(), "signet-keyring-missing-module-"));
		directories.push(directory);
		process.env.SIGNET_PATH = directory;
		await useNativeModule(directory, join(directory, "missing-keyring.node"));

		const result = await getSecretKeyring(directory).get();
		expect(result).toMatchObject({ state: "unavailable" });
		await expect(putLocalSecret("MISSING_MODULE_KEY", "local-value")).rejects.toMatchObject({ state: "unavailable" });
		expect(existsSync(join(directory, ".secrets", "secrets.enc"))).toBe(false);
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
			JSON.stringify({
				version: 2,
				provider: "native-keyring",
				secrets: { EXISTING_KEY: { ciphertext: "fixture", created: "fixture", updated: "fixture" } },
			}),
		);
		setSecretKeyringAdapterForTests(fixedKeyring("unavailable"));

		await expect(getLocalSecretValue("EXISTING_KEY")).rejects.toMatchObject({ state: "unavailable" });
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
