/**
 * Decision Memory Module
 *
 * Stores, queries, and tracks decisions with structured metadata:
 * reasoning chains, alternatives considered, confidence levels,
 * outcomes, and revisitability flags.
 *
 * Decisions link to memories via memory_id and add rich structure
 * that supports decision auditing, outcome tracking, and review.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Decision {
	id?: string;
	memoryId: string;
	conclusion: string;
	reasoning: string[];
	alternatives: string[];
	contextSession?: string;
	confidence: number;
	revisitable: boolean;
	outcome?: string;
	outcomeNotes?: string;
	outcomeAt?: string;
	createdAt?: string;
	reviewedAt?: string;
}

export interface DecisionRow {
	id: string;
	memory_id: string;
	conclusion: string;
	reasoning: string;
	alternatives: string;
	context_session: string | null;
	confidence: number;
	revisitable: number;
	outcome: string | null;
	outcome_notes: string | null;
	outcome_at: string | null;
	created_at: string;
	reviewed_at: string | null;
}

export interface DecisionQueryOptions {
	limit?: number;
	offset?: number;
	revisitableOnly?: boolean;
	hasOutcome?: boolean;
}

export interface DecisionWithContent extends Decision {
	memoryContent?: string;
	memoryType?: string;
}

// ---------------------------------------------------------------------------
// Minimal DB interface (matches MigrationDb / raw SQLite)
// ---------------------------------------------------------------------------

interface Db {
	prepare(sql: string): {
		run(...args: unknown[]): void;
		get(...args: unknown[]): Record<string, unknown> | undefined;
		all(...args: unknown[]): Record<string, unknown>[];
	};
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rowToDecision(row: Record<string, unknown>): Decision {
	return {
		id: row.id as string,
		memoryId: row.memory_id as string,
		conclusion: row.conclusion as string,
		reasoning: JSON.parse((row.reasoning as string) || "[]"),
		alternatives: JSON.parse((row.alternatives as string) || "[]"),
		contextSession: row.context_session as string | undefined,
		confidence: row.confidence as number,
		revisitable: Boolean(row.revisitable),
		outcome: row.outcome as string | undefined,
		outcomeNotes: row.outcome_notes as string | undefined,
		outcomeAt: row.outcome_at as string | undefined,
		createdAt: row.created_at as string,
		reviewedAt: row.reviewed_at as string | undefined,
	};
}

function rowToDecisionWithContent(row: Record<string, unknown>): DecisionWithContent {
	return {
		...rowToDecision(row),
		memoryContent: row.content as string | undefined,
		memoryType: row.type as string | undefined,
	};
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Store a decision with its reasoning chain and alternatives.
 * Returns the decision ID.
 */
export function storeDecision(db: Db, decision: Decision): string {
	if (!decision.conclusion?.trim()) {
		throw new Error("Decision conclusion is required");
	}
	if (!decision.memoryId) {
		throw new Error("Decision memory_id is required");
	}

	const id = decision.id ?? crypto.randomUUID();
	const now = new Date().toISOString();

	db.prepare(`
		INSERT INTO decisions
			(id, memory_id, conclusion, reasoning, alternatives,
			 context_session, confidence, revisitable,
			 outcome, outcome_notes, outcome_at,
			 created_at, reviewed_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`).run(
		id,
		decision.memoryId,
		decision.conclusion,
		JSON.stringify(decision.reasoning),
		JSON.stringify(decision.alternatives),
		decision.contextSession ?? null,
		decision.confidence,
		decision.revisitable ? 1 : 0,
		decision.outcome ?? null,
		decision.outcomeNotes ?? null,
		decision.outcomeAt ?? null,
		decision.createdAt ?? now,
		decision.reviewedAt ?? null,
	);

	return id;
}

/**
 * Search decisions by conclusion or reasoning text.
 * Uses LIKE matching across conclusion, reasoning JSON, and alternatives JSON.
 */
