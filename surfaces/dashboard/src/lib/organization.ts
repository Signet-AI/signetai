export type OrganizationRole = "admin" | "operator" | "member" | "readonly";
export const ORGANIZATION_ROLES: readonly OrganizationRole[] = ["admin", "operator", "member", "readonly"];
export const ORGANIZATION_PERMISSIONS = [
	"remember",
	"recall",
	"modify",
	"forget",
	"recover",
	"documents",
	"connectors",
	"diagnostics",
	"analytics",
	"admin",
	"audit",
	"classify",
] as const;

export function rolePermissions(role: OrganizationRole): readonly string[] {
	const member = ["remember", "recall", "modify", "forget", "recover", "documents"];
	if (role === "readonly") return ["recall"];
	if (role === "member") return member;
	const operator = [...member, "connectors", "diagnostics", "analytics"];
	return role === "operator" ? operator : [...operator, "admin", "audit"];
}

export function organizationSections(organization: boolean, role: string, compliance: boolean): readonly string[] {
	if (!organization) return [];
	return [
		"teams",
		...(role === "admin"
			? ["users", "org-teams", "org-agents", "roles", "access", "org-keys", "authentication", "audit", "health"]
			: compliance
				? ["access", "audit"]
				: []),
		...(compliance ? ["classifications"] : []),
	];
}

export interface OrganizationUser {
	readonly id: string;
	readonly username: string;
	readonly displayName: string;
	readonly email: string | null;
	readonly role: OrganizationRole;
	readonly compliance: boolean;
	readonly status: "active" | "deactivated";
	readonly lastActiveAt?: string | null;
}
export interface OrganizationGroup {
	readonly id: string;
	readonly name: string;
	readonly description: string | null;
	readonly managed_by: "signet" | "idp";
	readonly idp_group?: string | null;
}
export interface OrganizationMember {
	readonly id: string;
	readonly username: string;
	readonly display_name: string;
	readonly role: "owner" | "member";
	readonly managed_by: "signet" | "idp";
}
export interface OrganizationAgent {
	readonly id: string;
	readonly name: string;
	readonly kind: "legacy" | "personal" | "team" | "organization";
	readonly ownerUserId: string | null;
	readonly ownerGroupId: string | null;
	readonly archivedAt: string | null;
	readonly canActAs: boolean;
}
export interface OffboardingPlan {
	readonly userId: string;
	readonly mode: "keep" | "transfer" | "purge";
	readonly transferTo: string | null;
	readonly counts: Readonly<Record<string, number>>;
}
export function offboardingRequest(plan: OffboardingPlan | null, name: string, typed: string) {
	if (!plan || name !== typed) return null;
	return { mode: plan.mode, ...(plan.transferTo ? { transferTo: plan.transferTo } : {}), dryRun: false };
}
export function terminalJob(status: string): boolean {
	return status === "complete" || status === "failed" || status === "cancelled";
}
export interface OrganizationJob {
	readonly id: string;
	readonly kind: string;
	readonly status: "pending" | "running" | "complete" | "failed" | "cancelled";
	readonly progress_json: string | null;
	readonly error: string | null;
}
export interface ClassificationPrincipal {
	readonly kind: "user" | "group";
	readonly id: string;
}
export interface OrganizationClassification {
	readonly id: string;
	readonly name: string;
	readonly color: string | null;
	readonly description: string | null;
	readonly archived_at: string | null;
	readonly audience?: readonly ClassificationPrincipal[];
	readonly appliers?: readonly ClassificationPrincipal[];
}
export interface ClassificationTarget {
	readonly kind: "memory" | "session" | "source" | "agent";
	readonly id: string;
	readonly agentId: string;
}
export interface OrganizationKey {
	readonly id: string;
	readonly name: string;
	readonly prefix: string;
	readonly user_id: string | null;
	readonly device_id: string | null;
	readonly agent_id: string | null;
	readonly harness: string | null;
	readonly last_used_at: string | null;
	readonly expires_at: string | null;
	readonly revoked_at: string | null;
}
export interface OrganizationSettings {
	readonly name: string;
	readonly passwordLogin: boolean;
	readonly requireSso: boolean;
	readonly sessionTtlSeconds: number;
	readonly connectorKeyTtlSeconds: number;
	readonly auditRetentionDays: number;
	readonly publicUrl: string | null;
	readonly oidc: {
		readonly issuer: string;
		readonly clientId: string;
		readonly clientSecretRef?: string;
		readonly scopes?: readonly string[];
		readonly groupClaim?: string;
		readonly groupMap?: Readonly<Record<string, string>>;
		readonly allowedDomains: readonly string[];
	} | null;
}
