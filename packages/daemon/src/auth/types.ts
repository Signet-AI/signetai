/**
 * Auth types for Signet daemon deployment modes.
 *
 * Phase J: local (default, no auth), team (token-required),
 * hybrid (localhost free, remote requires token).
 */

export const AUTH_MODES = ["local", "team", "hybrid"] as const;
export type AuthMode = (typeof AUTH_MODES)[number];

export const TOKEN_ROLES = [
	"admin",
	"operator",
	"agent",
	"readonly",
] as const;
export type TokenRole = (typeof TOKEN_ROLES)[number];

export const PERMISSIONS = [
	"remember",
	"recall",
	"modify",
	"forget",
	"recover",
	"admin",
	"documents",
	"connectors",
	"diagnostics",
	"analytics",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export interface TokenScope {
	readonly project?: string;
	readonly agent?: string;
	readonly user?: string;
}

export interface TokenClaims {
	readonly sub: string;
	readonly scope: TokenScope;
	readonly role: TokenRole;
	readonly iat: number;
	readonly exp: number;
}

export interface AuthResult {
	readonly authenticated: boolean;
	readonly claims: TokenClaims | null;
	readonly error?: string;
}

export interface PolicyDecision {
	readonly allowed: boolean;
	readonly reason?: string;
}

export interface RateLimitCheck {
	readonly allowed: boolean;
	readonly remaining: number;
	readonly resetAt: number;
}
