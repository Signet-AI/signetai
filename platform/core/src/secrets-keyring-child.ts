import { createRequire } from "node:module";
import type { AsyncEntry } from "@napi-rs/keyring";
import { execFileSyncHidden } from "./child-process";

interface SecretKeyringChildRequest {
	readonly op: "get" | "set" | "status";
	readonly service: string;
	readonly account: string;
	readonly value?: string;
}

const MAX_REQUEST_BYTES = 64 * 1024;
const require = createRequire(import.meta.url);

function safeError(error: unknown): string {
	return (error instanceof Error ? error.message : String(error)).replace(/[\r\n\0]/g, " ").slice(0, 500);
}

function classify(error: unknown): string {
	const detail = safeError(error).toLowerCase();
	if (/noentry|no entry|no such item|item.*not found|credential.*missing|does not exist/.test(detail)) return "missing";
	if (/locked|interaction|required|authfailed|authentication|islocked|prompt/.test(detail)) return "locked";
	if (/permission|access denied|denied/.test(detail)) return "permission-denied";
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

function linuxAvailability(): { readonly state: string; readonly message: string } | null {
	if (process.platform !== "linux") return null;
	if (process.env.SIGNET_SECRETS_LINUX_KEYRING === "keyutils")
		return { state: "unsupported", message: "Linux keyutils is not an implicit Signet secrets backend" };
	if (!process.env.DBUS_SESSION_BUS_ADDRESS)
		return { state: "unavailable", message: "Linux Secret Service requires a user D-Bus session" };
	try {
		execFileSyncHidden("busctl", ["--user", "status", "org.freedesktop.secrets"], {
			stdio: "ignore",
			timeout: 1_000,
		});
		return null;
	} catch {
		return { state: "unavailable", message: "Linux Secret Service is not registered on the user D-Bus session" };
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
	const unavailable = linuxAvailability();
	if (unavailable !== null) return unavailable;
	const module = loadModule();
	const entry = new (module.AsyncEntry as typeof AsyncEntry)(request.service, request.account);
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
