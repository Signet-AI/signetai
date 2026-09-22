import { readMemoriesFtsIndexRowCount } from "@signet/core";
import type { ReadDb } from "./db-accessor";
import {
	DEFAULT_QUEUE_THRESHOLDS,
	type OldestDeadJob,
	type QueueCounts,
	getQueueDiagnosticsSnapshot,
	scoreCountsWithThresholds,
	worstQueueScore,
} from "./diagnostics-queue";
import type { UpdateState } from "./update-system";

export interface HealthScore {
	readonly score: number;
	readonly status: "healthy" | "degraded" | "unhealthy";
}

export interface QueueHealth extends HealthScore {
	readonly depth: number;
	readonly oldestAgeSec: number;
	readonly deadRate: number;
	readonly leaseAnomalies: number;
	readonly memory: QueueCounts;
	readonly summary: QueueCounts;
	readonly oldestDeadSummaryJob: OldestDeadJob | null;
	readonly oldestDeadMemoryJob: OldestDeadJob | null;
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
	readonly indexNeedsRepair: boolean;
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

export interface DuplicateHealth extends HealthScore {
	readonly exactDuplicates: number;
	readonly exactClusters: number;
	readonly totalActive: number;
	readonly duplicateRatio: number;
}

export interface ConnectorHealth extends HealthScore {
	readonly connectorCount: number;
	readonly syncingCount: number;
	readonly errorCount: number;
	readonly oldestErrorAge: number;
}

export interface UpdateHealth extends HealthScore {
	readonly autoInstallEnabled: boolean;
	readonly lastCheckSucceeded: boolean;
	readonly lastCheckAgeHours: number;
	readonly pendingRestart: boolean;
	readonly lastError: string | null;
}

export interface GraphHealth extends HealthScore {
	readonly entityCount: number;
	readonly edgeCount: number;
	readonly communityCount: number;
	readonly modularity: number | null;
	readonly quality: "fragmented" | "moderate" | "strong" | "unknown";
}

export type OpenClawStatus = "connected" | "stale" | "never-seen";

export interface OpenClawHealth {
	readonly status: OpenClawStatus;
	readonly lastHeartbeat: string | null;
	readonly pluginVersion: string | null;
	readonly hooksRegistered: readonly string[];
	readonly hooksSucceeded: number;
	readonly hooksFailed: number;
	readonly lastLatencyMs: number;
	readonly lastError: string | null;
}

export interface DiagnosticsReport {
	readonly timestamp: string;
	readonly composite: HealthScore;
	readonly queue: QueueHealth;
	readonly storage: StorageHealth;
	readonly index: IndexHealth;
	readonly provider: ProviderHealth;
	readonly mutation: MutationHealth;
	readonly duplicate: DuplicateHealth;
	readonly connector: ConnectorHealth;
	readonly update: UpdateHealth;
	readonly graph: GraphHealth;
	readonly openclaw: OpenClawHealth;
}

export interface DiagnosticsOptions {
	readonly graphEnabled?: boolean;
	readonly traversalPrimary?: boolean;
}

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

function scoreStatus(score: number): "healthy" | "degraded" | "unhealthy" {
	if (score >= 0.8) return "healthy";
	if (score >= 0.5) return "degraded";
	return "unhealthy";
}

function worstStatus(statuses: readonly HealthScore["status"][]): HealthScore["status"] {
	if (statuses.includes("unhealthy")) return "unhealthy";
	if (statuses.includes("degraded")) return "degraded";
	return "healthy";
}

function clamp(n: number): number {
	return Math.max(0, Math.min(1, n));
}

const QUEUE_RECENT_WINDOW_MS = 60 * 60 * 1000;
export const QUEUE_MAX_DEPTH = 50;
export const QUEUE_MAX_DEAD_RATE = 0.01;
export const QUEUE_MAX_OLDEST_AGE_SEC = 300;
const GRAPH_FLATLINE_MEMORY_THRESHOLD = 10;

export function getQueueHealth(db: ReadDb): QueueHealth {
	const pendingRow = db
		.prepare(
			`SELECT COUNT(*) AS cnt, MIN(created_at) AS oldest
			 FROM memory_jobs WHERE status = 'pending' AND job_type <> 'extract'`,
		)
		.get() as { cnt: number; oldest: string | null } | undefined;

	const depth = pendingRow?.cnt ?? 0;
	const oldestAt = pendingRow?.oldest;
	const oldestAgeSec = oldestAt ? Math.max(0, (Date.now() - new Date(oldestAt).getTime()) / 1000) : 0;

	const windowStart = new Date(Date.now() - QUEUE_RECENT_WINDOW_MS).toISOString();
	const deadRow = db
		.prepare(
			`SELECT
				SUM(CASE WHEN status = 'dead' THEN 1 ELSE 0 END) AS dead,
				SUM(CASE WHEN status IN ('completed','dead') THEN 1 ELSE 0 END) AS total
			 FROM memory_jobs
			 WHERE updated_at >= ? AND job_type <> 'extract'`,
		)
		.get(windowStart) as { dead: number; total: number } | undefined;

	const dead = deadRow?.dead ?? 0;
	const completedAndDead = deadRow?.total ?? 0;
	const deadRate = completedAndDead > 0 ? dead / completedAndDead : 0;
	const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
	const anomalyRow = db
		.prepare(
			`SELECT COUNT(*) AS cnt FROM memory_jobs
			 WHERE status = 'leased' AND job_type <> 'extract'
			   AND created_at < ?`,
		)
		.get(tenMinAgo) as { cnt: number } | undefined;

	const leaseAnomalies = anomalyRow?.cnt ?? 0;
	const { memory, summary, oldestDeadSummaryJob, oldestDeadMemoryJob } = getQueueDiagnosticsSnapshot(db);
	const memoryScore = scoreCountsWithThresholds(memory, "memory", DEFAULT_QUEUE_THRESHOLDS);
	const summaryScore = scoreCountsWithThresholds(summary, "summary", DEFAULT_QUEUE_THRESHOLDS);
	const queueScore = worstQueueScore([memoryScore, summaryScore]);

	let score = 1.0;
	if (depth > QUEUE_MAX_DEPTH) score -= 0.3;
	if (deadRate > QUEUE_MAX_DEAD_RATE) score -= 0.3;
	if (oldestAgeSec > QUEUE_MAX_OLDEST_AGE_SEC) score -= 0.2;
	if (leaseAnomalies > 0) score -= 0.2;
	score = clamp(score);
	const blended = clamp(Math.min(score, queueScore.score));
	const status = worstStatus([scoreStatus(blended), queueScore.status]);

	return {
		score: blended,
		status,
		depth,
		oldestAgeSec,
		deadRate,
		leaseAnomalies,
		memory,
		summary,
		oldestDeadSummaryJob,
		oldestDeadMemoryJob,
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

	const tombstoneRatio = totalMemories > 0 ? deletedTombstones / totalMemories : 0;

	let score = 1.0;
	if (tombstoneRatio > 0.3) score -= 0.3;

	score = clamp(score);
	return {
		score,
		status: scoreStatus(score),
		totalMemories,
		deletedTombstones,
		dbSizeBytes: getDatabaseSizeBytes(db),
	};
}

function getDatabaseSizeBytes(db: ReadDb): number {
	try {
		const pageCount = db.prepare("PRAGMA page_count").get() as { page_count?: number } | undefined;
		const pageSize = db.prepare("PRAGMA page_size").get() as { page_size?: number } | undefined;
		const pages = pageCount?.page_count ?? 0;
		const bytesPerPage = pageSize?.page_size ?? 0;
		return Number.isFinite(pages) && Number.isFinite(bytesPerPage) ? pages * bytesPerPage : 0;
	} catch {
		return 0;
	}
}

export function getIndexHealth(db: ReadDb): IndexHealth {
	const canonicalMemRow = db.prepare("SELECT COUNT(*) AS cnt FROM memories").get() as { cnt: number } | undefined;
	const activeMemRow = db.prepare("SELECT COUNT(*) AS cnt FROM memories WHERE is_deleted = 0").get() as
		| { cnt: number }
		| undefined;

	const canonicalMemoriesRowCount = canonicalMemRow?.cnt ?? 0;
	const memoriesRowCount = activeMemRow?.cnt ?? 0;
	let ftsRowCount = 0;
	let ftsIndexAvailable = false;
	try {
		const indexRowCount = readMemoriesFtsIndexRowCount(db);
		if (indexRowCount !== null) {
			ftsRowCount = indexRowCount;
			ftsIndexAvailable = true;
		}
	} catch {}

	const ftsMismatch = !ftsIndexAvailable || canonicalMemoriesRowCount !== ftsRowCount;

	const embRow = db
		.prepare(
			`SELECT COUNT(*) AS cnt FROM memories
			 WHERE is_deleted = 0 AND embedding_model IS NOT NULL`,
		)
		.get() as { cnt: number } | undefined;

	const withEmbeddings = embRow?.cnt ?? 0;
	const embeddingCoverage = memoriesRowCount > 0 ? withEmbeddings / memoriesRowCount : 1;

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
		indexNeedsRepair: ftsMismatch || embeddingCoverage < 0.8,
	};
}

export function getProviderHealth(tracker: ProviderTracker): ProviderHealth {
	const { total, successes, failures, timeouts } = tracker.stats;
	const availabilityRate = total > 0 ? successes / total : 1;

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
	const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
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
	if (recentRecovers > 5) score -= 0.3;

	score = clamp(score);
	return {
		score,
		status: scoreStatus(score),
		recentRecovers,
		recentDeletes,
	};
}

export function getDuplicateHealth(db: ReadDb): DuplicateHealth {
	const row = db
		.prepare(
			`SELECT total_active AS totalActive,
			        exact_duplicates AS exactDuplicates,
			        exact_clusters AS exactClusters
			 FROM memories_diagnostics_state
			 WHERE id = 1`,
		)
		.get() as
		| {
				totalActive: number;
				exactDuplicates: number;
				exactClusters: number;
		  }
		| undefined;

	const totalActive = row?.totalActive ?? 0;
	const exactDuplicates = row?.exactDuplicates ?? 0;
	const exactClusters = row?.exactClusters ?? 0;
	const duplicateRatio = totalActive > 0 ? exactDuplicates / totalActive : 0;

	let score = 1.0;
	if (duplicateRatio > 0.1) score -= 0.5;
	else if (duplicateRatio > 0.05) score -= 0.3;

	score = clamp(score);
	return {
		score,
		status: scoreStatus(score),
		exactDuplicates,
		exactClusters,
		totalActive,
		duplicateRatio,
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
			.get() as
			| {
					total: number;
					syncing: number;
					errors: number;
			  }
			| undefined;

		const connectorCount = totalRow?.total ?? 0;
		const syncingCount = totalRow?.syncing ?? 0;
		const errorCount = totalRow?.errors ?? 0;
		const oldestErrorRow = db
			.prepare(
				`SELECT MIN(updated_at) AS oldest
				 FROM connectors
				 WHERE last_error IS NOT NULL`,
			)
			.get() as { oldest: string | null } | undefined;

		const oldestAt = oldestErrorRow?.oldest;
		const oldestErrorAge = oldestAt ? Math.max(0, Date.now() - new Date(oldestAt).getTime()) : 0;

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
		return perfect;
	}
}

export function getUpdateHealth(state?: UpdateState): UpdateHealth {
	if (!state) {
		return {
			score: 1.0,
			status: "healthy",
			autoInstallEnabled: false,
			lastCheckSucceeded: true,
			lastCheckAgeHours: 0,
			pendingRestart: false,
			lastError: null,
		};
	}

	const lastCheckAgeHours = state.lastCheckTime ? (Date.now() - state.lastCheckTime.getTime()) / 3_600_000 : 0;

	const lastCheckSucceeded = state.lastCheck ? !state.lastCheck.checkError : true;

	let score = 1.0;

	if (state.currentVersion === "0.0.0") score -= 0.5;

	if (state.pendingRestartVersion && lastCheckAgeHours > 1) {
		score -= 0.3;
	}

	if (state.lastAutoUpdateError && state.config.autoInstall) {
		score -= 0.4;
	}

	if (state.config.autoInstall && lastCheckAgeHours > 24) {
		score -= 0.2;
	}

	if (!state.config.autoInstall && state.lastCheck?.updateAvailable) {
		score -= 0.1;
	}

	score = clamp(score);
	return {
		score,
		status: scoreStatus(score),
		autoInstallEnabled: state.config.autoInstall,
		lastCheckSucceeded,
		lastCheckAgeHours: Math.round(lastCheckAgeHours * 10) / 10,
		pendingRestart: state.pendingRestartVersion !== null,
		lastError: state.lastAutoUpdateError,
	};
}

const BASE_WEIGHTS = {
	queue: 0.23,
	storage: 0.1,
	index: 0.15,
	provider: 0.2,
	mutation: 0.08,
	duplicate: 0.04,
	connector: 0.05,
	update: 0.1,
	graph: 0.05,
} as const;

export function getGraphHealth(
	db: ReadDb,
	options?: Pick<DiagnosticsOptions, "graphEnabled" | "traversalPrimary">,
): GraphHealth {
	try {
		const entityRow = db.prepare("SELECT COUNT(*) AS n FROM entities").get() as { n: number } | undefined;
		const edgeRow = db.prepare("SELECT COUNT(*) AS n FROM entity_dependencies").get() as { n: number } | undefined;
		const communityRow = db.prepare("SELECT COUNT(*) AS n FROM entity_communities").get() as { n: number } | undefined;
		const memoryRow = db.prepare("SELECT COUNT(*) AS n FROM memories WHERE COALESCE(is_deleted, 0) = 0").get() as
			| { n: number }
			| undefined;

		const communityCount = communityRow?.n ?? 0;
		const cohesionRow = db
			.prepare("SELECT AVG(cohesion) AS avg FROM entity_communities WHERE member_count > 1")
			.get() as { avg: number | null } | undefined;

		const entityCount = entityRow?.n ?? 0;
		const edgeCount = edgeRow?.n ?? 0;
		const activeMemoryCount = memoryRow?.n ?? 0;
		const graphEnabled = options?.graphEnabled ?? true;
		const traversalPrimary = options?.traversalPrimary ?? false;
		const zeroEdgeTraversal = traversalPrimary && edgeCount === 0;
		const score = zeroEdgeTraversal
			? 0.6
			: graphEnabled && activeMemoryCount >= GRAPH_FLATLINE_MEMORY_THRESHOLD && entityCount === 0
				? 0.6
				: 1.0;

		const avg = cohesionRow?.avg;
		const quality: GraphHealth["quality"] =
			communityCount === 0 || avg === null || avg === undefined
				? "unknown"
				: avg > 0.3
					? "strong"
					: avg >= 0.1
						? "moderate"
						: "fragmented";

		return {
			score,
			status: zeroEdgeTraversal ? "degraded" : scoreStatus(score),
			entityCount,
			edgeCount,
			communityCount,
			modularity: null,
			quality,
		};
	} catch {
		return {
			score: 1,
			status: "healthy",
			entityCount: 0,
			edgeCount: 0,
			communityCount: 0,
			modularity: null,
			quality: "unknown",
		};
	}
}

export function getDiagnostics(
	db: ReadDb,
	tracker: ProviderTracker,
	updateState?: UpdateState,
	openclawHealth?: OpenClawHealth,
	options?: DiagnosticsOptions,
): DiagnosticsReport {
	const queue = getQueueHealth(db);
	const storage = getStorageHealth(db);
	const index = getIndexHealth(db);
	const provider = getProviderHealth(tracker);
	const mutation = getMutationHealth(db);
	const duplicate = getDuplicateHealth(db);
	const connector = getConnectorHealth(db);
	const update = getUpdateHealth(updateState);
	const graph = getGraphHealth(db, {
		graphEnabled: options?.graphEnabled,
		traversalPrimary: options?.traversalPrimary,
	});

	const compositeScore = clamp(
		queue.score * BASE_WEIGHTS.queue +
			storage.score * BASE_WEIGHTS.storage +
			index.score * BASE_WEIGHTS.index +
			provider.score * BASE_WEIGHTS.provider +
			mutation.score * BASE_WEIGHTS.mutation +
			duplicate.score * BASE_WEIGHTS.duplicate +
			connector.score * BASE_WEIGHTS.connector +
			update.score * BASE_WEIGHTS.update +
			graph.score * BASE_WEIGHTS.graph,
	);

	const composite: HealthScore = {
		score: compositeScore,
		status: worstStatus([
			queue.status,
			storage.status,
			index.status,
			provider.status,
			mutation.status,
			duplicate.status,
			connector.status,
			update.status,
			graph.status,
		]),
	};

	const openclaw: OpenClawHealth = openclawHealth ?? {
		status: "never-seen",
		lastHeartbeat: null,
		pluginVersion: null,
		hooksRegistered: [],
		hooksSucceeded: 0,
		hooksFailed: 0,
		lastLatencyMs: 0,
		lastError: null,
	};

	return {
		timestamp: new Date().toISOString(),
		composite,
		queue,
		storage,
		index,
		provider,
		mutation,
		duplicate,
		connector,
		update,
		graph,
		openclaw,
	};
}
