import { z } from "zod";
import type { DbAccessor } from "./db-accessor";

import { dbOwnerDiagnosticSchema, dbOwnerDiagnosticSample, dbOwnerSearchTelemetry } from "./db-owner-runtime";
import { dbOwnerQuery, DB_OWNER_READ_DEADLINE_MS } from "./db-owner-runtime";
import { readScopeSql, type ReadScope } from "./read-scope";
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

export type DatabaseSchemaGroup = "core" | "provenance" | "runtime" | "internal" | "other";

export interface DatabaseColumnInfo {
	readonly cid: number;
	readonly name: string;
	readonly type: string;
	readonly notNull: boolean;
	readonly defaultValue: unknown;
	readonly primaryKey: boolean;
}

export interface DatabaseIndexColumnInfo {
	readonly seqno: number;
	readonly cid: number;
	readonly name: string;
}

export interface DatabaseIndexInfo {
	readonly name: string;
	readonly unique: boolean;
	readonly origin: string;
	readonly partial: boolean;
	readonly columns: readonly DatabaseIndexColumnInfo[];
}

export interface DatabaseForeignKeyInfo {
	readonly id: number;
	readonly seq: number;
	readonly table: string;
	readonly from: string;
	readonly to: string;
	readonly onUpdate: string;
	readonly onDelete: string;
	readonly match: string;
}

export interface DatabaseTableInfo {
	readonly name: string;
	readonly group: DatabaseSchemaGroup;
	readonly kind: string;
	readonly rowCount: number | null;
	readonly sampleAllowed: boolean;
	readonly sampleBlockedReason?: string;
	readonly columns: readonly DatabaseColumnInfo[];
	readonly indexes: readonly DatabaseIndexInfo[];
	readonly foreignKeys: readonly DatabaseForeignKeyInfo[];
	readonly sql: string | null;
}

export interface DatabaseSchemaResponse {
	readonly generatedAt: string;
	readonly tables: readonly DatabaseTableInfo[];
	readonly groups: Record<DatabaseSchemaGroup, number>;
}

export interface DatabaseTableSampleResponse {
	readonly table: string;
	readonly columns: readonly string[];
	readonly rows: readonly Record<string, unknown>[];
	readonly limit: number;
	readonly offset: number;
	readonly rowCount: number | null;
	readonly hasMore: boolean;
}

const KNOWN_GROUPS: Readonly<Record<string, DatabaseSchemaGroup>> = {
	entities: "core",
	memories: "core",
	memory_entity_mentions: "core",
	relations: "core",
	entity_aspects: "core",
	entity_attributes: "core",
	entity_dependencies: "core",
	entity_dependency_history: "core",
	entity_communities: "core",
	ontology_proposals: "core",
	documents: "provenance",
	document_memories: "provenance",
	memory_artifacts: "provenance",
	memory_artifact_chunks: "provenance",
	conversations: "provenance",
	session_transcripts: "provenance",
	session_summaries: "provenance",
	session_summary_memories: "provenance",
	embeddings: "runtime",
	vec_embeddings: "internal",
	memory_hints: "runtime",
	session_memories: "runtime",
	session_scores: "runtime",
	umap_cache: "runtime",
	predictor_training_runs: "runtime",
	path_feedback_events: "runtime",
	path_feedback_stats: "runtime",
	session_checkpoints: "runtime",
	memories_cold: "runtime",
	schema_migrations: "runtime",
	schema_migrations_audit: "runtime",
	memory_jobs: "runtime",
	summary_jobs: "other",
	telemetry_events: "runtime",
	connectors: "runtime",
	connector_documents: "runtime",
	skill_meta: "runtime",
	skill_invocations: "runtime",
	daily_reflections: "runtime",
	entities_fts: "internal",
	memories_fts: "internal",
	memory_hints_fts: "internal",
};

const UNSAMPLED_TABLES = new Set(["vec_embeddings", "entities_fts", "memories_fts", "memory_hints_fts"]);

