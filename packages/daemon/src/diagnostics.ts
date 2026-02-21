/**
 * Read-only health signals for the Signet memory system.
 *
 * All functions accept a ReadDb or ProviderTracker and return plain
 * data structs — no side effects, no mutations.
 */

import type { ReadDb } from "./db-accessor";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HealthScore {
	readonly score: number;
	readonly status: "healthy" | "degraded" | "unhealthy";
}

export interface QueueHealth extends HealthScore {
	readonly depth: number;
	readonly oldestAgeSec: number;
	readonly deadRate: number;
	readonly leaseAnomalies: number;
}

export interface StorageHealth extends HealthScore {
	readonly totalMemories: number;
	readonly deletedTombstones: number;
	readonly dbSizeBytes: number;
}

export interface IndexHealth extends HealthScore {
	readonly ftsRowCount: number;
	readonly memoriesRowCount: number;
	readonly ftsMismatch: boolean;
	readonly embeddingCoverage: number;
}

export interface ProviderHealth extends HealthScore {
	readonly recentTotal: number;
	readonly recentSuccesses: number;
	readonly recentFailures: number;
	readonly recentTimeouts: number;
	readonly availabilityRate: number;
}

export interface MutationHealth extends HealthScore {
	readonly recentRecovers: number;
	readonly recentDeletes: number;
}

export interface ConnectorHealth extends HealthScore {
	readonly connectorCount: number;
	readonly syncingCount: number;
	readonly errorCount: number;
	readonly oldestErrorAge: number;
}

export interface DiagnosticsReport {
	readonly timestamp: string;
	readonly composite: HealthScore;
	readonly queue: QueueHealth;
	readonly storage: StorageHealth;
	readonly index: IndexHealth;
	readonly provider: ProviderHealth;
	readonly mutation: MutationHealth;
	readonly connector: ConnectorHealth;
}

// ---------------------------------------------------------------------------
// Provider tracker (in-memory ring buffer)
// ---------------------------------------------------------------------------

export interface ProviderTracker {
	record(outcome: "success" | "failure" | "timeout"): void;
	readonly stats: {
		total: number;
		successes: number;
		failures: number;
		timeouts: number;
	};
}

type Outcome = "success" | "failure" | "timeout";

export function createProviderTracker(capacity = 100): ProviderTracker {
	const buffer: Array<Outcome> = new Array(capacity).fill(null);
	let head = 0;
	let size = 0;

	// Counts for the active portion of the ring buffer
	let successes = 0;
	let failures = 0;
	let timeouts = 0;

	function addCount(outcome: Outcome, delta: 1 | -1): void {
		if (outcome === "success") successes += delta;
		else if (outcome === "failure") failures += delta;
		else timeouts += delta;
	}

	return {
		record(outcome: Outcome): void {
			const evicted = buffer[head];
			// If the slot we're about to overwrite held a real value, subtract it
			if (size === capacity && evicted !== null) {
				addCount(evicted as Outcome, -1);
			}
			buffer[head] = outcome;
			addCount(outcome, 1);
			head = (head + 1) % capacity;
			if (size < capacity) size += 1;
		},

		get stats() {
			return {
				total: size,
				successes,
				failures,
				timeouts,
			};
		},
	};
}

// ---------------------------------------------------------------------------
// Score helper
// ---------------------------------------------------------------------------

function scoreStatus(score: number): "healthy" | "degraded" | "unhealthy" {
	if (score >= 0.8) return "healthy";
	if (score >= 0.5) return "degraded";
	return "unhealthy";
}

function clamp(n: number): number {
	return Math.max(0, Math.min(1, n));
}

// ---------------------------------------------------------------------------
// Domain health functions
// ---------------------------------------------------------------------------

