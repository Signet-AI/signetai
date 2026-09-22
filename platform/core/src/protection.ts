export const PROTECTION_COMPONENT_IDS = [
	"root-authored",
	"skills",
	"managed-originals",
	"sqlite",
	"transcripts",
	"external-sources",
	"runtime",
	"filesystem-cache",
	"secrets",
] as const;

export type ProtectionComponentId = (typeof PROTECTION_COMPONENT_IDS)[number];
export type ProtectionComponentStatus =
	| "protected"
	| "missing"
	| "stale"
	| "degraded"
	| "unknown"
	| "external"
	| "unverified"
	| "excluded-rebuildable";

export interface ProtectionComponent {
	readonly id: ProtectionComponentId;
	readonly status: ProtectionComponentStatus;
	readonly detail?: string;
	readonly checkedAt?: string;
	/** A path is never returned; this is only a safe, caller-provided label. */
	readonly label?: string;
}

export interface RestoreReceipt {
	readonly at: string;
	readonly valid: boolean;
	readonly id?: string;
}

export interface ProtectionStatus {
	readonly status: "protected" | "degraded" | "unverified" | "unknown";
	readonly protected: boolean;
	readonly components: readonly ProtectionComponent[];
	readonly restoreReceipt: RestoreReceipt | null;
}

const ORDER = new Map(PROTECTION_COMPONENT_IDS.map((id, index) => [id, index]));
const BLOCKING = new Set<ProtectionComponentStatus>(["missing", "stale", "degraded"]);

export function aggregateProtection(
	components: readonly ProtectionComponent[],
	options: { readonly restoreReceipt?: RestoreReceipt | null; readonly gitSynchronized?: boolean } = {},
): ProtectionStatus {
	const ordered = [...components].sort(
		(a, b) => (ORDER.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (ORDER.get(b.id) ?? Number.MAX_SAFE_INTEGER),
	);
	const receipt = options.restoreReceipt ?? null;
	const hasBlocking = ordered.some((component) => BLOCKING.has(component.status));
	const hasUnknown = ordered.some((component) => component.status === "unknown");
	const allProtected =
		ordered.length > 0 &&
		ordered.every((component) => component.status === "protected" || component.status === "excluded-rebuildable");
	const protectedNow = allProtected && receipt?.valid === true;
	const status = protectedNow ? "protected" : hasBlocking ? "degraded" : hasUnknown ? "unknown" : "unverified";
	return { status, protected: protectedNow, components: ordered, restoreReceipt: receipt };
}
