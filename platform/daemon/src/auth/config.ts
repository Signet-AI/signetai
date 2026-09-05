/**
 * Auth configuration parsing from agent.yaml.
 */

import { join } from "node:path";
import { z } from "zod";
import { AUTH_MODES, type AuthMode } from "./types";
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

const password = z.object({ username: z.string().optional(), passwordHash: z.string().optional() });
const schema = z.object({
	mode: z.enum(AUTH_MODES).default("local"),
	rateLimits: z
		.object(
			Object.fromEntries(
				Object.entries(DEFAULT_RATE_LIMITS).map(([key, fallback]) => [
					key,
					z
						.object({
							windowMs: z.number().positive().default(fallback.windowMs),
							max: z.number().positive().default(fallback.max),
						})
						.prefault({}),
				]),
			),
		)
		.prefault({}),
	defaultTokenTtlSeconds: z
		.number()
		.positive()
		.default(7 * 24 * 60 * 60),
	sessionTokenTtlSeconds: z
		.number()
		.positive()
		.default(24 * 60 * 60),
	login: z
		.object({
			password: password.prefault({}),
			sso: z.object({ enabled: z.boolean().default(false) }).prefault({}),
			saml: z.object({ enabled: z.boolean().default(false) }).prefault({}),
		})
		.prefault({}),
	adminUser: password.optional(),
});

export function parseAuthConfig(raw: unknown, agentsDir: string): AuthConfig {
	const result = schema.safeParse(raw === undefined ? {} : raw);
	if (!result.success) {
		const issue = result.error.issues[0];
		const field = ["auth", ...(issue?.path ?? [])].join(".");
		const reason = issue?.code === "invalid_type" && issue.expected === "object" ? "must be a mapping" : "is invalid";
		throw new Error(`${field} ${reason}`);
	}
	const cfg = result.data;
	return {
		mode: cfg.mode,
		secretPath: join(agentsDir, ".daemon", "auth-secret"),
		rateLimits: cfg.rateLimits,
		defaultTokenTtlSeconds: cfg.defaultTokenTtlSeconds,
		sessionTokenTtlSeconds: cfg.sessionTokenTtlSeconds,
		login: {
			password: {
				username: cfg.login.password.username?.trim() || cfg.adminUser?.username?.trim() || "admin",
				passwordHash: cfg.login.password.passwordHash?.trim() || cfg.adminUser?.passwordHash?.trim() || null,
			},
			sso: cfg.login.sso,
			saml: cfg.login.saml,
		},
	};
}