function quoteIdentifier(name: string): string {
	return `"${name.replaceAll('"', '""')}"`;
}

function groupForTable(name: string): DatabaseSchemaGroup {
	const known = KNOWN_GROUPS[name];
	if (known) return known;
	if (name.includes("_fts") || name.startsWith("fts_") || name.startsWith("vec_")) return "internal";
	if (name.includes("job") || name.includes("telemetry") || name.includes("cache")) return "runtime";
	if (name.includes("session") || name.includes("document") || name.includes("artifact")) return "provenance";
	return "other";
}

function isVirtualTable(sql: string | null): boolean {
	return typeof sql === "string" && /\bCREATE\s+VIRTUAL\s+TABLE\b/i.test(sql);
}

function sampleBlockedReason(row: SqliteMasterRow): string | undefined {
	if (UNSAMPLED_TABLES.has(row.name)) return "internal index table";
	if (isVirtualTable(row.sql)) return "virtual table";
	return undefined;
}

function serializeCell(value: unknown): unknown {
	if (value instanceof Uint8Array) return `[blob ${value.byteLength} bytes]`;
	if (typeof value === "bigint") return value.toString();
	return value;
}

function serializeRow(row: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, serializeCell(value)]));
}

interface SqliteMasterRow {
	readonly name: string;
	readonly type: string;
	readonly sql: string | null;
}

type DiagnosticsAccessor = DbAccessor | ReadDb;
type DiagnosticRow = Record<string, unknown>;

async function databaseDiagnosticRows(
	accessor: DiagnosticsAccessor | undefined,
	sql: string,
	params: readonly unknown[] = [],
): Promise<DiagnosticRow[]> {
	if (!accessor || !("prepare" in accessor)) throw new Error("diagnostics_requires_owner");
	return z.array(z.record(z.string(), z.unknown())).parse(accessor.prepare(sql).all(...params));
}

async function diagnosticTables(
	accessor: DiagnosticsAccessor | undefined,
	scope?: ReadScope,
): Promise<SqliteMasterRow[]> {
	const rows = await databaseDiagnosticRows(
		accessor,
		`SELECT name,type,sql FROM sqlite_master
	 WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%'
	 AND name NOT LIKE '%_fts_data' AND name NOT LIKE '%_fts_idx'
	 AND name NOT LIKE '%_fts_docsize' AND name NOT LIKE '%_fts_config' ORDER BY name`,
	);
	return rows.flatMap((row) =>
		typeof row.name === "string" && typeof row.type === "string" && (!scope || !/__c\d+(?:_|$)/.test(row.name))
			? [{ name: row.name, type: row.type, sql: typeof row.sql === "string" ? row.sql : null }]
			: [],
	);
}

async function diagnosticColumns(
	accessor: DiagnosticsAccessor | undefined,
	table: string,
): Promise<DatabaseColumnInfo[]> {
	const rows = await databaseDiagnosticRows(accessor, `PRAGMA table_info(${quoteIdentifier(table)})`);
	return rows.map((row) => ({
		cid: typeof row.cid === "number" ? row.cid : 0,
		name: typeof row.name === "string" ? row.name : "",
		type: typeof row.type === "string" ? row.type : "",
		notNull: typeof row.notnull === "number" && row.notnull > 0,
		defaultValue: row.dflt_value ?? null,
		primaryKey: typeof row.pk === "number" && row.pk > 0,
	}));
}

const DIAGNOSTIC_DERIVED_KINDS: Readonly<Record<string, string>> = {
	memories: "memory",
	entities: "entity",
	entity_aspects: "aspect",
	entity_attributes: "attribute",
	entity_dependencies: "dependency",
	epistemic_assertions: "assertion",
	memory_head_entries: "head_entry",
	daily_reflections: "reflection",
	ontology_contradictions: "contradiction",
	memory_head_revision_entries: "head_revision",
	ontology_proposals: "proposal",
	memory_search_telemetry: "telemetry",
};
const DIAGNOSTIC_EVIDENCE_TABLES = new Set([
	"memories",
	"memory_artifacts",
	"session_transcripts",
	"session_summaries",
	"session_checkpoints",
	"documents",
]);

