/**
 * Temporal Memory — Ebbinghaus-inspired strength model
 *
 * Each memory has a strength value [0, 1] that decays exponentially
 * with time since last access, but is boosted by rehearsal count
 * (spaced repetition effect) and base importance. Pinned memories
 * always retain full strength (1.0).
 *
 * Key formula:
 *   baseDecay = exp(-0.03 * daysSinceAccess)
 *   rehearsalBonus = log(1 + rehearsalCount) * 0.3
 *   importanceFloor = importance * 0.2
 *   strength = clamp(baseDecay + rehearsalBonus, importanceFloor, 1.0)
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Minimal memory row needed for strength calculation.
 * Matches the columns available after migration 013.
 */
export interface MemoryStrengthInput {
	/** When the memory was created (ISO string) */
	readonly created_at: string;
	/** When the memory was last accessed/recalled (ISO string or null) */
	readonly last_accessed: string | null;
	/** When the memory was last rehearsed (ISO string or null) */
	readonly last_rehearsed: string | null;
	/** Number of times this memory has been rehearsed */
	readonly rehearsal_count: number | null;
	/** Memory importance score [0, 1] */
	readonly importance: number | null;
	/** Whether the memory is pinned (1 = true, 0 = false) */
	readonly pinned: number | null;
}

/**
 * Database interface for strength operations.
 * Intentionally minimal — accepts any object with prepare().
 */
