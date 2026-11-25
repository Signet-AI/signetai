import { resolveSignetDaemonUrl } from "@signet/core/daemon-url";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { credentialKeyring, type SecretKeyringAdapter } from "@signet/core/secrets-keyring";
import { SignetApiError, SignetUnauthorizedError } from "../errors.js";
import { SignetTransport, type RequestControl } from "../transport.js";
import {
	atomicPrivateWrite,
	configDirectory,
	originHash,
	readPrivate,
	type StorageOptions,
	withFileLock,
} from "./storage.js";

export interface LoginCredential {
	readonly accessToken: string;
	readonly refreshToken: string;
	readonly accessExpiresAt: string;
	readonly refreshExpiresAt: string;
}
export type LoginSource = "keychain" | "login-file";
export type LoginKeyring = Pick<SecretKeyringAdapter, "get" | "set">;
export interface LoginStoreOptions extends StorageOptions {
	readonly keyring?: LoginKeyring;
}
export function parseLogin(value: unknown): LoginCredential {
	if (
		typeof value !== "object" ||
		value === null ||
		!("accessToken" in value) ||
		typeof value.accessToken !== "string" ||
		!value.accessToken ||
		!("refreshToken" in value) ||
		typeof value.refreshToken !== "string" ||
		!value.refreshToken ||
		!("accessExpiresAt" in value) ||
		typeof value.accessExpiresAt !== "string" ||
		!Number.isFinite(Date.parse(value.accessExpiresAt)) ||
		!("refreshExpiresAt" in value) ||
		typeof value.refreshExpiresAt !== "string" ||
		!Number.isFinite(Date.parse(value.refreshExpiresAt))
	)
		throw new Error("Invalid Signet login credential");
	return {
		accessToken: value.accessToken,
		refreshToken: value.refreshToken,
		accessExpiresAt: value.accessExpiresAt,
		refreshExpiresAt: value.refreshExpiresAt,
	};
}
export class LoginStore {
	readonly origin: string;
	readonly path: string;
	private readonly keyring: LoginKeyring;
	private observedSource: LoginSource | "none" = "none";
	private observedReason: string | null = null;
	get reason(): string | null {
		return this.observedReason;
	}
	get source(): LoginSource | "none" {
		return this.observedSource;
	}
	constructor(origin: string, options: LoginStoreOptions = {}) {
		this.origin = new URL(resolveSignetDaemonUrl({ env: {}, configUrl: origin })).origin;
		this.path = join(configDirectory(options), "login", `${originHash(this.origin)}.json`);
		this.keyring = options.keyring ?? credentialKeyring("signet-login", this.origin);
	}
	async load(control: RequestControl = {}): Promise<{ source: LoginSource; credential: LoginCredential } | null> {
		this.observedSource = "none";
		this.observedReason = null;
		const fallback = await readPrivate(this.path);
		if (fallback !== null) {
			const value: unknown = JSON.parse(fallback);
			if (value === null) return null;
			const credential = parseLogin(value);
			this.observedSource = "login-file";
			this.observedReason =
				typeof value === "object" &&
				"fallbackReason" in value &&
				typeof value.fallbackReason === "string" &&
				/^keyring_(unchecked|missing|locked|unavailable|permission-denied|corrupt|unsupported)$/.test(
					value.fallbackReason,
				)
					? value.fallbackReason
					: "protected_login_file";
			return { source: "login-file", credential };
		}
		const result = await this.keyring.get({ signal: control.signal });
		if (result.state === "missing" || result.state === "unavailable" || result.state === "unsupported") {
			this.observedReason = result.state === "missing" ? null : `keyring_${result.state}`;
			return null;
		}
		if (result.state !== "found" || !result.value) throw new Error(`Signet login keychain ${result.state}`);
		const value: unknown = JSON.parse(result.value);
		if (value === null) return null;
		const credential = parseLogin(value);
		this.observedSource = "keychain";
		return { source: "keychain", credential };
	}
	async save(value: LoginCredential): Promise<LoginSource> {
		return withFileLock(`${this.path}.lock`, () => this.write(parseLogin(value)));
	}
	private async write(value: LoginCredential): Promise<LoginSource> {
		const encoded = JSON.stringify(value);
		const result = await this.keyring.set(encoded);
		if (result.state === "found") {
			await rm(this.path, { force: true });
			this.observedSource = "keychain";
			this.observedReason = null;
			return "keychain";
		}
		const fallbackReason = `keyring_${result.state}`;
		await atomicPrivateWrite(this.path, JSON.stringify({ ...value, fallbackReason }));
		this.observedSource = "login-file";
		this.observedReason = fallbackReason;
		return "login-file";
	}
	async clear(): Promise<void> {
		await withFileLock(`${this.path}.lock`, async () => {
			const result = await this.keyring.set("null");
			if (result.state === "found") await rm(this.path, { force: true });
			else await atomicPrivateWrite(this.path, "null");
			this.observedSource = "none";
			this.observedReason = null;
		});
	}
	async accessToken(control: RequestControl = {}): Promise<string | null> {
		const saved = await this.load(control);
		if (!saved) return null;
		if (Date.parse(saved.credential.accessExpiresAt) > Date.now()) return saved.credential.accessToken;
		return this.refresh(saved.credential.accessToken, control);
	}
	async refresh(rejectedAccessToken?: string | null, control: RequestControl = {}): Promise<string> {
		return withFileLock(
			`${this.path}.lock`,
			async () => {
				const saved = await this.load(control);
				if (!saved) throw new SignetUnauthorizedError("missing_credential");
				const current = saved.credential;
				if (current.accessToken !== rejectedAccessToken && Date.parse(current.accessExpiresAt) > Date.now())
					return current.accessToken;
				if (Date.parse(current.refreshExpiresAt) <= Date.now()) throw new SignetUnauthorizedError("expired");
				try {
					const transport = new SignetTransport({ baseUrl: this.origin, retries: 0 });
					const rotated = parseLogin(
						await transport.post("/api/auth/refresh", { refreshToken: current.refreshToken }, control),
					);
					await this.write(rotated);
					return rotated.accessToken;
				} catch (error) {
					const body = error instanceof SignetApiError ? error.body : undefined;
					const reason =
						error instanceof SignetUnauthorizedError
							? error.reason
							: typeof body === "object" && body !== null && "reason" in body && typeof body.reason === "string"
								? body.reason
								: "expired";
					throw new SignetUnauthorizedError(reason, body, { cause: error });
				}
			},
			control.signal,
		);
	}
}
