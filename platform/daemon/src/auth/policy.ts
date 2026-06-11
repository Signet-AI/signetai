/**
 * Permission matrix and scope enforcement.
 */

import type { AuthMode, Permission, PolicyDecision, TokenClaims, TokenRole, TokenScope } from "./types";
import { logger } from "../logger";

// Track which subs have been warned about empty scope to avoid log flooding.
// Unbounded for the process lifetime — acceptable for typical deployments
// where the number of distinct token subjects is small. If ephemeral per-session
// subs are used at high volume, consider replacing with a bounded LRU.
const warnedEmptyScope = new Set<string>();

const PERMISSION_MATRIX: Readonly<Record<TokenRole, readonly Permission[]>> = {
	admin: [
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
	],
	operator: [
		"remember",
		"recall",
		"modify",
		"forget",
		"recover",
		"documents",
		"connectors",
		"diagnostics",
		"analytics",
	],
	agent: ["remember", "recall", "modify", "forget", "recover", "documents"],
	readonly: ["recall"],
};

const permissionSets = new Map<TokenRole, ReadonlySet<Permission>>(
	Object.entries(PERMISSION_MATRIX).map(([role, perms]) => [role as TokenRole, new Set(perms)]),
);

export function checkPermission(
	claims: TokenClaims | null,
	permission: Permission,
	authMode: AuthMode,
): PolicyDecision {
	if (authMode === "local") {
		return { allowed: true };
	}

	if (!claims) {
		return { allowed: false, reason: "authentication required" };
	}

	const allowed = permissionSets.get(claims.role);
	if (!allowed || !allowed.has(permission)) {
		return {
			allowed: false,
			reason: `role '${claims.role}' lacks '${permission}' permission`,
		};
	}

	if (claims.permissions && !claims.permissions.includes(permission)) {
		return {
			allowed: false,
			reason: `credential lacks '${permission}' permission`,
		};
	}

	return { allowed: true };
}

export function checkScope(claims: TokenClaims | null, target: TokenScope, authMode: AuthMode): PolicyDecision {
	if (authMode === "local") {
		return { allowed: true };
	}

	if (!claims) {
		return { allowed: false, reason: "authentication required" };
	}

	// Admin role bypasses scope checks
	if (claims.role === "admin") {
		return { allowed: true };
	}

	// DEPRECATION: Non-admin tokens with empty scope currently get full access
	// but will be denied in a future release. Log once per sub to avoid
	// flooding structured logs on busy deployments.
	const scope = claims.scope;
	if (!scope.project && !scope.agent && !scope.user) {
		if (!warnedEmptyScope.has(claims.sub)) {
			warnedEmptyScope.add(claims.sub);
			logger.warn(
				"daemon",
				"DEPRECATION: non-admin token has empty scope — will be denied in a future release. Issue tokens with explicit scope fields.",
				{
					sub: claims.sub,
					role: claims.role,
				},
			);
		}
		return { allowed: true };
	}

	if (scope.project && target.project && scope.project !== target.project) {
		return {
			allowed: false,
			reason: `scope restricted to project '${scope.project}'`,
		};
	}

	if (scope.agent && target.agent && scope.agent !== target.agent) {
		return {
			allowed: false,
			reason: `scope restricted to agent '${scope.agent}'`,
		};
	}

	if (scope.user && target.user && scope.user !== target.user) {
		return {
			allowed: false,
			reason: `scope restricted to user '${scope.user}'`,
		};
	}

	return { allowed: true };
}

export { PERMISSION_MATRIX };