export function citedEvidenceReadScopeSql(
	alias: string,
	scope: ReadScope,
	kind: string,
	keys: readonly string[] = ["id"],
): { sql: string; args: unknown[] } {
	if (!scope.inFlightUserId) return { sql: "", args: [] };
	if (![alias, ...keys].every((value) => /^[a-z_][a-z0-9_]*$/i.test(value)) || keys.length === 0)
		throw new Error("invalid_citation_identifier");
	const key =
		keys.length === 1 ? `${alias}.${keys[0]}` : `json_array(${keys.map((column) => `${alias}.${column}`).join(",")})`;
	const noProject = { ...scope, projects: scope.projects === null ? null : [] };
	const sources = [
		{ kind: "memory", table: "memories", alias: "cited_memory", key: "id", scope: readScopeSql("cited_memory", scope) },
		{
			kind: "transcript",
			table: "session_transcripts",
			alias: "cited_transcript",
			key: "session_key",
			scope: readScopeSql("cited_transcript", scope, {
				visibility: null,
				memory: null,
				session: "session_key",
				source: "source_id",
			}),
		},
		{
			kind: "artifact",
			table: "memory_artifacts",
			alias: "cited_artifact",
			key: "source_path",
			scope: readScopeSql("cited_artifact", scope, {
				visibility: null,
				memory: null,
				session: "session_key",
				source: "source_id",
			}),
		},
		{
			kind: "summary",
			table: "session_summaries",
			alias: "cited_summary",
			key: "id",
			scope: readScopeSql("cited_summary", scope, {
				visibility: null,
				memory: null,
				session: "session_key",
				source: null,
			}),
		},
		{
			kind: "attribute",
			table: "entity_attributes",
			alias: "cited_attribute",
			key: "id",
			scope: readScopeSql("cited_attribute", noProject, {
				visibility: null,
				memory: null,
				session: null,
				source: "source_id",
			}),
		},
	];
	return {
		sql: ` AND NOT EXISTS (
	 WITH RECURSIVE cited_evidence(kind,id,agent_id) AS (
	 SELECT evidence_kind,evidence_id,agent_id FROM evidence_citations INDEXED BY sqlite_autoindex_evidence_citations_1 WHERE derived_kind=? AND derived_id=${key} AND agent_id=${alias}.agent_id
	 UNION
	 SELECT child.evidence_kind,child.evidence_id,child.agent_id FROM evidence_citations child INDEXED BY sqlite_autoindex_evidence_citations_1 JOIN cited_evidence parent ON child.derived_kind=parent.kind AND child.derived_id=parent.id AND child.agent_id=parent.agent_id
	 )
	 SELECT 1 FROM cited_evidence citation WHERE CASE ${sources.map((source) => `WHEN citation.kind='${source.kind}' THEN NOT EXISTS(SELECT 1 FROM ${source.table} ${source.alias} WHERE ${source.alias}.${source.key}=citation.id AND ${source.alias}.agent_id=citation.agent_id${source.scope.sql})`).join(" ")} ELSE 1 END
	 )`,
		args: [kind, ...sources.flatMap((source) => source.scope.args)],
	};
}

export function telemetryLabelReadScopeSql(alias: string, scope: ReadScope): { sql: string; args: unknown[] } {
	if (!/^[a-z_][a-z0-9_]*$/i.test(alias)) throw new Error("invalid_telemetry_identifier");
	if (scope.reach.kind !== "all") return { sql: ` AND ${alias}.compartment_id IS NOT NULL`, args: [] };
	if (scope.compartments === "all") return { sql: "", args: [] };
	return {
		sql: ` AND (${alias}.compartment_id IS NOT NULL OR NOT EXISTS(SELECT 1 FROM compartments unreadable${scope.compartments.length ? ` WHERE unreadable.id NOT IN (${scope.compartments.map(() => "?").join(",")})` : ""}))`,
		args: [...scope.compartments],
	};
}