export function getQueueHealth(db: ReadDb): QueueHealth {
	const pendingRow = db
		.prepare(
			`SELECT COUNT(*) AS cnt, MIN(created_at) AS oldest
			 FROM memory_jobs WHERE status = 'pending'`,
		)
		.get() as { cnt: number; oldest: string | null } | undefined;

	const depth = pendingRow?.cnt ?? 0;
	const oldestAt = pendingRow?.oldest;
	const oldestAgeSec = oldestAt
		? Math.max(0, (Date.now() - new Date(oldestAt).getTime()) / 1000)
		: 0;

	const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
	const deadRow = db
		.prepare(
			`SELECT
				SUM(CASE WHEN status = 'dead' THEN 1 ELSE 0 END) AS dead,
				SUM(CASE WHEN status IN ('completed','dead') THEN 1 ELSE 0 END) AS total
			 FROM memory_jobs
			 WHERE updated_at >= ?`,
		)
		.get(oneDayAgo) as { dead: number; total: number } | undefined;

	const dead = deadRow?.dead ?? 0;
	const completedAndDead = deadRow?.total ?? 0;
	const deadRate = completedAndDead > 0 ? dead / completedAndDead : 0;

	// Jobs that are still 'leased' but were created more than 10 minutes ago
	const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
	const anomalyRow = db
		.prepare(
			`SELECT COUNT(*) AS cnt FROM memory_jobs
			 WHERE status = 'leased'
			   AND created_at < ?`,
		)
		.get(tenMinAgo) as { cnt: number } | undefined;

	const leaseAnomalies = anomalyRow?.cnt ?? 0;

	let score = 1.0;
	if (depth > 50) score -= 0.3;
	if (deadRate > 0.01) score -= 0.3;
	if (oldestAgeSec > 300) score -= 0.2;
	if (leaseAnomalies > 0) score -= 0.2;

	score = clamp(score);
	return {
		score,
		status: scoreStatus(score),
		depth,
		oldestAgeSec,
		deadRate,
		leaseAnomalies,
	};
}

export function getStorageHealth(db: ReadDb): StorageHealth {
	const row = db
		.prepare(
			`SELECT
				COUNT(*) AS total,
				SUM(is_deleted) AS deleted
			 FROM memories`,
		)
		.get() as { total: number; deleted: number } | undefined;

	const totalMemories = row?.total ?? 0;
	const deletedTombstones = row?.deleted ?? 0;

	const tombstoneRatio =
		totalMemories > 0 ? deletedTombstones / totalMemories : 0;

	let score = 1.0;
	if (tombstoneRatio > 0.3) score -= 0.3;

	score = clamp(score);
	return {
		score,
		status: scoreStatus(score),
		totalMemories,
		deletedTombstones,
		// Can't get actual file size from a read connection
		dbSizeBytes: 0,
	};
}

export function getIndexHealth(db: ReadDb): IndexHealth {
	// Active (non-deleted) memories are what should be searchable
	const memRow = db
		.prepare(`SELECT COUNT(*) AS cnt FROM memories WHERE is_deleted = 0`)
		.get() as { cnt: number } | undefined;

	const memoriesRowCount = memRow?.cnt ?? 0;

	// memories_fts is a content table backed by memories — COUNT(*) returns
	// the total memories row count (active + tombstones). A mismatch against
	// the active count reveals tombstone accumulation visible in FTS.
	const ftsRow = db
		.prepare(`SELECT COUNT(*) AS cnt FROM memories_fts`)
		.get() as { cnt: number } | undefined;

	const ftsRowCount = ftsRow?.cnt ?? 0;

	// Mismatch means FTS backing table has more rows than active memories,
	// i.e., tombstones are included in the FTS index. Detect when the gap
	// exceeds 10% of the active count (a content table will always show
	// at least the active rows, so ftsRowCount >= memoriesRowCount).
	const ftsMismatch =
		memoriesRowCount > 0 && ftsRowCount > memoriesRowCount * 1.1;

	const embRow = db
		.prepare(
			`SELECT COUNT(*) AS cnt FROM memories
			 WHERE is_deleted = 0 AND embedding_model IS NOT NULL`,
		)
		.get() as { cnt: number } | undefined;

	const withEmbeddings = embRow?.cnt ?? 0;
	const embeddingCoverage =
		memoriesRowCount > 0 ? withEmbeddings / memoriesRowCount : 1;

	let score = 1.0;
	if (ftsMismatch) score -= 0.5;
	if (embeddingCoverage < 0.8) score -= 0.3;

	score = clamp(score);
	return {
		score,
		status: scoreStatus(score),
		ftsRowCount,
		memoriesRowCount,
		ftsMismatch,
		embeddingCoverage,
	};
}

