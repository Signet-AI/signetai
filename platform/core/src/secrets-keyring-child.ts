import { createRequire } from "node:module";
import type { AsyncEntry } from "@napi-rs/keyring";
import { execFileSyncHidden } from "./child-process";

interface SecretKeyringChildRequest {
	readonly op: "get" | "set" | "status";
	readonly service: string;
	readonly account: string;
	readonly value?: string;
	readonly allowInteraction?: boolean;
}

const MAX_REQUEST_BYTES = 64 * 1024;
const require = createRequire(import.meta.url);

function safeError(error: unknown): string {
	return (error instanceof Error ? error.message : String(error)).replace(/[\r\n\0]/g, " ").slice(0, 500);
}

function classify(error: unknown): string {
	const detail = safeError(error).toLowerCase();
	if (/default keychain could not be found/.test(detail)) return "unavailable";
	if (/noentry|no entry|no such item|item.*not found|credential.*missing|does not exist/.test(detail)) return "missing";
	if (
		/-25308|-25293|locked|interaction|required|authfailed|authentication|passphrase|user name.*not correct|islocked|prompt/.test(
			detail,
		)
	)
		return "locked";
	if (/-128|user.*cancel|permission|access denied|denied/.test(detail)) return "permission-denied";
	if (/unsupported|not implemented|dbus|secret service|keyutils|connection|unavailable|no such file/.test(detail))
		return "unavailable";
	return "corrupt";
}

function loadModule(): typeof import("@napi-rs/keyring") {
	const override = process.env.SIGNET_KEYRING_NATIVE_MODULE_PATH?.trim();
	if (override !== undefined && override.length > 0) {
		const absolute =
			override.startsWith("/") || /^\\\\[^\\]+\\[^\\]+/.test(override) || /^[A-Za-z]:[\\/]/.test(override);
		if (!absolute) throw new Error("Native keyring module path must be absolute");
		return require(override) as typeof import("@napi-rs/keyring");
	}
	return require("@napi-rs/keyring") as typeof import("@napi-rs/keyring");
}

function probeSecretService(): boolean {
	const names = execFileSyncHidden("busctl", ["--user", "--no-pager", "--no-legend", "list"], {
		stdio: ["ignore", "pipe", "ignore"],
		encoding: "utf8",
		timeout: 1_000,
		maxBuffer: 64 * 1024,
	});
	if (!/^org\.freedesktop\.DBus\s/m.test(names)) throw new Error("Invalid D-Bus service inventory");
	return /^org\.freedesktop\.secrets\s/m.test(names);
}

export function linuxKeyringAvailability(
	platform: NodeJS.Platform = process.platform,
	env: NodeJS.ProcessEnv = process.env,
	probe: () => boolean = probeSecretService,
): { readonly state: "unavailable" | "unsupported"; readonly message: string; readonly backend?: "absent" } | null {
	if (platform !== "linux") return null;
	if (env.SIGNET_SECRETS_LINUX_KEYRING === "keyutils")
		return {
			state: "unsupported",
			message: "Linux keyutils is not an implicit Signet secrets backend",
			backend: "absent",
		};
	if (!env.DBUS_SESSION_BUS_ADDRESS)
		return { state: "unavailable", message: "Linux Secret Service requires a user D-Bus session", backend: "absent" };
	try {
		if (probe()) return null;
		return {
			state: "unavailable",
			message: "Linux Secret Service is neither registered nor activatable on the user D-Bus session",
			backend: "absent",
		};
	} catch {
		return { state: "unavailable", message: "Could not verify Linux Secret Service availability" };
	}
}

