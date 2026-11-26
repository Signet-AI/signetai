import { knowledgeTargetSql } from "./knowledge-graph-hygiene";
import { isPublicReadField } from "./public-read-response";
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
		typeof row.name === "string" &&
		typeof row.type === "string" &&
		(!scope || scope.organizationMode === false || !/__c\d+(?:_|$)/.test(row.name))
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
	if (!scope.inFlightUserId && scope.reach.kind === "all" && scope.compartments === "all" && scope.projects === null)
		return { sql: "", args: [] };
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
	 SELECT evidence_kind,evidence_id,agent_id FROM main.evidence_citations INDEXED BY sqlite_autoindex_evidence_citations_1 WHERE derived_kind=? AND derived_id=${key} AND agent_id=${alias}.agent_id
	 UNION
	 SELECT child.evidence_kind,child.evidence_id,child.agent_id FROM main.evidence_citations child INDEXED BY sqlite_autoindex_evidence_citations_1 JOIN cited_evidence parent ON child.derived_kind=parent.kind AND child.derived_id=parent.id AND child.agent_id=parent.agent_id
	 )
	 SELECT 1 FROM cited_evidence citation WHERE CASE ${sources.map((source) => `WHEN citation.kind='${source.kind}' THEN NOT EXISTS(SELECT 1 FROM main.${source.table} ${source.alias} WHERE ${source.alias}.${source.key}=citation.id AND ${source.alias}.agent_id=citation.agent_id${source.scope.sql})`).join(" ")} ELSE 1 END
	 )`,
		args: [kind, ...sources.flatMap((source) => source.scope.args)],
	};
}

export function telemetrySnapshotReadScopeSql(alias: string, scope: ReadScope): { sql: string; args: unknown[] } {
	const targets = [
		{
			table: "memories",
			key: "id",
			id: "json_extract(CASE WHEN item.type='object' THEN item.value ELSE '{}' END,'$.id')",
			kinds: "'memory','vector','keyword','hybrid','traversal','ka_traversal','structured','temporal_window','graph'",
			owner: false,
		},
		{
			table: "entity_attributes",
			key: "id",
			id: "COALESCE(json_extract(CASE WHEN item.type='object' THEN item.value ELSE '{}' END,'$.source_id'),substr(json_extract(CASE WHEN item.type='object' THEN item.value ELSE '{}' END,'$.id'),16))",
			kinds: "'ontology_claim'",
			owner: false,
		},
		{
			table: "session_transcripts",
			key: "session_key",
			id: "COALESCE(json_extract(CASE WHEN item.type='object' THEN item.value ELSE '{}' END,'$.source_id'),json_extract(CASE WHEN item.type='object' THEN item.value ELSE '{}' END,'$.id'))",
			kinds: "'transcript'",
			owner: true,
		},
		{
			table: "session_summaries",
			key: "id",
			id: "COALESCE(json_extract(CASE WHEN item.type='object' THEN item.value ELSE '{}' END,'$.source_id'),json_extract(CASE WHEN item.type='object' THEN item.value ELSE '{}' END,'$.id'))",
			kinds: "'summary'",
			owner: false,
		},
		{
			table: "memory_artifacts",
			key: "source_path",
			id: "COALESCE(json_extract(CASE WHEN item.type='object' THEN item.value ELSE '{}' END,'$.source_path'),json_extract(CASE WHEN item.type='object' THEN item.value ELSE '{}' END,'$.source_id'))",
			kinds: "'artifact','source_chunk'",
			owner: true,
		},
	];
	const args: unknown[] = [];
	const checks = targets.map((target) => {
		const allowed = knowledgeTargetSql(target.table, "snapshot_target", scope);
		args.push(...allowed.args);
		return `WHEN json_extract(CASE WHEN item.type='object' THEN item.value ELSE '{}' END,'$.source') IN (${target.kinds}) THEN NOT EXISTS(SELECT 1 FROM main.${target.table} snapshot_target WHERE snapshot_target.${target.key}=${target.id}${target.owner ? ` AND snapshot_target.agent_id=${alias}.agent_id` : ""}${allowed.sql})`;
	});
	return {
		sql: ` AND length(CAST(${alias}.results_json AS BLOB))<=65536 AND json_valid(${alias}.results_json) AND json_type(CASE WHEN json_valid(${alias}.results_json) THEN ${alias}.results_json ELSE 'null' END)='array' AND json_array_length(CASE WHEN json_valid(${alias}.results_json) THEN ${alias}.results_json ELSE '[]' END)<=128 AND NOT EXISTS(SELECT 1 FROM json_each(CASE WHEN json_valid(${alias}.results_json) THEN ${alias}.results_json ELSE '[]' END) item WHERE item.type<>'object' OR CASE ${checks.join(" ")} ELSE 1 END)`,
		args,
	};
}

export function telemetryLabelReadScopeSql(alias: string, scope: ReadScope): { sql: string; args: unknown[] } {
	if (!/^[a-z_][a-z0-9_]*$/i.test(alias)) throw new Error("invalid_telemetry_identifier");
	const attributed = `EXISTS(SELECT 1 FROM evidence_citations telemetry_origin WHERE telemetry_origin.derived_kind='telemetry' AND telemetry_origin.agent_id=${alias}.agent_id AND telemetry_origin.derived_id=${alias}.id)`;
	if (scope.reach.kind !== "all")
		return { sql: ` AND (${alias}.compartment_id IS NOT NULL OR ${attributed})`, args: [] };
	if (scope.compartments === "all") return { sql: "", args: [] };
	return {
		sql: ` AND (${alias}.compartment_id IS NOT NULL OR ${attributed} OR NOT EXISTS(SELECT 1 FROM compartments unreadable${scope.compartments.length ? ` WHERE unreadable.id NOT IN (${scope.compartments.map(() => "?").join(",")})` : ""}))`,
		args: [...scope.compartments],
	};
}

async function diagnosticPredicate(table: string, columns: readonly DatabaseColumnInfo[], scope?: ReadScope) {
	if (!scope || scope.organizationMode === false) return { sql: "", args: [] };
	if (!(await import("./knowledge-graph-hygiene")).scopedKnowledgeTableSupported(table)) return null;
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
	const snapshot =
		table === "memory_search_telemetry" ? await telemetrySnapshotReadScopeSql("d", scope) : { sql: "", args: [] };
	return {
		sql: readable.sql + cited.sql + label.sql + snapshot.sql,
		args: [...readable.args, ...cited.args, ...label.args, ...snapshot.args],
	};
}

async function diagnosticCount(
	accessor: DiagnosticsAccessor | undefined,
	table: string,
	predicate: { sql: string; args: unknown[] } | null,
	scope?: ReadScope,
): Promise<number | null> {
	if (!predicate) return null;
	const rawStatement = {
		sql: `SELECT COUNT(*) AS count FROM ${quoteIdentifier(table)} d`,
		params: [],
	};
	const statement =
		scope && scope.organizationMode !== false
			? (await import("./knowledge-graph-hygiene")).scopedKnowledgeStatement(rawStatement, scope)
			: rawStatement;
	const rows = await databaseDiagnosticRows(accessor, statement.sql + ` WHERE 1=1${predicate.sql}`, [
		...statement.params,
		...predicate.args,
	]);
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
		const predicate = await diagnosticPredicate(row.name, columns, scope);
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
			rowCount: scope && sampleBlockedReason(row) ? null : await diagnosticCount(accessor, row.name, predicate, scope),
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
	const predicate = await diagnosticPredicate(table, columns, scope);
	const blocked = sampleBlockedReason(match) ?? (predicate ? undefined : "table has no content read scope");
	if (blocked || !predicate) return { error: `sample unavailable: ${blocked}`, status: 400 };
	const publicColumns =
		scope?.organizationMode === false
			? columns
			: columns.filter(
					(column) =>
						isPublicReadField(column.name) &&
						!column.name.endsWith("_json") &&
						(column.name === "agent_id" || !/_(?:id|ids|key|path)$/.test(column.name)) &&
						!["payload", "result", "proposal_evidence", "evidence", "evidence_meta"].includes(column.name) &&
						!(column.name === "id" && /INT/i.test(column.type)) &&
						![
							"idx",
							"sequence",
							"head_revision",
							"head_base_revision",
							"revision",
							"focal_entity_names",
							"surfaced_constraint_count",
							"traversal_memory_count",
						].includes(column.name),
				);
	if (publicColumns.length === 0) return { error: "sample unavailable: no public columns", status: 400 };
	const identifier = /^[a-z_][a-z0-9_]*$/i.test(table) ? table : quoteIdentifier(table);
	const rawStatement = {
		sql: `SELECT ${publicColumns.map((column) => `CASE WHEN typeof(d.${quoteIdentifier(column.name)})='blob' THEN '[blob '||length(d.${quoteIdentifier(column.name)})||' bytes]' ELSE d.${quoteIdentifier(column.name)} END AS ${quoteIdentifier(column.name)}`).join(",")} FROM ${identifier} d`,
		params: [],
	};
	const statement =
		scope && scope.organizationMode !== false
			? (await import("./knowledge-graph-hygiene")).scopedKnowledgeStatement(rawStatement, scope)
			: rawStatement;
	const rows = await databaseDiagnosticRows(
		accessor,
		statement.sql +
			` WHERE 1=1${predicate.sql} ORDER BY ${[...publicColumns.filter((column) => column.primaryKey), ...publicColumns.filter((column) => !column.primaryKey)].map((column) => `d.${quoteIdentifier(column.name)}`).join(",")} LIMIT ? OFFSET ?`,
		[...statement.params, ...predicate.args, limit + 1, offset],
	);
	return {
		table,
		columns: publicColumns.map((col) => col.name),
		rows: rows.slice(0, limit).map(serializeRow),
		limit,
		offset,
		rowCount: await diagnosticCount(accessor, table, predicate, scope),
		hasMore: rows.length > limit,
	};
}

const telemetryRowsSchema = z.array(
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
);

async function searchTelemetryStatement(
	query: import("./memory-search-telemetry").MemorySearchTelemetryQuery,
	cursor?: import("./memory-search-telemetry").MemorySearchTelemetryCursor,
) {
	const scope = query.scope;
	if (!scope) throw new Error("telemetry_read_scope_required");
	const readable = readScopeSql("t", scope, { visibility: null, memory: null, session: "session_key", source: null });
	const copied = citedEvidenceReadScopeSql("t", scope, "telemetry");
	const label = telemetryLabelReadScopeSql("t", scope);
	const snapshot = await telemetrySnapshotReadScopeSql("t", scope);
	const { knowledgeTargetSql } = await import("./knowledge-graph-hygiene");
	const session = knowledgeTargetSql("session_transcripts", "telemetry_session", scope);
	const sessionSql = `CASE WHEN EXISTS(SELECT 1 FROM main.session_transcripts telemetry_session WHERE telemetry_session.session_key=t.session_key AND telemetry_session.agent_id=t.agent_id${session.sql}) THEN t.session_key ELSE NULL END`;
	let sql = `SELECT t.id,t.created_at,t.route,t.agent_id,${sessionSql} AS session_key,t.project,t.query,t.keyword_query,t.filters_json,t.method,t.result_count,t.top_score,t.no_hits,t.duration_ms,t.timings_json,(SELECT json_group_array(json(json_remove(item.value,'$.source_id','$.session_id','$.source_path'))) FROM json_each(CASE WHEN json_valid(t.results_json) THEN t.results_json ELSE '[]' END) item) AS results_json,NULL AS sources_json FROM memory_search_telemetry t WHERE 1=1${readable.sql}${copied.sql}${label.sql}${snapshot.sql}`;
	const args = [...session.args, ...readable.args, ...copied.args, ...label.args, ...snapshot.args];
	for (const [column, value, operator] of [
		["agent_id", query.agentId, "="],
		["session_key", query.sessionKey, "="],
		["project", query.project, "="],
		["route", query.route, "="],
		["created_at", query.since, ">="],
		["created_at", query.until, "<="],
	] as const) {
		if (value !== undefined) {
			sql += column === "session_key" ? ` AND (${sessionSql}) ${operator} ?` : ` AND t.${column} ${operator} ?`;
			if (column === "session_key") args.push(...session.args);
			args.push(value);
		}
	}
	if (query.noHits !== undefined) {
		sql += " AND t.no_hits=?";
		args.push(query.noHits ? 1 : 0);
	}

	if (cursor) {
		sql += " AND (t.created_at < ? OR (t.created_at = ? AND t.id > ?))";
		args.push(cursor.createdAt, cursor.createdAt, cursor.id);
	}
	return { sql, args };
}

export async function readScopedSearchTelemetry(
	query: import("./memory-search-telemetry").MemorySearchTelemetryQuery,
	accessor?: DiagnosticsAccessor,
): Promise<readonly import("./memory-search-telemetry").MemorySearchTelemetryRow[]> {
	if (!accessor || !("prepare" in accessor)) return dbOwnerSearchTelemetry(query, accessor);
	const statement = await searchTelemetryStatement(query);
	return telemetryRowsSchema.parse(
		accessor
			.prepare(statement.sql + " ORDER BY t.created_at DESC,t.id ASC LIMIT ? OFFSET ?")
			.all(...statement.args, query.limit ?? 100, query.offset ?? 0),
	);
}

export const SEARCH_TELEMETRY_EXPORT_BYTES = 4 * 1024 * 1024;

export async function readSearchTelemetryExportPage(
	query: import("./memory-search-telemetry").MemorySearchTelemetryQuery,
	cursor?: import("./memory-search-telemetry").MemorySearchTelemetryCursor,
	accessor?: DiagnosticsAccessor,
): Promise<import("./memory-search-telemetry").MemorySearchTelemetryExportPage> {
	if (!accessor || !("prepare" in accessor))
		return (await import("./db-owner-runtime")).dbOwnerSearchTelemetryExportPage(query, cursor, accessor);
	const statement = await searchTelemetryStatement(query, cursor);
	const columns = [
		"id",
		"created_at",
		"route",
		"agent_id",
		"session_key",
		"project",
		"query",
		"keyword_query",
		"filters_json",
		"method",
		"result_count",
		"top_score",
		"no_hits",
		"duration_ms",
		"timings_json",
		"results_json",
		"sources_json",
	];
	const rawBytes = columns.map((column) => `COALESCE(length(CAST(${column} AS BLOB)),0)`).join("+");
	const object = `json_object(${columns.map((column) => `'${column}',${column}`).join(",")})`;
	const limit = query.limit === undefined ? 33 : Math.min(33, Math.max(1, query.limit));
	const budget = SEARCH_TELEMETRY_EXPORT_BYTES - 16384;
	const result = z
		.object({ rows_json: z.string(), has_more: z.number(), oversized: z.number() })
		.parse(
			accessor
				.prepare(
					`WITH candidates AS (${statement.sql} ORDER BY t.created_at DESC,t.id ASC LIMIT ?), encoded AS (SELECT id,created_at,CASE WHEN (${rawBytes})>? THEN NULL ELSE ${object} END AS row_json FROM candidates), measured AS (SELECT id,created_at,CASE WHEN length(CAST(row_json AS BLOB))<=? THEN row_json ELSE NULL END AS row_json FROM encoded), budgeted AS (SELECT row_json,ROW_NUMBER() OVER(ORDER BY created_at DESC,id ASC) AS position,SUM(COALESCE(length(CAST(row_json AS BLOB)),?)+1) OVER(ORDER BY created_at DESC,id ASC ROWS UNBOUNDED PRECEDING) AS running_bytes FROM measured) SELECT COALESCE(json_group_array(json(row_json)) FILTER(WHERE running_bytes<=? AND position<=32),'[]') AS rows_json,CASE WHEN COUNT(*)>COUNT(*) FILTER(WHERE running_bytes<=? AND position<=32) THEN 1 ELSE 0 END AS has_more,COALESCE(MAX(CASE WHEN position=1 AND row_json IS NULL THEN 1 ELSE 0 END),0) AS oversized FROM budgeted`,
				)
				.get(...statement.args, limit, budget, budget, budget + 1, budget, budget),
		);
	return {
		rows: telemetryRowsSchema.parse(JSON.parse(result.rows_json)),
		hasMore: result.has_more === 1,
		oversized: result.oversized === 1,
	};
}

export async function scopedCheckpointStatement(
	scope: ReadScope,
	query: { project?: string; sessionKey?: string; limit: number },
) {
	const { knowledgeTargetSql } = await import("./knowledge-graph-hygiene");
	const readable = readScopeSql("c", scope, { visibility: null, checkpoint: true, project: "project_normalized" });
	const session = knowledgeTargetSql("session_transcripts", "checkpoint_session", scope);
	const entity = knowledgeTargetSql("entities", "checkpoint_entity", scope);
	const aspect = knowledgeTargetSql("entity_aspects", "checkpoint_aspect", scope);
	const sessionSql = `CASE WHEN EXISTS(SELECT 1 FROM main.session_transcripts checkpoint_session WHERE checkpoint_session.session_key=c.session_key AND (c.agent_id IS NULL OR checkpoint_session.agent_id=c.agent_id)${session.sql}) THEN c.session_key ELSE NULL END`;
	const arraySql = (column: string, table: string, alias: string, value: string, predicate: string) =>
		`(SELECT json_group_array(${value}) FROM json_each(CASE WHEN json_valid(c.${column}) AND length(CAST(c.${column} AS BLOB))<=65536 THEN c.${column} ELSE '[]' END) reference JOIN main.${table} ${alias} ON ${alias}.id=reference.value WHERE reference.type='text'${predicate})`;
	const projections = [
		"c.id",
		`${sessionSql} AS session_key`,
		"c.harness",
		"c.project",
		"c.project_normalized",
		"c.trigger",
		"c.digest",
		"c.prompt_count",
		"c.memory_queries",
		"c.recent_remembers",
		`${arraySql("focal_entity_ids", "entities", "checkpoint_entity", "checkpoint_entity.id", entity.sql)} AS focal_entity_ids`,
		`${arraySql("focal_entity_ids", "entities", "checkpoint_entity", "checkpoint_entity.name", entity.sql)} AS focal_entity_names`,
		`${arraySql("active_aspect_ids", "entity_aspects", "checkpoint_aspect", "checkpoint_aspect.id", aspect.sql)} AS active_aspect_ids`,
		"NULL AS surfaced_constraint_count",
		"NULL AS traversal_memory_count",
		"c.created_at",
	];
	const filter = query.project !== undefined ? "c.project_normalized=?" : "c.session_key=?";
	return {
		sql: `WITH public_checkpoints AS (SELECT ${projections.join(",")} FROM session_checkpoints c WHERE 1=1${readable.sql}) SELECT id,session_key,harness,project,project_normalized,trigger,digest,prompt_count,memory_queries,recent_remembers,focal_entity_ids,focal_entity_names,active_aspect_ids,surfaced_constraint_count,traversal_memory_count,created_at FROM public_checkpoints c WHERE ${filter} ORDER BY c.created_at DESC,c.id DESC LIMIT ?`,
		params: z
			.array(z.union([z.string(), z.number()]))
			.parse([
				...session.args,
				...entity.args,
				...entity.args,
				...aspect.args,
				...readable.args,
				query.project ?? query.sessionKey,
				query.limit,
			]),
		result: "all",
	} as const;
}

export async function readScopedCheckpoints(
	scope: ReadScope,
	query: { project?: string; sessionKey?: string; limit: number },
): Promise<readonly import("./session-checkpoints").CheckpointReadRow[]> {
	return dbOwnerQuery(await scopedCheckpointStatement(scope, query), {
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
