import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import type { AsyncEntry } from "@napi-rs/keyring";

export type SecretKeyringState =
	| "found"
	| "missing"
	| "locked"
	| "unavailable"
	| "permission-denied"
	| "corrupt"
	| "unsupported";

export interface SecretKeyringResult {
	readonly state: SecretKeyringState;
	readonly value?: string;
	readonly message?: string;
}

export interface SecretKeyringAdapter {
	readonly platform: string;
	readonly service: string;
	readonly account: string;
	get(): Promise<SecretKeyringResult>;
	set(value: string): Promise<SecretKeyringResult>;
}

const SERVICE = "ai.signet.secrets";
let modulePromise: Promise<typeof import("@napi-rs/keyring") | null> | null = null;
let adapterForTests: SecretKeyringAdapter | null = null;

function workspaceAccount(workspace: string): string {
	return createHash("sha256").update(workspace).digest("hex").slice(0, 32);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function classifyError(error: unknown): SecretKeyringResult {
	const message = errorMessage(error);
	const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
	const detail = `${code} ${message}`.toLowerCase();

	if (/noentry|no entry|no such item|item.*not found|credential.*missing|does not exist/.test(detail)) {
		return { state: "missing", message };
	}
	if (/locked|interaction|required|authfailed|authentication|islocked|prompt/.test(detail)) {
		return { state: "locked", message };
	}
	if (/permission|access denied|denied/.test(detail)) {
		return { state: "permission-denied", message };
	}
	if (/unsupported|not implemented|dbus|secret service|keyutils|connection|unavailable|no such file/.test(detail)) {
		return { state: "unavailable", message };
	}
	return { state: "corrupt", message };
}

async function loadModule(): Promise<typeof import("@napi-rs/keyring") | null> {
	modulePromise ??= import("@napi-rs/keyring").catch(() => null);
	return modulePromise;
}

function linuxKeyringAvailable(): SecretKeyringResult | null {
	if (process.platform !== "linux") return null;
	if (process.env.SIGNET_SECRETS_LINUX_KEYRING === "keyutils") {
		return { state: "unsupported", message: "Linux keyutils is not an implicit Signet secrets backend" };
	}
	if (!process.env.DBUS_SESSION_BUS_ADDRESS) {
		return {
			state: "unavailable",
			message: "Linux Secret Service requires a user D-Bus session; no prompt or desktop session is available",
		};
	}
	try {
		execFileSync("busctl", ["--user", "status", "org.freedesktop.secrets"], {
			stdio: "ignore",
			timeout: 1_000,
		});
		return null;
	} catch {
		return {
			state: "unavailable",
			message: "Linux Secret Service is not registered on the user D-Bus session",
		};
	}
}

class NativeSecretKeyringAdapter implements SecretKeyringAdapter {
	readonly platform = process.platform;
	readonly service = SERVICE;
	readonly account: string;

	constructor(workspace: string) {
		this.account = workspaceAccount(workspace);
	}

	private async entry(): Promise<AsyncEntry | null> {
		const mod = await loadModule();
		if (!mod) return null;
		return new mod.AsyncEntry(this.service, this.account);
	}

	async get(): Promise<SecretKeyringResult> {
		const linuxUnavailable = linuxKeyringAvailable();
		if (linuxUnavailable) return linuxUnavailable;
		try {
			const entry = await this.entry();
			if (!entry)
				return { state: "unsupported", message: "The native keyring module is not installed for this platform" };
			const value = await entry.getPassword();
			return value === undefined || value === null || value.length === 0
				? { state: "missing" }
				: { state: "found", value };
		} catch (error) {
			return classifyError(error);
		}
	}

	async set(value: string): Promise<SecretKeyringResult> {
		const linuxUnavailable = linuxKeyringAvailable();
		if (linuxUnavailable) return linuxUnavailable;
		try {
			const entry = await this.entry();
			if (!entry)
				return { state: "unsupported", message: "The native keyring module is not installed for this platform" };
			await entry.setPassword(value);
			return { state: "found", value };
		} catch (error) {
			return classifyError(error);
		}
	}
}

export function getSecretKeyring(workspace: string): SecretKeyringAdapter {
	return adapterForTests ?? new NativeSecretKeyringAdapter(workspace);
}

export function setSecretKeyringForTests(adapter: SecretKeyringAdapter | null): void {
	adapterForTests = adapter;
	modulePromise = null;
}

export function resetSecretKeyringModuleForTests(): void {
	modulePromise = null;
}