export interface TemporalDb {
	prepare(sql: string): {
		run(...args: unknown[]): void;
		get(...args: unknown[]): Record<string, unknown> | undefined;
		all(...args: unknown[]): Record<string, unknown>[];
	};
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MS_PER_DAY = 86_400_000;

/** Base exponential decay rate per day */
const BASE_DECAY_RATE = 0.03;

/** Weight of rehearsal bonus in strength calculation */
const REHEARSAL_BOOST_WEIGHT = 0.3;

/** Importance provides a minimum strength floor (importance * this factor) */
const IMPORTANCE_FLOOR_FACTOR = 0.2;

// ---------------------------------------------------------------------------
// Core Algorithm
// ---------------------------------------------------------------------------

/**
 * Calculate the current strength of a memory.
 *
 * Pure function — no database access, no side effects.
 * Safe for any input: handles null fields, future dates, NaN gracefully.
 *
 * @param memory - Memory row with temporal fields
 * @param nowMs  - Current time in milliseconds (defaults to Date.now())
 * @returns Strength value in [0, 1], rounded to 3 decimal places
 */
export function calculateStrength(
	memory: MemoryStrengthInput,
	nowMs: number = Date.now(),
): number {
	// Pinned memories never decay
	if (memory.pinned) return 1.0;

	// Determine the reference time for decay calculation.
	// Prefer last_rehearsed > last_accessed > created_at
	const lastTouch = parseDateMs(memory.last_rehearsed)
		?? parseDateMs(memory.last_accessed)
		?? parseDateMs(memory.created_at)
		?? nowMs; // fallback: treat as brand new

	// Days since last meaningful interaction (clamped to >= 0)
	const daysSinceAccess = Math.max(0, (nowMs - lastTouch) / MS_PER_DAY);

	// Rehearsal count (default 0, guard against null/negative)
	const rehearsalCount = Math.max(0, memory.rehearsal_count ?? 0);

	// Importance (default 0.5, guard against null/out-of-range)
	const importance = clamp(memory.importance ?? 0.5, 0, 1);

	// --- Exponential decay component ---
	// exp(-0.03 * days) → 1.0 at day 0, ~0.74 at day 10, ~0.41 at day 30
	const decay = Math.exp(-BASE_DECAY_RATE * daysSinceAccess);

	// --- Rehearsal bonus ---
	// log(1 + n) * 0.3 → 0 for 0 rehearsals, ~0.21 for 1, ~0.33 for 2, ~0.48 for 5
	const rehearsalBonus = Math.log(1 + rehearsalCount) * REHEARSAL_BOOST_WEIGHT;

	// --- Importance floor ---
	// Even fully decayed memories retain some strength based on importance
	const floor = importance * IMPORTANCE_FLOOR_FACTOR;

	// Combine: decay + rehearsal bonus, clamped between floor and 1.0
	const raw = decay + rehearsalBonus;
	const strength = clamp(raw, floor, 1.0);

	// Round to 3 decimal places for clean storage
	return Math.round(strength * 1000) / 1000;
}

// ---------------------------------------------------------------------------
// Database Operations
// ---------------------------------------------------------------------------

/**
 * Record a rehearsal event for a memory.
 *
 * Increments rehearsal_count, updates last_rehearsed and last_accessed
 * timestamps, and recalculates the memory's strength.
 *
 * Safe to call multiple times — each call is one rehearsal event.
 *
 * @param db       - Database with write access
 * @param memoryId - ID of the memory to rehearse
 */
export function updateStrengthOnAccess(db: TemporalDb, memoryId: string): void {
	const now = new Date().toISOString();
	const nowMs = Date.now();

	// Increment rehearsal count and update timestamps in one statement
	db.prepare(`
		UPDATE memories
		SET rehearsal_count = COALESCE(rehearsal_count, 0) + 1,
		    last_rehearsed = ?,
		    last_accessed = ?,
		    access_count = COALESCE(access_count, 0) + 1
		WHERE id = ?
	`).run(now, now, memoryId);

	// Fetch updated row to recalculate strength
	const row = db.prepare(`
		SELECT created_at, last_accessed, last_rehearsed,
		       rehearsal_count, importance, pinned
		FROM memories
		WHERE id = ?
	`).get(memoryId) as unknown as MemoryStrengthInput | undefined;

	if (row) {
		const newStrength = calculateStrength(row, nowMs);
		db.prepare("UPDATE memories SET strength = ? WHERE id = ?")
			.run(newStrength, memoryId);
	}
}

/**
 * Recalculate strength for all non-pinned, non-deleted memories.
 *
 * Intended to be called periodically (e.g., daily) from a daemon worker
 * or maintenance job. Processes in batches to avoid long write locks.
 *
 * @param db        - Database with write access
 * @param batchSize - Number of memories to process per batch (default 500)
 * @returns Summary: how many updated and elapsed time
 */
export function recalculateAllStrengths(
	db: TemporalDb,
	batchSize: number = 500,
): { updated: number; elapsed: number } {
	const start = Date.now();
	const nowMs = Date.now();
	let updated = 0;

	// Count total non-pinned active memories
	const countRow = db.prepare(
		"SELECT count(*) as n FROM memories WHERE is_deleted = 0 AND (pinned = 0 OR pinned IS NULL)"
	).get() as unknown as { n: number } | undefined;
	const total = countRow?.n ?? 0;

	for (let offset = 0; offset < total; offset += batchSize) {
		const rows = db.prepare(`
			SELECT id, created_at, last_accessed, last_rehearsed,
			       rehearsal_count, importance, pinned, strength
			FROM memories
			WHERE is_deleted = 0 AND (pinned = 0 OR pinned IS NULL)
			ORDER BY id
			LIMIT ? OFFSET ?
		`).all(batchSize, offset) as unknown as Array<MemoryStrengthInput & { id: string; strength: number | null }>;

		for (const row of rows) {
			const newStrength = calculateStrength(row, nowMs);
			const currentStrength = row.strength ?? 1.0;

			// Only update if strength changed meaningfully (saves IO)
			if (Math.abs(newStrength - currentStrength) > 0.001) {
				db.prepare("UPDATE memories SET strength = ? WHERE id = ?")
					.run(newStrength, row.id);
				updated++;
			}
		}
	}

	return { updated, elapsed: Date.now() - start };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Safely parse an ISO date string to milliseconds.
 * Returns null for null/undefined/invalid/NaN dates.
 */
function parseDateMs(dateStr: string | null | undefined): number | null {
	if (!dateStr) return null;
	const ms = new Date(dateStr).getTime();
	return Number.isFinite(ms) ? ms : null;
}

/** Clamp a number to [min, max]. */
function clamp(value: number, min: number, max: number): number {
	if (!Number.isFinite(value)) return min;
	return Math.min(max, Math.max(min, value));
}
