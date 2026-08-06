/**
 * Due-for-review temporal claims (issue #945).
 *
 * Temporal claims ("X is going to Y on March 15th, 2027") carry a
 * `review_after` ISO timestamp set when the claim is created. This module
 * provides the query the dreaming pass needs to surface claims that are now
 * due (review_after in the past) or about to become due, so supersession
 * (prospective → retrospective) can run without scanning the whole table.
 *
 * The dreaming pass itself lives in the #913 unified pipeline; this helper is
 * intentionally standalone so both pipeline dreaming and agentic dreaming can
 * share it.
 */

export interface ReviewDueMemory {
	readonly id: string;
	readonly content: string;
	readonly type: string;
	readonly importance: number;
	/** ISO timestamp of the review deadline. */
	readonly reviewAfter: string;
	readonly createdAt: string;
	readonly agentId: string;
	readonly scope: string | null;
}

export interface ReviewWindowOptions {
	/**
	 * Look-ahead window (ms) for "about to expire" claims. Defaults to 7 days
	 * so the dreaming pass can act before the deadline passes.
	 */
	readonly expiringSoonMs?: number;
	readonly limit?: number;
}

interface ReviewDueRow {
	readonly id: string;
	readonly content: string;
	readonly type: string;
	readonly importance: number;
	readonly review_after: string;
	readonly created_at: string;
	readonly agent_id: string;
	readonly scope: string | null;
}

export interface ReviewDueAccessor {
	all<T = unknown>(sql: string, ...params: unknown[]): T[];
}

function toReviewDueMemory(row: ReviewDueRow): ReviewDueMemory {
	return {
		id: row.id,
		content: row.content,
		type: row.type,
		importance: row.importance,
		reviewAfter: row.review_after,
		createdAt: row.created_at,
		agentId: row.agent_id,
		scope: row.scope,
	};
}

/**
 * Query memories whose `review_after` deadline has passed — temporal claims
 * that are now due for supersession review.
 */
export function findExpiredReviewDueMemories(
	accessor: ReviewDueAccessor,
	now = new Date(),
	opts: ReviewWindowOptions = {},
): readonly ReviewDueMemory[] {
	const limit = opts.limit ?? 50;
	const rows = accessor.all<ReviewDueRow>(
		`SELECT id, content, type, importance, review_after, created_at, agent_id, scope
		   FROM memories
		  WHERE review_after IS NOT NULL
		    AND review_after < ?
		    AND is_deleted = 0
		  ORDER BY review_after ASC
		  LIMIT ?`,
		now.toISOString(),
		limit,
	);
	return rows.map(toReviewDueMemory);
}

/**
 * Query memories whose `review_after` deadline is approaching (within the
 * look-ahead window) but has not yet passed — so the dreaming pass can
 * prioritize them before they expire.
 */
export function findApproachingReviewDueMemories(
	accessor: ReviewDueAccessor,
	now = new Date(),
	opts: ReviewWindowOptions = {},
): readonly ReviewDueMemory[] {
	const windowMs = opts.expiringSoonMs ?? 7 * 24 * 60 * 60 * 1000;
	const limit = opts.limit ?? 50;
	const horizon = new Date(now.getTime() + windowMs);
	const rows = accessor.all<ReviewDueRow>(
		`SELECT id, content, type, importance, review_after, created_at, agent_id, scope
		   FROM memories
		  WHERE review_after IS NOT NULL
		    AND review_after >= ?
		    AND review_after <= ?
		    AND is_deleted = 0
		  ORDER BY review_after ASC
		  LIMIT ?`,
		now.toISOString(),
		horizon.toISOString(),
		limit,
	);
	return rows.map(toReviewDueMemory);
}

/**
 * Convenience bundle for the dreaming context: both expired and approaching
 * claims in one call.
 */
export function collectReviewDueClaims(
	accessor: ReviewDueAccessor,
	now = new Date(),
	opts: ReviewWindowOptions = {},
): { readonly expired: readonly ReviewDueMemory[]; readonly approaching: readonly ReviewDueMemory[] } {
	return {
		expired: findExpiredReviewDueMemories(accessor, now, opts),
		approaching: findApproachingReviewDueMemories(accessor, now, opts),
	};
}