function parseRequest(raw: string): SecretKeyringChildRequest {
	const value = JSON.parse(raw) as Partial<SecretKeyringChildRequest>;
	if (value.op !== "get" && value.op !== "set" && value.op !== "status") throw new Error("Invalid keyring operation");
	if (typeof value.service !== "string" || value.service.length === 0 || value.service.length > 512)
		throw new Error("Invalid keyring service");
	if (typeof value.account !== "string" || value.account.length === 0 || value.account.length > 512)
		throw new Error("Invalid keyring account");
	if (value.op === "set" && (typeof value.value !== "string" || value.value.length > 16 * 1024))
		throw new Error("Invalid keyring value");
	if (value.allowInteraction !== undefined && typeof value.allowInteraction !== "boolean")
		throw new Error("Invalid keyring interaction permission");
	if (value.allowInteraction === true && value.op !== "get")
		throw new Error("Interaction is only allowed for key reads");
	return value as SecretKeyringChildRequest;
}

async function readRequest(): Promise<SecretKeyringChildRequest> {
	let raw = "";
	for await (const chunk of process.stdin) {
		raw += String(chunk);
		if (Buffer.byteLength(raw, "utf8") > MAX_REQUEST_BYTES) throw new Error("Keyring request exceeds its limit");
	}
	return parseRequest(raw.trim());
}

async function execute(request: SecretKeyringChildRequest): Promise<unknown> {
	const unavailable = linuxKeyringAvailability();
	if (unavailable !== null) return unavailable;
	let module: typeof import("@napi-rs/keyring");
	try {
		module = loadModule();
	} catch (error) {
		return { state: "unavailable", message: safeError(error) };
	}
	if (process.platform === "darwin") {
		const security = await import("bun:ffi")
			.then(({ dlopen, FFIType, ptr }) => ({
				ptr,
				library: dlopen("/System/Library/Frameworks/Security.framework/Security", {
					SecKeychainSetUserInteractionAllowed: { args: [FFIType.bool], returns: FFIType.i32 },
					SecKeychainGetUserInteractionAllowed: { args: [FFIType.ptr], returns: FFIType.i32 },
				}),
			}))
			.catch(() => null);
		if (security === null)
			return { state: "unavailable", message: "Could not initialize noninteractive macOS keychain access" };
		const previous = new Uint8Array(1);
		let restore = false;
		let restoreStatus = 0;
		let result: unknown;
		try {
			if (security.library.symbols.SecKeychainGetUserInteractionAllowed(security.ptr(previous)) !== 0)
				return { state: "unavailable", message: "Could not read macOS keychain interaction setting" };
			restore = true;
			const status = security.library.symbols.SecKeychainSetUserInteractionAllowed(request.allowInteraction === true);
			result =
				status !== 0
					? { state: "unavailable", message: "Could not set macOS keychain interaction permission" }
					: await executeEntry(request, module);
		} catch (error) {
			result = { state: classify(error), message: safeError(error) };
		} finally {
			restoreStatus = restore ? security.library.symbols.SecKeychainSetUserInteractionAllowed(previous[0] !== 0) : 0;
			security.library.close();
		}
		return restoreStatus !== 0
			? { state: "unavailable", message: "Could not restore macOS keychain interaction setting" }
			: result;
	}
	return executeEntry(request, module);
}

async function executeEntry(
	request: SecretKeyringChildRequest,
	module: typeof import("@napi-rs/keyring"),
): Promise<unknown> {
	const entry = new (module.AsyncEntry as typeof AsyncEntry)(
		request.service,
		request.account,
		process.platform === "linux" ? { linux: { store: "secret-service" } } : undefined,
	);
	if (request.op === "set") {
		await entry.setPassword(request.value ?? "");
		return { state: "found", value: request.value ?? "" };
	}
	const value = await entry.getPassword();
	return value === undefined || value === null || value.length === 0 ? { state: "missing" } : { state: "found", value };
}

export async function runSecretKeyringChild(): Promise<void> {
	try {
		const result = await execute(await readRequest());
		process.stdout.write(`${JSON.stringify({ ok: true, result })}\n`);
	} catch (error) {
		process.stdout.write(`${JSON.stringify({ ok: false, state: classify(error), message: safeError(error) })}\n`);
	}
}

if (import.meta.main) await runSecretKeyringChild();
