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

function isValidMode(val: unknown): val is AuthMode {
	return val === "local" || val === "team" || val === "hybrid";
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
	const legacyAdmin = raw.adminUser && typeof raw.adminUser === "object" ? (raw.adminUser as Record<string, unknown>) : {};

	return {
		password: {
			username: nonEmptyString(password.username) ?? nonEmptyString(legacyAdmin.username) ?? DEFAULT_LOGIN_CONFIG.password.username,
			passwordHash: nonEmptyString(password.passwordHash) ?? nonEmptyString(legacyAdmin.passwordHash),
		},
		sso: { enabled: sso.enabled === true },
		saml: { enabled: saml.enabled === true },
	};
}

export function parseAuthConfig(raw: unknown, agentsDir: string): AuthConfig {
	if (!raw || typeof raw !== "object") {
		return {
			...DEFAULT_AUTH_CONFIG,
			secretPath: join(agentsDir, ".daemon", "auth-secret"),
		};
	}

	const obj = raw as Record<string, unknown>;
	const mode = isValidMode(obj.mode) ? obj.mode : "local";
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