export function getProviderHealth(tracker: ProviderTracker): ProviderHealth {
	const { total, successes, failures, timeouts } = tracker.stats;
	const availabilityRate =
		total > 0 ? successes / total : 1; // no data → assume healthy

	const score = clamp(availabilityRate);
	return {
		score,
		status: scoreStatus(score),
		recentTotal: total,
		recentSuccesses: successes,
		recentFailures: failures,
		recentTimeouts: timeouts,
		availabilityRate,
	};
}

export function getMutationHealth(db: ReadDb): MutationHealth {
	const sevenDaysAgo = new Date(
		Date.now() - 7 * 24 * 60 * 60 * 1000,
	).toISOString();
	const row = db
		.prepare(
			`SELECT
				SUM(CASE WHEN event = 'recovered' THEN 1 ELSE 0 END) AS recovers,
				SUM(CASE WHEN event = 'deleted'   THEN 1 ELSE 0 END) AS deletes
			 FROM memory_history
			 WHERE created_at >= ?`,
		)
		.get(sevenDaysAgo) as { recovers: number; deletes: number } | undefined;

	const recentRecovers = row?.recovers ?? 0;
	const recentDeletes = row?.deletes ?? 0;

	let score = 1.0;
	// Many recoveries suggest wrong-target deletes being undone
	if (recentRecovers > 5) score -= 0.3;

	score = clamp(score);
	return {
		score,
		status: scoreStatus(score),
		recentRecovers,
		recentDeletes,
	};
}

export function getConnectorHealth(db: ReadDb): ConnectorHealth {
	const perfect: ConnectorHealth = {
		score: 1.0,
		status: "healthy",
		connectorCount: 0,
		syncingCount: 0,
		errorCount: 0,
		oldestErrorAge: 0,
	};

	try {
		const totalRow = db
			.prepare(
				`SELECT
					COUNT(*) AS total,
					SUM(CASE WHEN status = 'syncing' THEN 1 ELSE 0 END) AS syncing,
					SUM(CASE WHEN last_error IS NOT NULL THEN 1 ELSE 0 END) AS errors
				 FROM connectors`,
			)
			.get() as {
			total: number;
			syncing: number;
			errors: number;
		} | undefined;

		const connectorCount = totalRow?.total ?? 0;
		const syncingCount = totalRow?.syncing ?? 0;
		const errorCount = totalRow?.errors ?? 0;

		// Find the oldest unresolved error to gauge how long things have been broken
		const oldestErrorRow = db
			.prepare(
				`SELECT MIN(updated_at) AS oldest
				 FROM connectors
				 WHERE last_error IS NOT NULL`,
			)
			.get() as { oldest: string | null } | undefined;

		const oldestAt = oldestErrorRow?.oldest;
		const oldestErrorAge = oldestAt
			? Math.max(0, Date.now() - new Date(oldestAt).getTime())
			: 0;

		let score = 1.0;
		if (errorCount > 0) score -= 0.3;
		if (oldestErrorAge > 86400000) score -= 0.2;

		score = clamp(score);
		return {
			score,
			status: scoreStatus(score),
			connectorCount,
			syncingCount,
			errorCount,
			oldestErrorAge,
		};
	} catch {
		// connectors table doesn't exist yet on older databases
		return perfect;
	}
}

// ---------------------------------------------------------------------------
// Composite report
// ---------------------------------------------------------------------------

const WEIGHTS = {
	queue: 0.28,
	storage: 0.14,
	index: 0.19,
	provider: 0.24,
	mutation: 0.10,
	connector: 0.05,
} as const;

export function getDiagnostics(
	db: ReadDb,
	tracker: ProviderTracker,
): DiagnosticsReport {
	const queue = getQueueHealth(db);
	const storage = getStorageHealth(db);
	const index = getIndexHealth(db);
	const provider = getProviderHealth(tracker);
	const mutation = getMutationHealth(db);
	const connector = getConnectorHealth(db);

	const compositeScore = clamp(
		queue.score * WEIGHTS.queue +
			storage.score * WEIGHTS.storage +
			index.score * WEIGHTS.index +
			provider.score * WEIGHTS.provider +
			mutation.score * WEIGHTS.mutation +
			connector.score * WEIGHTS.connector,
	);

	const composite: HealthScore = {
		score: compositeScore,
		status: scoreStatus(compositeScore),
	};

	return {
		timestamp: new Date().toISOString(),
		composite,
		queue,
		storage,
		index,
		provider,
		mutation,
		connector,
	};
}