function diagnosticPredicate(table: string, columns: readonly DatabaseColumnInfo[], scope?: ReadScope) {
	if (!scope) return { sql: "", args: [] };
	const names = new Set(columns.map((column) => column.name));
	if (!names.has("agent_id") || !names.has("compartment_id")) return null;
	const kind = DIAGNOSTIC_DERIVED_KINDS[table];
	if (scope.inFlightUserId && !kind && !DIAGNOSTIC_EVIDENCE_TABLES.has(table)) return null;
	const scoped = names.has("project") ? scope : { ...scope, projects: scope.projects === null ? null : [] };
	const readable = readScopeSql("d", scoped, {
		visibility: names.has("visibility") ? "visibility" : null,
		memory:
			table === "memories"
				? "id"
				: table === "embeddings" || table === "embeddings_staging"
					? "source_id"
					: names.has("memory_id")
						? "memory_id"
						: null,
		session: names.has("session_key") ? "session_key" : names.has("source_id") ? "source_id" : null,
		source: names.has("source_id") ? "source_id" : null,
		checkpoint: table === "session_checkpoints",
	});
	const cited = kind
		? citedEvidenceReadScopeSql(
				"d",
				scope,
				kind,
				table === "memory_head_revision_entries" ? ["revision", "entry_id"] : names.has("id") ? ["id"] : ["entry_id"],
			)
		: { sql: "", args: [] };
	const label =
		table === "memory_search_telemetry" || table === "session_recall_events"
			? telemetryLabelReadScopeSql("d", scope)
			: { sql: "", args: [] };
	return { sql: readable.sql + cited.sql + label.sql, args: [...readable.args, ...cited.args, ...label.args] };
}

async function diagnosticCount(
	accessor: DiagnosticsAccessor | undefined,
	table: string,
	predicate: { sql: string; args: unknown[] } | null,
): Promise<number | null> {
	if (!predicate) return null;
	const rows = await databaseDiagnosticRows(
		accessor,
		`SELECT COUNT(*) AS count FROM ${quoteIdentifier(table)} d WHERE 1=1${predicate.sql}`,
		predicate.args,
	);
	return typeof rows[0]?.count === "number" ? rows[0].count : null;
}