export function queryDecisions(
	db: Db,
	query: string,
	options: DecisionQueryOptions = {},
): DecisionWithContent[] {
	const limit = options.limit ?? 20;
	const offset = options.offset ?? 0;

	const whereParts: string[] = [];
	const params: unknown[] = [];

	// Text search across conclusion + reasoning + alternatives
	if (query.trim().length > 0) {
		whereParts.push(
			"(d.conclusion LIKE ? ESCAPE '\\' OR d.reasoning LIKE ? ESCAPE '\\' OR d.alternatives LIKE ? ESCAPE '\\')",
		);
		const escaped = query.replace(/[%_\\]/g, (c) => `\\${c}`);
		const like = `%${escaped}%`;
		params.push(like, like, like);
	}

	if (options.revisitableOnly) {
		whereParts.push("d.revisitable = 1");
	}

	if (options.hasOutcome === true) {
		whereParts.push("d.outcome IS NOT NULL");
	} else if (options.hasOutcome === false) {
		whereParts.push("d.outcome IS NULL");
	}

	const whereClause = whereParts.length > 0
		? `WHERE ${whereParts.join(" AND ")}`
		: "";

	params.push(limit, offset);

	const rows = db.prepare(`
		SELECT d.*, m.content, m.type
		FROM decisions d
		LEFT JOIN memories m ON m.id = d.memory_id
		${whereClause}
		ORDER BY d.created_at DESC
		LIMIT ? OFFSET ?
	`).all(...params) as Array<Record<string, unknown>>;

	return rows.map(rowToDecisionWithContent);
}

/**
 * Record the outcome of a decision.
 */
export function recordOutcome(
	db: Db,
	decisionId: string,
	outcome: string,
	notes?: string,
): void {
	const existing = db.prepare("SELECT id FROM decisions WHERE id = ?").get(decisionId);
	if (!existing) {
		throw new Error(`Decision not found: ${decisionId}`);
	}

	const now = new Date().toISOString();

	db.prepare(`
		UPDATE decisions
		SET outcome = ?,
		    outcome_notes = ?,
		    outcome_at = ?,
		    reviewed_at = ?
		WHERE id = ?
	`).run(outcome, notes ?? null, now, now, decisionId);
}

/**
 * Get decisions marked as revisitable that haven't been reviewed yet.
 */
export function getPendingReviews(
	db: Db,
	options: { limit?: number; olderThanDays?: number } = {},
): DecisionWithContent[] {
	const limit = options.limit ?? 20;
	const params: unknown[] = [];
	const whereParts: string[] = [
		"d.revisitable = 1",
		"d.reviewed_at IS NULL",
	];

	if (options.olderThanDays !== undefined) {
		const cutoff = new Date(
			Date.now() - options.olderThanDays * 86_400_000,
		).toISOString();
		whereParts.push("d.created_at <= ?");
		params.push(cutoff);
	}

	params.push(limit);

	const rows = db.prepare(`
		SELECT d.*, m.content, m.type
		FROM decisions d
		LEFT JOIN memories m ON m.id = d.memory_id
		WHERE ${whereParts.join(" AND ")}
		ORDER BY d.created_at ASC
		LIMIT ?
	`).all(...params) as Array<Record<string, unknown>>;

	return rows.map(rowToDecisionWithContent);
}

/**
 * Get a single decision by ID.
 */
export function getDecisionById(db: Db, decisionId: string): Decision | null {
	const row = db.prepare(`
		SELECT * FROM decisions WHERE id = ?
	`).get(decisionId);

	if (!row) return null;
	return rowToDecision(row);
}

/**
 * Get all decisions linked to a specific memory.
 */
export function getDecisionsByMemoryId(db: Db, memoryId: string): Decision[] {
	const rows = db.prepare(`
		SELECT * FROM decisions WHERE memory_id = ? ORDER BY created_at DESC
	`).all(memoryId) as Array<Record<string, unknown>>;

	return rows.map(rowToDecision);
}
