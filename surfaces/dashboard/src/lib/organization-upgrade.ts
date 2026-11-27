export interface UpgradeAgentMapping {
	readonly agentId: string;
	readonly name: string;
	readonly kind: "personal" | "team" | "organization";
	readonly ownerUserId: string | null;
	readonly ownerGroupId: string | null;
	readonly fallback: boolean;
}
export interface UpgradeKeyMapping {
	readonly id: string;
	readonly name: string;
	readonly prefix: string;
	readonly agentId: string | null;
	readonly action: "assign" | "revoke" | "keep-unassigned";
	readonly userId: string | null;
}
export interface UpgradePreview {
	readonly agents: readonly UpgradeAgentMapping[];
	readonly keys: readonly UpgradeKeyMapping[];
	readonly legacyKeyDeadline: string;
	readonly organizationAgentId: "default";
	readonly evidencePolicy: "preserve-agent-ids-and-evidence";
	readonly retainedStorePolicy: string;
}
export interface UpgradeJob {
	readonly id: string;
	readonly revision: string;
	readonly status: "pending" | "running" | "complete" | "failed" | "cancelled";
	readonly phase: "draft" | "applying" | "complete" | "cancelled";
	readonly preview: UpgradePreview;
	readonly appliedPlan: UpgradePreview | null;
	readonly completedSteps: number;
	readonly totalSteps: number;
	readonly error: string | null;
}
export interface UpgradeInventory {
	readonly agents: readonly { readonly id: string; readonly name: string }[];
	readonly keys: readonly {
		readonly id: string;
		readonly name: string;
		readonly prefix: string;
		readonly agentId: string | null;
	}[];
	readonly users: readonly { readonly id: string; readonly name: string }[];
	readonly groups: readonly { readonly id: string; readonly name: string }[];
	readonly legacyKeyDeadline: string | null;
	readonly jobs: readonly UpgradeJob[];
}
export function upgradeDeadlineInput(value: string | null): string {
	const date = value ? new Date(value) : new Date(Date.now() + 14 * 86400_000);
	if (!Number.isFinite(date.getTime())) return "";
	return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}
export function upgradeDeadline(value: string): string | null {
	const date = new Date(value);
	return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
