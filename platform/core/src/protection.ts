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
	readonly workspace?: string;
	readonly schema?: string;
	readonly snapshot?: string;
	readonly components?: readonly string[];
	readonly expiresAt?: string;
}

export interface ProtectionStatus {
	readonly status: "protected" | "degraded" | "unverified" | "unknown" | "none";
	readonly overall: "protected" | "partial" | "none";
	readonly protected: boolean;
	readonly components: readonly ProtectionComponent[];
	readonly missing: readonly ProtectionComponentId[];
	readonly degraded: readonly ProtectionComponentId[];
	readonly restoreReceipt: RestoreReceipt | null;
	readonly privacy: {
		readonly pathsRedacted: true;
		readonly secretsRedacted: true;
		readonly contentIncluded: false;
	};
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
	const receiptUsable =
		receipt?.valid === true &&
		(receipt.schema === undefined || receipt.schema === "signet.restore.v1") &&
		(receipt.expiresAt === undefined || Date.parse(receipt.expiresAt) > Date.now());
	const protectedNow = allProtected && receiptUsable;
	const hasRequired = ordered.some((component) => component.status !== "excluded-rebuildable");
	const missing = ordered.filter((component) => component.status === "missing").map((component) => component.id);
	const degraded = ordered
		.filter((component) => component.status !== "protected" && component.status !== "excluded-rebuildable")
		.map((component) => component.id);
	const status = !hasRequired
		? "none"
		: protectedNow
			? "protected"
			: hasBlocking
				? "degraded"
				: hasUnknown
					? "unknown"
					: "unverified";
	return {
		status,
		overall: !hasRequired ? "none" : protectedNow ? "protected" : "partial",
		protected: protectedNow,
		components: ordered,
		missing,
		degraded,
		restoreReceipt: receipt,
		privacy: { pathsRedacted: true, secretsRedacted: true, contentIncluded: false },
	};
}
