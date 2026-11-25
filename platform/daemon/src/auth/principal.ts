import type { Permission, TokenClaims, TokenRole } from "./types";
import { PERMISSIONS } from "./types";
import { PERMISSION_MATRIX } from "./policy";

export type PrincipalKind = "local" | "user" | "legacy";
export interface Principal {
	readonly kind: PrincipalKind;
	readonly userId: string | null;
	readonly role: TokenRole;
	readonly permissions: ReadonlySet<Permission>;
	readonly compliance: boolean;
	readonly groupIds: readonly string[];
	readonly credential: { readonly kind: "local" | "session" | "api_key" | "token"; readonly id: string };
	readonly sessionId: string | null;
	readonly deviceId: string | null;
	readonly harness: string | null;
	readonly boundAgentId: string | null;
	readonly allowedProjects: readonly string[] | null;
}

export function rolePermissions(role: TokenRole, compliance = false): ReadonlySet<Permission> {
	return new Set([...PERMISSION_MATRIX[role], ...(compliance ? (["classify", "audit"] as const) : [])]);
}

export function localPrincipal(): Principal {
	return {
		kind: "local",
		userId: null,
		role: "admin",
		permissions: new Set(PERMISSIONS),
		compliance: false,
		groupIds: [],
		credential: { kind: "local", id: "local" },
		sessionId: null,
		deviceId: null,
		harness: null,
		boundAgentId: null,
		allowedProjects: null,
	};
}

export function legacyPrincipal(claims: TokenClaims): Principal {
	return {
		kind: "legacy",
		userId: null,
		role: claims.role,
		permissions: new Set(
			[...rolePermissions(claims.role)].filter((p) => !claims.permissions || claims.permissions.includes(p)),
		),
		compliance: false,
		groupIds: [],
		credential: {
			kind: claims.sub.startsWith("api-key:") ? "api_key" : "token",
			id: claims.sub.replace(/^api-key:/, ""),
		},
		sessionId: null,
		deviceId: null,
		harness: null,
		boundAgentId: claims.scope.agent ?? null,
		allowedProjects: claims.scope.project ? [claims.scope.project] : null,
	};
}
