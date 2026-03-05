/**
 * Timeline Era Detection
 *
 * Analyzes memory and entity patterns to detect distinct "eras" in an
 * agent's workflow. Uses Jensen-Shannon divergence to find boundaries
 * where entity distributions shift significantly.
 */

import type { ReadDb, WriteDb, DbAccessor } from "./db-accessor";
import { logger } from "./logger";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TimelineEra {
	readonly id: string;
	readonly name: string;
	readonly start_date: string;
	readonly end_date: string;
	readonly era_type: "project" | "topic" | "workflow" | "transition";
	readonly entity_patterns: string | null; // JSON array
	readonly memory_count: number;
	readonly top_entities: string | null; // JSON array
	readonly metadata: string | null; // JSON object
	readonly created_at: string;
	readonly updated_at: string;
}

interface TimeBucket {
	start: string;
	end: string;
	memory_count: number;
	entity_counts: Map<string, number>;
	total_mentions: number;
}

// ---------------------------------------------------------------------------
// Entity Distribution Analysis
// ---------------------------------------------------------------------------

/**
 * Compute Jensen-Shannon divergence between two probability distributions.
 * Returns value between 0 (identical) and 1 (completely different).
 */
function jensenShannonDivergence(p: Map<string, number>, q: Map<string, number>): number {
	// Get all unique keys
	const keys = new Set([...p.keys(), ...q.keys()]);

	// Normalize distributions
	const pTotal = Array.from(p.values()).reduce((sum, v) => sum + v, 0) || 1;
	const qTotal = Array.from(q.values()).reduce((sum, v) => sum + v, 0) || 1;

	// Compute KL divergences
	let jsDiv = 0;
	for (const key of keys) {
		const pVal = (p.get(key) || 0) / pTotal;
		const qVal = (q.get(key) || 0) / qTotal;
		const mVal = (pVal + qVal) / 2;

		if (pVal > 0) jsDiv += 0.5 * pVal * Math.log2(pVal / mVal);
		if (qVal > 0) jsDiv += 0.5 * qVal * Math.log2(qVal / mVal);
	}

	return jsDiv;
}

/**
 * Extract entity distribution for a time window.
 */
function getEntityDistribution(
	db: ReadDb,
	startDate: string,
	endDate: string,
): Map<string, number> {
	const rows = db
		.prepare(
			`SELECT e.canonical_name, COUNT(*) as count
			 FROM memory_entity_mentions mem
			 JOIN entities e ON e.id = mem.entity_id
			 JOIN memories m ON m.id = mem.memory_id
			 WHERE m.created_at >= ? AND m.created_at < ? AND m.is_deleted = 0
			 GROUP BY e.canonical_name
			 ORDER BY count DESC
			 LIMIT 50`,
		)
		.all(startDate, endDate) as Array<{ canonical_name: string; count: number }>;

	const distribution = new Map<string, number>();
	for (const row of rows) {
		distribution.set(row.canonical_name, row.count);
	}
	return distribution;
}

/**
 * Get memory count for a time window.
 */
function getMemoryCount(db: ReadDb, startDate: string, endDate: string): number {
	const row = db
		.prepare(
			`SELECT COUNT(*) as count FROM memories
			 WHERE created_at >= ? AND created_at < ? AND is_deleted = 0`,
		)
		.get(startDate, endDate) as { count: number };
	return row?.count ?? 0;
}

// ---------------------------------------------------------------------------
// Era Detection
// ---------------------------------------------------------------------------

/**
 * Generate time buckets for analysis.
 */
function generateBuckets(startDate: Date, endDate: Date, granularityDays: number): TimeBucket[] {
	const buckets: TimeBucket[] = [];
	const current = new Date(startDate);
	const msPerDay = 24 * 60 * 60 * 1000;
	const bucketMs = granularityDays * msPerDay;

	while (current < endDate) {
		const bucketStart = current.toISOString();
		current.setTime(current.getTime() + bucketMs);
		const bucketEnd = current < endDate ? current.toISOString() : endDate.toISOString();

		buckets.push({
			start: bucketStart,
			end: bucketEnd,
			memory_count: 0,
			entity_counts: new Map(),
			total_mentions: 0,
		});
	}

	return buckets;
}

/**
 * Populate bucket statistics from database.
 */
function populateBuckets(db: ReadDb, buckets: TimeBucket[]): void {
	for (const bucket of buckets) {
		bucket.memory_count = getMemoryCount(db, bucket.start, bucket.end);
		bucket.entity_counts = getEntityDistribution(db, bucket.start, bucket.end);
		bucket.total_mentions = Array.from(bucket.entity_counts.values()).reduce(
			(sum, v) => sum + v,
			0,
		);
	}
}

/**
 * Detect era boundaries using entity distribution shifts.
 * Returns array of bucket indices where boundaries occur.
 */
function detectBoundaries(buckets: TimeBucket[], threshold: number = 0.3): number[] {
	const boundaries: number[] = [];

	for (let i = 1; i < buckets.length; i++) {
		const prev = buckets[i - 1];
		const curr = buckets[i];

		// Skip if either bucket has too few data
		if (prev.memory_count < 3 || curr.memory_count < 3) continue;

		const divergence = jensenShannonDivergence(prev.entity_counts, curr.entity_counts);

		if (divergence > threshold) {
			boundaries.push(i);
		}
	}

	return boundaries;
}

/**
 * Generate a name for an era based on top entities.
 */
function generateEraName(topEntities: string[]): string {
	if (topEntities.length === 0) return "Unnamed Era";
	if (topEntities.length === 1) return `${topEntities[0]} Work`;
	if (topEntities.length === 2) return `${topEntities[0]} & ${topEntities[1]}`;

	return `${topEntities[0]}, ${topEntities[1]} & ${topEntities[2]}`;
}

