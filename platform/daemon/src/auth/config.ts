/**
 * Auth configuration parsing from agent.yaml.
 */

import { join } from "node:path";
import type { AuthMode } from "./types";
import { DEFAULT_RATE_LIMITS, type RateLimitConfig } from "./rate-limiter";

export interface PasswordLoginConfig {
	readonly username: string;
	readonly passwordHash: string | null;
}

export interface AuthLoginConfig {
	readonly password: PasswordLoginConfig;
	readonly sso: { readonly enabled: boolean };
	readonly saml: { readonly enabled: boolean };
}

export interface AuthConfig {
	readonly mode: AuthMode;
	readonly secretPath: string;
	readonly rateLimits: Readonly<Record<string, RateLimitConfig>>;
	readonly defaultTokenTtlSeconds: number;
	readonly sessionTokenTtlSeconds: number;
	readonly login: AuthLoginConfig;
}

const DEFAULT_LOGIN_CONFIG: AuthLoginConfig = {
	password: {
		username: "admin",
		passwordHash: null,
	},
	sso: { enabled: false },
	saml: { enabled: false },
};

const DEFAULT_AUTH_CONFIG: AuthConfig = {
	mode: "local",
	secretPath: "",
	rateLimits: DEFAULT_RATE_LIMITS,
	defaultTokenTtlSeconds: 7 * 24 * 60 * 60, // 7 days
	sessionTokenTtlSeconds: 24 * 60 * 60, // 24 hours
	login: DEFAULT_LOGIN_CONFIG,
};

class AuthConfigValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AuthConfigValidationError";
	}
}

function isValidMode(val: unknown): val is AuthMode {
	return val === "local" || val === "team" || val === "hybrid";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function reject(field: string, reason: string): never {
	throw new AuthConfigValidationError(`${field} ${reason}`);
}

function validatePositiveNumber(value: unknown, field: string): void {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
		reject(field, "must be a positive finite number");
}

function validateAuthConfig(raw: Record<string, unknown>): AuthMode {
	const mode = raw.mode === undefined ? "local" : raw.mode;
	if (!isValidMode(mode)) {
		reject("auth.mode", "must be local, team, or hybrid");
	}

	if (raw.rateLimits !== undefined) {
		if (!isRecord(raw.rateLimits)) reject("auth.rateLimits", "must be a mapping");
		for (const [name, value] of Object.entries(raw.rateLimits)) {
			if (!isRecord(value)) reject(`auth.rateLimits.${name}`, "must be a mapping");
			for (const field of ["windowMs", "max"] as const) {
				if (value[field] !== undefined) validatePositiveNumber(value[field], `auth.rateLimits.${name}.${field}`);
			}
		}
	}
	for (const field of ["defaultTokenTtlSeconds", "sessionTokenTtlSeconds"] as const) {
		if (raw[field] !== undefined) validatePositiveNumber(raw[field], `auth.${field}`);
	}

	if (raw.login !== undefined) {
		if (!isRecord(raw.login)) reject("auth.login", "must be a mapping");
		for (const section of ["password", "sso", "saml"] as const) {
			const value = raw.login[section];
			if (value !== undefined && !isRecord(value)) reject(`auth.login.${section}`, "must be a mapping");
		}
		const password = raw.login.password;
		if (isRecord(password)) {
			for (const field of ["username", "passwordHash"] as const) {
				if (password[field] !== undefined && typeof password[field] !== "string") {
					reject(`auth.login.password.${field}`, "must be a string");
				}
			}
		}
		for (const section of ["sso", "saml"] as const) {
			const value = raw.login[section];
			if (isRecord(value) && value.enabled !== undefined && typeof value.enabled !== "boolean") {
				reject(`auth.login.${section}.enabled`, "must be a boolean");
			}
		}
	}
	if (raw.adminUser !== undefined) {
		if (!isRecord(raw.adminUser)) reject("auth.adminUser", "must be a mapping");
		for (const field of ["username", "passwordHash"] as const) {
			if (raw.adminUser[field] !== undefined && typeof raw.adminUser[field] !== "string") {
				reject(`auth.adminUser.${field}`, "must be a string");
			}
		}
	}
	return mode;
}

function parseRateLimit(raw: unknown, fallback: RateLimitConfig): RateLimitConfig {
	if (!raw || typeof raw !== "object") return fallback;
	const obj = raw as Record<string, unknown>;
	return {
		windowMs: typeof obj.windowMs === "number" && obj.windowMs > 0 ? obj.windowMs : fallback.windowMs,
		max: typeof obj.max === "number" && obj.max > 0 ? obj.max : fallback.max,
	};
}

function nonEmptyString(value: unknown): string | null {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function parseLoginConfig(raw: Record<string, unknown>): AuthLoginConfig {
	const login = raw.login && typeof raw.login === "object" ? (raw.login as Record<string, unknown>) : {};
	const password =
		login.password && typeof login.password === "object" ? (login.password as Record<string, unknown>) : {};
	const sso = login.sso && typeof login.sso === "object" ? (login.sso as Record<string, unknown>) : {};
	const saml = login.saml && typeof login.saml === "object" ? (login.saml as Record<string, unknown>) : {};
	const legacyAdmin =
		raw.adminUser && typeof raw.adminUser === "object" ? (raw.adminUser as Record<string, unknown>) : {};

	return {
		password: {
			username:
				nonEmptyString(password.username) ??
				nonEmptyString(legacyAdmin.username) ??
				DEFAULT_LOGIN_CONFIG.password.username,
			passwordHash: nonEmptyString(password.passwordHash) ?? nonEmptyString(legacyAdmin.passwordHash),
		},
		sso: { enabled: sso.enabled === true },
		saml: { enabled: saml.enabled === true },
	};
}

export function parseAuthConfig(raw: unknown, agentsDir: string): AuthConfig {
	if (raw === undefined) {
		return {
			...DEFAULT_AUTH_CONFIG,
			secretPath: join(agentsDir, ".daemon", "auth-secret"),
		};
	}
	if (!isRecord(raw)) reject("auth", "must be a mapping");

	const obj = raw;
	const mode = validateAuthConfig(obj);
	const secretPath = join(agentsDir, ".daemon", "auth-secret");

	const rawLimits = obj.rateLimits as Record<string, unknown> | undefined;
	const rateLimits: Record<string, RateLimitConfig> = {};
	for (const [key, fallback] of Object.entries(DEFAULT_RATE_LIMITS)) {
		rateLimits[key] = parseRateLimit(rawLimits?.[key], fallback);
	}

	const defaultTtl =
		typeof obj.defaultTokenTtlSeconds === "number" && obj.defaultTokenTtlSeconds > 0
			? obj.defaultTokenTtlSeconds
			: DEFAULT_AUTH_CONFIG.defaultTokenTtlSeconds;

	const sessionTtl =
		typeof obj.sessionTokenTtlSeconds === "number" && obj.sessionTokenTtlSeconds > 0
			? obj.sessionTokenTtlSeconds
			: DEFAULT_AUTH_CONFIG.sessionTokenTtlSeconds;

	return {
		mode,
		secretPath,
		rateLimits,
		defaultTokenTtlSeconds: defaultTtl,
		sessionTokenTtlSeconds: sessionTtl,
		login: parseLoginConfig(obj),
	};
}
