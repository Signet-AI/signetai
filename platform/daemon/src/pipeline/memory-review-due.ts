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
	readonly attributeId: string | null;
	readonly entityId: string | null;
	readonly entityName: string | null;
	readonly aspectId: string | null;
	readonly aspectName: string | null;
	readonly claimKey: string | null;
}

export interface ReviewWindowOptions {
	/**
	 * Look-ahead window (ms) for "about to expire" claims. Defaults to 7 days
	 * so the dreaming pass can act before the deadline passes.
	 */
	readonly expiringSoonMs?: number;
	readonly limit?: number;
	readonly agentId?: string;
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
	readonly attribute_id: string | null;
	readonly entity_id: string | null;
	readonly entity_name: string | null;
	readonly aspect_id: string | null;
	readonly aspect_name: string | null;
	readonly claim_key: string | null;
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
		attributeId: row.attribute_id,
		entityId: row.entity_id,
		entityName: row.entity_name,
		aspectId: row.aspect_id,
		aspectName: row.aspect_name,
		claimKey: row.claim_key,
	};
}

function reviewDueQuery(options: ReviewWindowOptions): { readonly sql: string; readonly params: unknown[] } {
	return options.agentId
		? {
				sql: "AND m.agent_id = ?",
				params: [options.agentId],
			}
		: { sql: "", params: [] };
}

const REVIEW_DUE_SELECT = `
	SELECT m.id, m.content, m.type, m.importance, m.review_after, m.created_at, m.agent_id, m.scope,
	       ea.id AS attribute_id, a.entity_id, e.name AS entity_name,
	       ea.aspect_id, a.name AS aspect_name, ea.claim_key
	  FROM memories m
	  LEFT JOIN entity_attributes ea
	    ON ea.memory_id = m.id
	   AND ea.agent_id = m.agent_id
	   AND ea.status = 'active'
	  LEFT JOIN entity_aspects a ON a.id = ea.aspect_id AND a.agent_id = ea.agent_id
	  LEFT JOIN entities e ON e.id = a.entity_id AND e.agent_id = ea.agent_id
	 WHERE m.review_after IS NOT NULL
	   AND m.superseded_by IS NULL
	   AND m.is_deleted = 0`;

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
	const query = reviewDueQuery(opts);
	const rows = accessor.all<ReviewDueRow>(
		`${REVIEW_DUE_SELECT}
		    AND m.review_after < ?
		    ${query.sql}
		  ORDER BY review_after ASC
		  LIMIT ?`,
		now.toISOString(),
		...query.params,
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
	const query = reviewDueQuery(opts);
	const horizon = new Date(now.getTime() + windowMs);
	const rows = accessor.all<ReviewDueRow>(
		`${REVIEW_DUE_SELECT}
		    AND m.review_after >= ?
		    AND m.review_after <= ?
		    ${query.sql}
		  ORDER BY review_after ASC
		  LIMIT ?`,
		now.toISOString(),
		horizon.toISOString(),
		...query.params,
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
	now: Date,
	options: ReviewWindowOptions = {},
): { readonly expired: readonly ReviewDueMemory[]; readonly approaching: readonly ReviewDueMemory[] } {
	const limit = options.limit ?? 50;
	const expired = findExpiredReviewDueMemories(accessor, now, { ...options, limit });
	return {
		expired,
		approaching:
			expired.length >= limit
				? []
				: findApproachingReviewDueMemories(accessor, now, { ...options, limit: limit - expired.length }),
	};
}
