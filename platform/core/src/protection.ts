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
export type ProtectionState = "protected" | "missing" | "degraded" | "unknown";
export type ProtectionOverall = "protected" | "partial" | "none";
export interface ProtectionComponent {
	readonly id: ProtectionComponentId;
	readonly type: string;
	readonly authority: "daemon" | "local" | "external" | "user" | "unknown";
	readonly location: string;
	readonly mechanism: string;
	readonly state: ProtectionState;
	readonly required: boolean;
	readonly intentionallyExcluded: boolean;
	readonly backupAt?: string | null;
	readonly restoreVerifiedAt?: string | null;
	readonly verifiedScope?: string | null;
	readonly reason?: string;
	readonly remediation?: string;
}
export interface ProtectionStatus {
	readonly overall: ProtectionOverall;
	readonly components: readonly ProtectionComponent[];
	readonly missing: readonly ProtectionComponentId[];
	readonly degraded: readonly ProtectionComponentId[];
	readonly privacy: { readonly pathsRedacted: true; readonly secretsRedacted: true };
}
export interface ProtectionAggregateOptions {
	readonly now?: string;
	readonly staleWindowMs?: number;
	readonly gitSynchronized?: boolean;
}
const ORDER = new Map(PROTECTION_COMPONENT_IDS.map((id, i) => [id, i]));
const DEFAULT_STALE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
export function aggregateProtection(
	components: readonly ProtectionComponent[],
	options: ProtectionAggregateOptions = {},
): ProtectionStatus {
	const now = Date.parse(options.now ?? new Date().toISOString());
	const window = options.staleWindowMs ?? DEFAULT_STALE_WINDOW_MS;
	const ordered = [...components]
		.map((c) => ({ ...c, location: "[redacted]" as const }))
		.sort((a, b) => (ORDER.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (ORDER.get(b.id) ?? Number.MAX_SAFE_INTEGER));
	const required = ordered.filter((c) => c.required && !c.intentionallyExcluded);
	const missing = required.filter((c) => c.state === "missing").map((c) => c.id);
	const degraded = required
		.filter(
			(c) =>
				c.state !== "protected" ||
				c.mechanism === "git" ||
				!c.backupAt ||
				!c.restoreVerifiedAt ||
				!Number.isFinite(Date.parse(c.backupAt)) ||
				now - Date.parse(c.backupAt) > window,
		)
		.map((c) => c.id);
	const protectedNow = required.length > 0 && required.every((c) => c.state === "protected") && degraded.length === 0;
	return {
		overall: protectedNow ? "protected" : ordered.length > 0 ? "partial" : "none",
		components: ordered,
		missing,
		degraded: [...new Set(degraded)],
		privacy: { pathsRedacted: true, secretsRedacted: true },
	};
}
