import { z } from "zod";
import type { OperatorActor } from "./operator-job-contract";

export const ORGANIZATION_RETAINED_STORE_POLICY =
	"Organization mappings, including unmapped agents, retain the original stores, IDs, evidence, provenance, classifications, citations, and indexes without rewriting or merging. Organization reads include these imported stores. New organization writes use default; only an administrator explicitly targeting an imported store can write to it.";
export const UPGRADE_AGENT_LIMIT = 256;
export const UPGRADE_KEY_LIMIT = 1000;
export const UPGRADE_BATCH_SIZE = 8;
const identifier = z.string().min(1).max(200);
export const upgradeMappingSchema = z.discriminatedUnion("kind", [
	z.object({ agentId: identifier, kind: z.literal("personal"), ownerUserId: identifier }).strict(),
	z.object({ agentId: identifier, kind: z.literal("team"), ownerGroupId: identifier }).strict(),
	z.object({ agentId: identifier, kind: z.literal("organization") }).strict(),
]);
export const upgradeKeySchema = z.discriminatedUnion("action", [
	z.object({ id: identifier, action: z.literal("assign"), userId: identifier }).strict(),
	z.object({ id: identifier, action: z.literal("revoke") }).strict(),
]);
export const upgradePlanSchema = z
	.object({
		mappings: z.array(upgradeMappingSchema).max(UPGRADE_AGENT_LIMIT),
		keys: z.array(upgradeKeySchema).max(UPGRADE_KEY_LIMIT),
		legacyKeyDeadline: z.iso.datetime(),
	})
	.strict()
	.superRefine((plan, context) => {
		if (new Set(plan.mappings.map((row) => row.agentId)).size !== plan.mappings.length)
			context.addIssue({ code: "custom", message: "Each agent can have only one mapping" });
		if (new Set(plan.keys.map((row) => row.id)).size !== plan.keys.length)
			context.addIssue({ code: "custom", message: "Each key can have only one action" });
	});
export type UpgradePlanInput = z.infer<typeof upgradePlanSchema>;
export interface UpgradeAgentChange {
	readonly agentId: string;
	readonly name: string;
	readonly kind: "personal" | "team" | "organization";
	readonly ownerUserId: string | null;
	readonly ownerGroupId: string | null;
	readonly fallback: boolean;
}
export interface UpgradeKeyChange {
	readonly id: string;
	readonly name: string;
	readonly prefix: string;
	readonly agentId: string | null;
	readonly action: "assign" | "revoke" | "keep-unassigned";
	readonly userId: string | null;
}
export interface UpgradePreview {
	readonly agents: readonly UpgradeAgentChange[];
	readonly keys: readonly UpgradeKeyChange[];
	readonly legacyKeyDeadline: string;
	readonly organizationAgentId: "default";
	readonly evidencePolicy: "preserve-agent-ids-and-evidence";
	readonly retainedStorePolicy: string;
}
export const upgradePreviewSchema = z.object({
	agents: z
		.array(
			z.object({
				agentId: identifier,
				name: z.string(),
				kind: z.enum(["personal", "team", "organization"]),
				ownerUserId: identifier.nullable(),
				ownerGroupId: identifier.nullable(),
				fallback: z.boolean(),
			}),
		)
		.max(UPGRADE_AGENT_LIMIT),
	keys: z
		.array(
			z.object({
				id: identifier,
				name: z.string(),
				prefix: z.string(),
				agentId: identifier.nullable(),
				action: z.enum(["assign", "revoke", "keep-unassigned"]),
				userId: identifier.nullable(),
			}),
		)
		.max(UPGRADE_KEY_LIMIT),
	legacyKeyDeadline: z.iso.datetime(),
	organizationAgentId: z.literal("default"),
	evidencePolicy: z.literal("preserve-agent-ids-and-evidence"),
	retainedStorePolicy: z.literal(ORGANIZATION_RETAINED_STORE_POLICY),
});
export interface UpgradeView {
	readonly id: string;
	readonly kind: "organization_upgrade";
	readonly created_at: string;
	readonly revision: string;
	readonly status: string;
	readonly phase: "draft" | "applying" | "complete" | "cancelled";
	readonly preview: UpgradePreview;
	readonly appliedPlan: UpgradePreview | null;
	readonly completedSteps: number;
	readonly totalSteps: number;
	readonly error: string | null;
}
export interface UpgradeInventoryView {
	readonly agents: readonly {
		readonly id: string;
		readonly name: string;
		readonly kind: "legacy";
		readonly owner_user_id: string | null;
		readonly owner_group_id: string | null;
	}[];
	readonly keys: readonly {
		readonly id: string;
		readonly name: string;
		readonly prefix: string;
		readonly agentId: string | null;
	}[];
	readonly users: readonly { readonly id: string; readonly name: string }[];
	readonly groups: readonly { readonly id: string; readonly name: string }[];
	readonly legacyKeyDeadline: string | null;
	readonly jobs: readonly UpgradeView[];
}
export type UpgradeCommand =
	| { readonly action: "preview"; readonly plan: UpgradePlanInput }
	| { readonly action: "inventory" }
	| { readonly action: "list" }
	| { readonly action: "read"; readonly jobId: string }
	| { readonly action: "revise"; readonly jobId: string; readonly revision: string; readonly plan: UpgradePlanInput }
	| { readonly action: "confirm" | "cancel" | "resume"; readonly jobId: string; readonly revision: string }
	| { readonly action: "next"; readonly jobId: string }
	| { readonly action: "recover" }
	| { readonly action: "map-agent"; readonly agentId: string; readonly mapping: z.infer<typeof upgradeMappingSchema> }
	| { readonly action: "assign-key"; readonly keyId: string; readonly userId: string };
export interface UpgradeRequest {
	readonly op: "organization-upgrade";
	readonly actor: OperatorActor | null;
	readonly command: UpgradeCommand;
	readonly runtimeId?: string;
}
