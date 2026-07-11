/**
 * Session boundary semantics for summary synthesis.
 *
 * A boundary reason classifies WHY a transcript snapshot was captured,
 * so the summary worker can decide whether to run durable fact extraction
 * (session_end, new_session) or just produce continuity/checkpoint artifacts
 * (compaction, checkpoint, ttl_expired, connector_retry).
 *
 * This prevents over-finalization: repeated compaction events during a
 * long-lived session should not each extract durable facts from overlapping
 * transcript ranges.
 */

/** All recognized boundary reasons. */
export const BOUNDARY_REASONS = [
	"session_closed",
	"new_session",
	"compaction",
	"checkpoint",
	"ttl_expired",
	"connector_retry",
] as const;

export type BoundaryReason = (typeof BOUNDARY_REASONS)[number];

/** Boundaries that warrant durable fact extraction + terminal summary artifacts. */
export const DURABLE_BOUNDARY_REASONS: ReadonlySet<BoundaryReason> = new Set(["session_closed", "new_session"]);

/** Default set when config does not override. */
export const DEFAULT_DURABLE_BOUNDARIES: readonly BoundaryReason[] = ["session_closed", "new_session"];

/**
 * Determine whether a given boundary reason should trigger durable synthesis
 * (fact extraction + summary artifact). Non-durable boundaries may still
 * produce continuity checkpoints but skip durable extraction.
 */
export function isDurableBoundary(
	reason: string | undefined | null,
	durableSet: ReadonlySet<string> = DURABLE_BOUNDARY_REASONS as ReadonlySet<string>,
): boolean {
	if (!reason) return true; // backward compat: missing reason = treat as durable
	return durableSet.has(reason);
}

/**
 * Normalize an arbitrary string to a BoundaryReason, defaulting to
 * "session_closed" for unknown values (backward compatibility).
 */
export function normalizeBoundaryReason(reason: string | undefined | null): BoundaryReason {
	if (!reason) return "session_closed";
	const trimmed = reason.trim().toLowerCase();
	if (BOUNDARY_REASONS.includes(trimmed as BoundaryReason)) {
		return trimmed as BoundaryReason;
	}
	// Map legacy trigger values
	if (trimmed === "session_end" || trimmed === "clear") return "session_closed";
	if (trimmed === "checkpoint_extract" || trimmed === "mid_session_extract") return "checkpoint";
	return "session_closed";
}