/**
 * Classify era type based on entity patterns.
 */
function classifyEraType(topEntities: string[], memoryDensity: number): TimelineEra["era_type"] {
	// Simple heuristic classification
	if (topEntities.some((e) => /project|repo|repository/i.test(e))) {
		return "project";
	}
	if (memoryDensity > 10) {
		return "workflow";
	}
	return "topic";
}

// ---------------------------------------------------------------------------
// Main Detection Function
// ---------------------------------------------------------------------------

/**
 * Detect timeline eras and store them in the database.
 */
export function detectTimelineEras(
	db: DbAccessor,
	opts?: {
		granularityDays?: number;
		divergenceThreshold?: number;
		minBucketsPerEra?: number;
	},
): number {
	const granularityDays = opts?.granularityDays ?? 7;
	const divergenceThreshold = opts?.divergenceThreshold ?? 0.3;
	const minBucketsPerEra = opts?.minBucketsPerEra ?? 2;

	return db.withWriteTx((wdb: WriteDb) => {
		// Get date range from memories
		const dateRange = wdb
			.prepare(
				`SELECT MIN(created_at) as start, MAX(created_at) as end
				 FROM memories WHERE is_deleted = 0`,
			)
			.get() as { start: string; end: string } | undefined;

		if (!dateRange?.start || !dateRange?.end) {
			logger.info("timeline", "No memories found for era detection");
			return 0;
		}

		const startDate = new Date(dateRange.start);
		const endDate = new Date(dateRange.end);

		// Generate and populate buckets
		const buckets = generateBuckets(startDate, endDate, granularityDays);
		populateBuckets(wdb, buckets);

		if (buckets.length === 0) {
			logger.info("timeline", "No time buckets generated");
			return 0;
		}

		// Detect boundaries
		const boundaries = detectBoundaries(buckets, divergenceThreshold);

		// Create eras from boundaries
		const now = new Date().toISOString();
		let eraCount = 0;
		let eraStart = 0;

		const eraIds: string[] = [];

		for (let i = 0; i <= buckets.length; i++) {
			// Check if this is an era end (either a boundary or the last bucket)
			if (i === buckets.length || boundaries.includes(i)) {
				const eraEnd = i;

				// Skip if era is too short
				if (eraEnd - eraStart < minBucketsPerEra) {
					eraStart = eraEnd;
					continue;
				}

				// Aggregate era statistics
				const eraBuckets = buckets.slice(eraStart, eraEnd);
				const memoryCount = eraBuckets.reduce((sum, b) => sum + b.memory_count, 0);

				// Get top entities for the era
				const entityAggregates = new Map<string, number>();
				for (const bucket of eraBuckets) {
					for (const [entity, count] of bucket.entity_counts) {
						entityAggregates.set(entity, (entityAggregates.get(entity) || 0) + count);
					}
				}

				const topEntities = Array.from(entityAggregates.entries())
					.sort((a, b) => b[1] - a[1])
					.slice(0, 5)
					.map(([name]) => name);

				const eraName = generateEraName(topEntities);
				const eraType = classifyEraType(topEntities, memoryCount / eraBuckets.length);

				const eraId = crypto.randomUUID();
				eraIds.push(eraId);

				// Insert era
				wdb.prepare(
					`INSERT INTO timeline_eras
					 (id, name, start_date, end_date, era_type, entity_patterns,
					  memory_count, top_entities, metadata, created_at, updated_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				).run(
					eraId,
					eraName,
					buckets[eraStart].start,
					buckets[eraEnd - 1].end,
					eraType,
					JSON.stringify(topEntities),
					memoryCount,
					JSON.stringify(topEntities),
					JSON.stringify({ bucketCount: eraBuckets.length }),
					now,
					now,
				);

				eraCount++;
				eraStart = eraEnd;
			}
		}

		// Clear old eras before inserting new ones
		if (eraIds.length > 0) {
			const placeholders = eraIds.map(() => "?").join(",");
			wdb.prepare(`DELETE FROM timeline_eras WHERE id NOT IN (${placeholders})`).run(...eraIds);
		}

		logger.info("timeline", "Era detection complete", { eraCount });
		return eraCount;
	});
}

// ---------------------------------------------------------------------------
// Entity Emergence Tracking
// ---------------------------------------------------------------------------

/**
 * Backfill entity emergence dates from existing data.
 */
export function backfillEntityEmergence(db: DbAccessor): number {
	return db.withWriteTx((wdb: WriteDb) => {
		const now = new Date().toISOString();

		// Update first_seen_at for entities
		const result1 = wdb.prepare(`
			UPDATE entities
			SET first_seen_at = (
				SELECT MIN(m.created_at)
				FROM memory_entity_mentions mem
				JOIN memories m ON m.id = mem.memory_id
				WHERE mem.entity_id = entities.id
			)
			WHERE first_seen_at IS NULL
		`).run();

		// Update peak_mentions_at for entities
		const result2 = wdb.prepare(`
			UPDATE entities
			SET peak_mentions_at = (
				SELECT m.created_at
				FROM memory_entity_mentions mem
				JOIN memories m ON m.id = mem.memory_id
				WHERE mem.entity_id = entities.id
				GROUP BY DATE(m.created_at)
				ORDER BY COUNT(*) DESC
				LIMIT 1
			)
			WHERE peak_mentions_at IS NULL
		`).run();

		const changes = ((result1 as any).changes || 0) + ((result2 as any).changes || 0);

		if (changes > 0) {
			logger.info("timeline", "Entity emergence backfilled", { changes });
		}

		return changes;
	});
}