export async function readDatabaseSchemaAsync(
	accessor?: DiagnosticsAccessor,
	scope?: ReadScope,
): Promise<DatabaseSchemaResponse> {
	if (!accessor || !("prepare" in accessor)) return dbOwnerDiagnosticSchema(scope, accessor);
	const tables: DatabaseTableInfo[] = [];
	for (const row of await diagnosticTables(accessor, scope)) {
		const columns = await diagnosticColumns(accessor, row.name);
		const predicate = diagnosticPredicate(row.name, columns, scope);
		const blocked = sampleBlockedReason(row) ?? (predicate ? undefined : "table has no content read scope");
		const indexes: DatabaseIndexInfo[] = [];
		for (const index of await databaseDiagnosticRows(accessor, `PRAGMA index_list(${quoteIdentifier(row.name)})`)) {
			const name = typeof index.name === "string" ? index.name : "";
			const indexColumns = name
				? await databaseDiagnosticRows(accessor, `PRAGMA index_info(${quoteIdentifier(name)})`)
				: [];
			indexes.push({
				name,
				unique: typeof index.unique === "number" && index.unique > 0,
				origin: typeof index.origin === "string" ? index.origin : "",
				partial: typeof index.partial === "number" && index.partial > 0,
				columns: indexColumns.map((col) => ({
					seqno: typeof col.seqno === "number" ? col.seqno : 0,
					cid: typeof col.cid === "number" ? col.cid : -1,
					name: typeof col.name === "string" ? col.name : "",
				})),
			});
		}
		const foreignKeys = (
			await databaseDiagnosticRows(accessor, `PRAGMA foreign_key_list(${quoteIdentifier(row.name)})`)
		).map((key) => ({
			id: typeof key.id === "number" ? key.id : 0,
			seq: typeof key.seq === "number" ? key.seq : 0,
			table: typeof key.table === "string" ? key.table : "",
			from: typeof key.from === "string" ? key.from : "",
			to: typeof key.to === "string" ? key.to : "",
			onUpdate: typeof key.on_update === "string" ? key.on_update : "",
			onDelete: typeof key.on_delete === "string" ? key.on_delete : "",
			match: typeof key.match === "string" ? key.match : "",
		}));
		tables.push({
			name: row.name,
			group: groupForTable(row.name),
			kind: row.type,
			rowCount: scope && sampleBlockedReason(row) ? null : await diagnosticCount(accessor, row.name, predicate),
			sampleAllowed: !blocked,
			...(blocked ? { sampleBlockedReason: blocked } : {}),
			columns,
			indexes,
			foreignKeys,
			sql: row.sql,
		});
	}
	const groups = { core: 0, provenance: 0, runtime: 0, internal: 0, other: 0 };
	for (const table of tables) groups[table.group] += 1;
	return { generatedAt: new Date().toISOString(), tables, groups };
}

export async function readTableSampleAsync(
	accessor: DiagnosticsAccessor | undefined,
	table: string,
	limit: number,
	offset: number,
	scope?: ReadScope,
): Promise<DatabaseTableSampleResponse | { readonly error: string; readonly status: 400 | 404 }> {
	if (!accessor || !("prepare" in accessor)) return dbOwnerDiagnosticSample(table, limit, offset, scope, accessor);
	const match = (await diagnosticTables(accessor, scope)).find((row) => row.name === table);
	if (!match) return { error: "unknown table", status: 404 };
	const columns = await diagnosticColumns(accessor, table);
	const predicate = diagnosticPredicate(table, columns, scope);
	const blocked = sampleBlockedReason(match) ?? (predicate ? undefined : "table has no content read scope");
	if (blocked || !predicate) return { error: `sample unavailable: ${blocked}`, status: 400 };
	const rows = await databaseDiagnosticRows(
		accessor,
		`SELECT ${columns.map((column) => `CASE WHEN typeof(d.${quoteIdentifier(column.name)})='blob' THEN '[blob '||length(d.${quoteIdentifier(column.name)})||' bytes]' ELSE d.${quoteIdentifier(column.name)} END AS ${quoteIdentifier(column.name)}`).join(",")} FROM ${quoteIdentifier(table)} d WHERE 1=1${predicate.sql} ORDER BY ${[...columns.filter((column) => column.primaryKey), ...columns.filter((column) => !column.primaryKey)].map((column) => `d.${quoteIdentifier(column.name)}`).join(",")} LIMIT ? OFFSET ?`,
		[...predicate.args, limit + 1, offset],
	);
	return {
		table,
		columns: columns.map((col) => col.name),
		rows: rows.slice(0, limit).map(serializeRow),
		limit,
		offset,
		rowCount: await diagnosticCount(accessor, table, predicate),
		hasMore: rows.length > limit,
	};
}

