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
	readonly schema: "signet.restore.v1";
	readonly id: string;
	readonly at: string;
	readonly expiresAt: string;
	readonly valid: true;
	readonly workspace: string;
	readonly components: readonly ProtectionComponentId[];
	readonly digests: Readonly<Record<string, string>>;
}
export type RestoreReceiptInput =
	| RestoreReceipt
	| { readonly at: string; readonly valid: boolean; readonly [key: string]: unknown };

const RECEIPT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const DIGEST = /^[a-f0-9]{64}$/;

export function validateRestoreReceipt(
	value: unknown,
	options: {
		readonly workspace: string;
		readonly now?: Date;
		readonly componentDigests?: Readonly<Record<string, string>>;
	},
): value is RestoreReceipt {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const receipt = value as Record<string, unknown>;
	const now = (options.now ?? new Date()).getTime();
	const at = typeof receipt.at === "string" ? Date.parse(receipt.at) : Number.NaN;
	const expiresAt = typeof receipt.expiresAt === "string" ? Date.parse(receipt.expiresAt) : Number.NaN;
	const components = receipt.components;
	const digests = receipt.digests;
	const canonical = (value: unknown, parsed: number) =>
		typeof value === "string" && value === new Date(parsed).toISOString();
	if (
		receipt.schema !== "signet.restore.v1" ||
		receipt.valid !== true ||
		typeof receipt.id !== "string" ||
		!/^[A-Za-z0-9._-]{1,128}$/.test(receipt.id) ||
		receipt.workspace !== options.workspace ||
		!Number.isFinite(at) ||
		!Number.isFinite(expiresAt) ||
		!canonical(receipt.at, at) ||
		!canonical(receipt.expiresAt, expiresAt) ||
		at > now ||
		expiresAt <= now ||
		expiresAt - at > RECEIPT_MAX_AGE_MS ||
		!Array.isArray(components) ||
		components.length === 0 ||
		new Set(components).size !== components.length ||
		components.some((id) => !PROTECTION_COMPONENT_IDS.includes(id as ProtectionComponentId)) ||
		!digests ||
		typeof digests !== "object" ||
		Array.isArray(digests)
	)
		return false;
	const digestMap = digests as Record<string, unknown>;
	if (
		Object.keys(digestMap).some(
			(key) =>
				!PROTECTION_COMPONENT_IDS.includes(key as ProtectionComponentId) ||
				typeof digestMap[key] !== "string" ||
				!DIGEST.test(digestMap[key] as string),
		)
	)
		return false;
	if (Object.keys(digestMap).length !== components.length || components.some((id) => !(id in digestMap))) return false;
	if (Object.entries(options.componentDigests ?? {}).some(([key, digest]) => digestMap[key] !== digest)) return false;
	return true;
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
	options: {
		readonly restoreReceipt?: RestoreReceiptInput | null;
		readonly gitSynchronized?: boolean;
		readonly workspacePath?: string;
		readonly now?: Date;
		readonly componentDigests?: Readonly<Record<string, string>>;
	} = {},
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
	const applicable = ordered
		.filter((component) => component.status !== "excluded-rebuildable")
		.map((component) => component.id);
	const receiptUsable =
		receipt !== null &&
		validateRestoreReceipt(receipt, {
			workspace: options.workspacePath ?? "",
			now: options.now,
			componentDigests: options.componentDigests,
		}) &&
		new Set(receipt.components).size === receipt.components.length &&
		receipt.components.length === applicable.length &&
		applicable.every((id) => receipt.components.includes(id));
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
	const receiptForStatus =
		receipt !== null &&
		validateRestoreReceipt(receipt, {
			workspace: options.workspacePath ?? "",
			now: options.now,
			componentDigests: options.componentDigests,
		})
			? receipt
			: null;
	return {
		status,
		overall: !hasRequired ? "none" : protectedNow ? "protected" : "partial",
		protected: protectedNow,
		components: ordered,
		missing,
		degraded,
		restoreReceipt: receiptForStatus,
		privacy: { pathsRedacted: true, secretsRedacted: true, contentIncluded: false },
	};
}
