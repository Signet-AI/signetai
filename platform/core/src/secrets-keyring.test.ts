import { afterEach, describe, expect, test } from "bun:test";
import { closeSync, existsSync, openSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSyncHidden } from "./child-process";
import { linuxKeyringAvailability } from "./secrets-keyring-child";
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

function fixedKeyring(state: SecretKeyringState, backend?: "absent"): SecretKeyringAdapter {
	const result: SecretKeyringResult = { state, message: `test keyring ${state}`, ...(backend ? { backend } : {}) };
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
		setSecretKeyringHelperForTests({ entryPath: helperPath, deadlineMs: 1000 });
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

	test("foreground saves authorize existing keys once while background saves and missing v2 keys fail closed", async () => {
		const directory = await mkdtemp(join(tmpdir(), "signet-keyring-foreground-"));
		directories.push(directory);
		process.env.SIGNET_PATH = directory;
		const key = Buffer.alloc(32, 7).toString("base64");
		let locked = false;
		let missing = false;
		let persistAuthorization = true;
		let writes = 0;
		const permissions: boolean[] = [];
		setSecretKeyringAdapterForTests({
			platform: "darwin",
			service: "test",
			account: "test",
			async get(options) {
				permissions.push(options?.allowInteraction === true);
				if (options?.allowInteraction && persistAuthorization) locked = false;
				return missing
					? { state: "missing" }
					: locked && !options?.allowInteraction
						? { state: "locked" }
						: { state: "found", value: key };
			},
			async set() {
				writes++;
				return { state: "found", value: key };
			},
		});
		await putLocalSecret("EXISTING", "fixture-existing");
		const file = join(directory, ".secrets", "secrets.enc");
		const original = await readFile(file, "utf8");
		locked = true;
		await expect(putLocalSecret("NEW", "fixture-new")).rejects.toThrow("locked");
		expect(await readFile(file, "utf8")).toBe(original);
		permissions.length = 0;
		persistAuthorization = false;
		await expect(putLocalSecret("ONCE", "fixture-once", { allowInteraction: true })).rejects.toThrow("Always Allow");
		expect(permissions).toEqual([false, true, false]);
		expect(await readFile(file, "utf8")).toBe(original);
		permissions.length = 0;
		await expect(
			putLocalSecret("CANCELLED", "fixture-cancel", {
				allowInteraction: true,
				onKeyringAuthorization: async () => {
					throw new Error("Authorization cancelled");
				},
			}),
		).rejects.toThrow("Authorization cancelled");
		expect(permissions).toEqual([false]);
		expect(await readFile(file, "utf8")).toBe(original);
		persistAuthorization = true;
		permissions.length = 0;
		await putLocalSecret("NEW", "fixture-new", { allowInteraction: true });
		expect(permissions).toEqual([false, true, false]);
		locked = false;
		expect(await getLocalSecretValue("EXISTING")).toBe("fixture-existing");
		expect(await getLocalSecretValue("NEW")).toBe("fixture-new");
		const saved = await readFile(file, "utf8");
		permissions.length = 0;
		missing = true;
		await expect(putLocalSecret("LOST", "fixture-lost", { allowInteraction: true })).rejects.toThrow("missing");
		expect(permissions).toEqual([false]);
		expect(await readFile(file, "utf8")).toBe(saved);
		expect(writes).toBe(0);
	});

	test("non-macOS locked keyrings never request macOS authorization", async () => {
		const directory = await mkdtemp(join(tmpdir(), "signet-keyring-nonmac-"));
		directories.push(directory);
		process.env.SIGNET_PATH = directory;
		let reads = 0;
		let confirmations = 0;
		setSecretKeyringAdapterForTests({
			platform: "linux",
			service: "test",
			account: "test",
			async get() {
				reads++;
				return { state: "locked" };
			},
			async set() {
				throw new Error("Unexpected key write");
			},
		});
		await expect(
			putLocalSecret("NEW", "fixture", {
				allowInteraction: true,
				onKeyringAuthorization: async () => {
					confirmations++;
				},
			}),
		).rejects.toThrow("locked");
		expect(reads).toBe(1);
		expect(confirmations).toBe(0);
	});

	test("macOS explicit authorization enables interaction only for a cancellable admitted read", async () => {
		if (process.platform !== "darwin") return;
		const directory = await mkdtemp(join(tmpdir(), "signet-keyring-consent-"));
		directories.push(directory);
		const modulePath = join(directory, "consent.cjs");
		await writeFile(
			modulePath,
			`const {dlopen,FFIType,ptr}=require("bun:ffi");
const security=dlopen("/System/Library/Frameworks/Security.framework/Security",{
SecKeychainGetUserInteractionAllowed:{args:[FFIType.ptr],returns:FFIType.i32}});
module.exports.AsyncEntry=class {
async getPassword(){const allowed=new Uint8Array(1);security.symbols.SecKeychainGetUserInteractionAllowed(ptr(allowed));
if(!allowed[0])throw Error("User interaction is not allowed");
require("node:fs").writeFileSync(${JSON.stringify(join(directory, "started"))},"started");
await new Promise(()=>{});}
};`,
		);
		await useNativeModule(directory, modulePath);
		const adapter = getSecretKeyring(directory);
		expect(await adapter.get()).toMatchObject({ state: "locked" });
		const controller = new AbortController();
		const pending = adapter.get({ allowInteraction: true, signal: controller.signal });
		for (let i = 0; i < 100 && !existsSync(join(directory, "started")); i++) await Bun.sleep(10);
		expect(existsSync(join(directory, "started"))).toBe(true);
		expect(await adapter.get({ allowInteraction: true })).toMatchObject({
			state: "unavailable",
			message: "A keychain authorization request is already in progress",
		});
		controller.abort();
		expect(await pending).toMatchObject({ state: "unavailable", message: "Keyring request cancelled" });
		expect(await adapter.get({ allowInteraction: true, signal: controller.signal })).toMatchObject({
			state: "unavailable",
			message: "Keyring request cancelled",
		});
		expect(await adapter.get()).toMatchObject({ state: "locked" });
	});

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
		setSecretKeyringHelperForTests({ entryPath: helperPath, deadlineMs: 1000 });
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

	test("a missing default macOS keychain is unavailable, while unknown errors remain corrupt", async () => {
		const directory = await mkdtemp(join(tmpdir(), "signet-keyring-no-default-"));
		directories.push(directory);
		process.env.SIGNET_PATH = directory;
		const modulePath = join(directory, "no-default.cjs");
		await writeFile(
			modulePath,
			'module.exports.AsyncEntry = class { async getPassword() { throw new Error("Platform failure: A default keychain could not be found."); } };',
		);
		await useNativeModule(directory, modulePath);
		expect(await getSecretKeyring(directory).get()).toMatchObject({ state: "unavailable" });
		await expect(putLocalSecret("NEW", "fixture")).rejects.toMatchObject({ state: "unavailable" });
		expect(existsSync(join(directory, ".secrets", "secrets.enc"))).toBe(false);
		const unknownPath = join(directory, "unknown.cjs");
		await writeFile(
			unknownPath,
			'module.exports.AsyncEntry = class { async getPassword() { throw new Error("Platform failure: unknown native failure"); } };',
		);
		await useNativeModule(directory, unknownPath);
		expect(await getSecretKeyring(directory).get()).toMatchObject({ state: "corrupt" });
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

	test("falls back to the machine-id store only when the host has no keyring backend", async () => {
		const headless = await mkdtemp(join(tmpdir(), "signet-keyring-headless-"));
		directories.push(headless);
		process.env.SIGNET_PATH = headless;
		setSecretKeyringAdapterForTests(fixedKeyring("unavailable", "absent"));
		await putLocalSecret("HEADLESS_KEY", "headless-value");
		const store = JSON.parse(await readFile(join(headless, ".secrets", "secrets.enc"), "utf8")) as {
			version: number;
			provider: string;
		};
		expect(store).toMatchObject({ version: 1, provider: "legacy-obfuscated" });
		expect(await getLocalSecretValue("HEADLESS_KEY")).toBe("headless-value");

		const transient = await mkdtemp(join(tmpdir(), "signet-keyring-transient-"));
		directories.push(transient);
		process.env.SIGNET_PATH = transient;
		setSecretKeyringAdapterForTests(fixedKeyring("unavailable"));
		await expect(putLocalSecret("TRANSIENT_KEY", "value")).rejects.toMatchObject({ state: "unavailable" });
		expect(existsSync(join(transient, ".secrets", "secrets.enc"))).toBe(false);
	});

	test("reports a missing keyring backend only for Linux hosts without Secret Service", () => {
		const reachable = () => {};
		const unregistered = () => {
			throw new Error("org.freedesktop.secrets is not registered");
		};
		const session = { DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus" };
		expect(linuxKeyringAvailability("darwin", {}, unregistered)).toBeNull();
		expect(linuxKeyringAvailability("win32", {}, unregistered)).toBeNull();
		expect(linuxKeyringAvailability("linux", session, reachable)).toBeNull();
		expect(linuxKeyringAvailability("linux", {}, reachable)).toMatchObject({ state: "unavailable", backend: "absent" });
		expect(linuxKeyringAvailability("linux", session, unregistered)).toMatchObject({
			state: "unavailable",
			backend: "absent",
		});
		expect(linuxKeyringAvailability("linux", { SIGNET_SECRETS_LINUX_KEYRING: "keyutils" }, reachable)).toMatchObject({
			state: "unsupported",
			backend: "absent",
		});
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