export async function readScopedSearchTelemetry(
	query: import("./memory-search-telemetry").MemorySearchTelemetryQuery,
	accessor?: DiagnosticsAccessor,
): Promise<readonly import("./memory-search-telemetry").MemorySearchTelemetryRow[]> {
	if (!accessor || !("prepare" in accessor)) return dbOwnerSearchTelemetry(query, accessor);
	const scope = query.scope;
	if (!scope) throw new Error("telemetry_read_scope_required");
	const readable = readScopeSql("t", scope, { visibility: null, memory: null, session: "session_key", source: null });
	const copied = citedEvidenceReadScopeSql("t", scope, "telemetry");
	const label = telemetryLabelReadScopeSql("t", scope);
	let sql = `SELECT t.* FROM memory_search_telemetry t WHERE 1=1${readable.sql}${copied.sql}${label.sql}`;
	const args = [...readable.args, ...copied.args, ...label.args];
	for (const [column, value, operator] of [
		["agent_id", query.agentId, "="],
		["session_key", query.sessionKey, "="],
		["project", query.project, "="],
		["route", query.route, "="],
		["created_at", query.since, ">="],
		["created_at", query.until, "<="],
	] as const) {
		if (value !== undefined) {
			sql += ` AND t.${column} ${operator} ?`;
			args.push(value);
		}
	}
	if (query.noHits !== undefined) {
		sql += " AND t.no_hits=?";
		args.push(query.noHits ? 1 : 0);
	}
	sql += " ORDER BY t.created_at DESC,t.id ASC LIMIT ? OFFSET ?";
	args.push(query.limit ?? 100, query.offset ?? 0);
	return z
		.array(
			z.object({
				id: z.string(),
				created_at: z.string(),
				route: z.string(),
				agent_id: z.string(),
				session_key: z.string().nullable(),
				project: z.string().nullable(),
				query: z.string(),
				keyword_query: z.string().nullable(),
				filters_json: z.string(),
				method: z.string(),
				result_count: z.number(),
				top_score: z.number().nullable(),
				no_hits: z.number(),
				duration_ms: z.number(),
				timings_json: z.string(),
				results_json: z.string(),
				sources_json: z.string().nullable(),
			}),
		)
		.parse(accessor.prepare(sql).all(...args));
}

export function scopedCheckpointStatement(
	scope: ReadScope,
	query: { project?: string; sessionKey?: string; limit: number },
) {
	const readable = readScopeSql("c", scope, { visibility: null, checkpoint: true, project: "project_normalized" });
	const filter = query.project !== undefined ? " AND c.project_normalized=?" : " AND c.session_key=?";
	return {
		sql: `SELECT c.* FROM session_checkpoints c WHERE 1=1${readable.sql}${filter} ORDER BY c.created_at DESC,c.rowid DESC LIMIT ?`,
		params: z
			.array(z.union([z.string(), z.number()]))
			.parse([...readable.args, query.project ?? query.sessionKey, query.limit]),
		result: "all",
	} as const;
}

export async function readScopedCheckpoints(
	scope: ReadScope,
	query: { project?: string; sessionKey?: string; limit: number },
): Promise<readonly import("./session-checkpoints").CheckpointRow[]> {
	return dbOwnerQuery(scopedCheckpointStatement(scope, query), {
		operation: "telemetry.checkpoints.read",
		lane: "read",
		deadlineMs: DB_OWNER_READ_DEADLINE_MS,
	});
}

export function readLegacyContinuity(query: {
	project?: string;
	limit: number;
	latest?: boolean;
}): Promise<Record<string, unknown>[]> {
	const sql = query.latest
		? `SELECT project,score,created_at FROM session_scores WHERE id IN
		 (SELECT id FROM session_scores s2 WHERE s2.project=session_scores.project ORDER BY s2.created_at DESC LIMIT 1)
		 ORDER BY created_at DESC LIMIT ?`
		: `SELECT id,session_key,project,harness,score,memories_recalled,memories_used,novel_context_count,reasoning,created_at
		 FROM session_scores${query.project ? " WHERE project=?" : ""} ORDER BY created_at DESC LIMIT ?`;
	return dbOwnerQuery(
		{ sql, params: query.project && !query.latest ? [query.project, query.limit] : [query.limit], result: "all" },
		{ operation: "telemetry.continuity.read", lane: "read", deadlineMs: DB_OWNER_READ_DEADLINE_MS },
	);
}
