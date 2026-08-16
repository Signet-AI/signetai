import { createHash } from "node:crypto";
import type { SignetSourceEntry, SignetSourceKind } from "@signet/core";
import { dbOwnerBatch, dbOwnerQuery, ownerStatement } from "./db-owner-runtime";
import { logger } from "./logger";
import { getActiveTelemetry } from "./telemetry";

export const SOURCE_LIFECYCLE_EVENT = "source.lifecycle" as const;

export const SOURCE_CLASSES = ["transcript", "document", "repository", "note_vault", "browser", "other"] as const;
export type SourceClass = (typeof SOURCE_CLASSES)[number];

export const SOURCE_MODES = ["one_shot", "recurring"] as const;
export type SourceMode = (typeof SOURCE_MODES)[number];

export const SOURCE_FAILURE_CLASSES = [
	"configuration",
	"authentication",
	"authorization",
	"network",
	"rate_limited",
	"filesystem",
	"parse",
	"unsupported",
	"cancelled",
	"unknown",
] as const;
export type SourceFailureClass = (typeof SOURCE_FAILURE_CLASSES)[number];

export const SOURCE_OUTCOMES = ["success", "partial", "failed", "cancelled"] as const;
export type SourceOutcome = (typeof SOURCE_OUTCOMES)[number];

export const SOURCE_FRESHNESS_STATES = ["healthy", "stale", "unknown"] as const;
export type SourceFreshnessState = (typeof SOURCE_FRESHNESS_STATES)[number];

export const SOURCE_COUNT_BUCKETS = ["0", "1_10", "11_100", "101_1k", "1k_10k", "10k_plus"] as const;
export type SourceCountBucket = (typeof SOURCE_COUNT_BUCKETS)[number];

export const SOURCE_SIZE_BUCKETS = ["unknown", "lt_1mb", "1_10mb", "10_100mb", "100mb_1gb", "1gb_plus"] as const;
export type SourceSizeBucket = (typeof SOURCE_SIZE_BUCKETS)[number];

export const SOURCE_DURATION_BUCKETS = ["unknown", "lt_1s", "1_10s", "10_60s", "1_10m", "10_60m", "60m_plus"] as const;
export type SourceDurationBucket = (typeof SOURCE_DURATION_BUCKETS)[number];

export const SOURCE_LAG_BUCKETS = ["unknown", "lt_1h", "1_6h", "6_24h", "1_7d", "7d_plus"] as const;
export type SourceLagBucket = (typeof SOURCE_LAG_BUCKETS)[number];

type SourceLifecyclePhase = "connect" | "index" | "readiness" | "first_recall" | "freshness";

interface SourceLifecycleSource {
	readonly id: string;
	readonly kind: SignetSourceKind | string;
	readonly root?: string;
	readonly providerSettings?: Readonly<Record<string, unknown>>;
}

interface SourceLifecycleState {
	readonly sourceKey: string;
	readonly sourceClass: SourceClass;
	readonly mode: SourceMode;
	readonly connectedAt: string | null;
	readonly firstIndexedAt: string | null;
	readonly firstSearchableAt: string | null;
	readonly firstRecallAt: string | null;
	readonly lastSuccessAt: string | null;
	readonly lastFreshnessState: SourceFreshnessState | null;
	readonly lastFreshnessEventAt: string | null;
}

export interface SourceIndexTelemetryInput {
	readonly source: SourceLifecycleSource;
	readonly agentId: string;
	readonly mode?: SourceMode;
	readonly discovered: number;
	readonly accepted: number;
	readonly skipped?: number;
	readonly failed?: number;
	readonly durationMs: number;
	readonly outcome: SourceOutcome;
	readonly failureClass?: SourceFailureClass;
	readonly searchable?: boolean;
	readonly sourceBytes?: number;
	readonly updateFreshness?: boolean;
}

export interface SourceRecallTelemetryResult {
	readonly source?: string;
	readonly source_id?: string;
}

const MAX_COUNT = 1_000_000;
const MAX_RECALL_CLAIMS_PER_CALL = 20;
const FRESHNESS_EVENT_INTERVAL_MS = 60 * 60 * 1_000;
const CONNECTION_FAILURE_INTERVAL_MS = 5 * 60 * 1_000;
const recentConnectionFailures = new Map<SourceClass, number>();
const readinessClaimedInProcess = new Set<string>();
const pendingSourceLifecycleWrites = new Set<Promise<void>>();

/**
 * Track an intentional fire-and-forget lifecycle write. The async DB accessor
 * already bounds its write queue; this registry gives daemon shutdown a
 * bounded set of writes to drain before the database is closed.
 */
export function trackSourceLifecycleWrite(operation: Promise<void>): Promise<void> {
	let tracked: Promise<void>;
	tracked = operation.then(
		() => {
			pendingSourceLifecycleWrites.delete(tracked);
		},
		() => {
			pendingSourceLifecycleWrites.delete(tracked);
		},
	);
	pendingSourceLifecycleWrites.add(tracked);
	return tracked;
}

export async function flushPendingSourceLifecycleTelemetry(): Promise<void> {
	while (pendingSourceLifecycleWrites.size > 0) {
		await Promise.allSettled([...pendingSourceLifecycleWrites]);
	}
}

async function writeBatch(
	statements: readonly ReturnType<typeof ownerStatement>[],
	operation: string,
): Promise<readonly unknown[]> {
	return await dbOwnerBatch(statements, { operation, lane: "write", estimatedWorkUnits: statements.length });
}

function rethrowLifecycleFailure(operation: string, error: unknown): never {
	const failure = error instanceof Error ? error : new Error(String(error));
	logger.error("telemetry", `Source lifecycle ${operation} failed`, failure);
	throw failure;
}

function boundedCount(value: number): number {
	return Number.isFinite(value) ? Math.max(0, Math.min(MAX_COUNT, Math.floor(value))) : 0;
}

export function sourceClassForKind(kind: string): SourceClass {
	switch (kind.trim().toLowerCase()) {
		case "discord":
		case "codex":
		case "claude-code":
		case "transcript":
			return "transcript";
		case "github":
		case "repository":
			return "repository";
		case "obsidian":
		case "note_vault":
			return "note_vault";
		case "browser":
			return "browser";
		case "document":
			return "document";
		default:
			return "other";
	}
}

export function sourceModeFor(source: Pick<SourceLifecycleSource, "kind" | "providerSettings">): SourceMode {
	return source.providerSettings?.syncMode === "gateway-tail" ? "recurring" : "one_shot";
}

export function sourceCountBucket(value: number): SourceCountBucket {
	const count = boundedCount(value);
	if (count === 0) return "0";
	if (count <= 10) return "1_10";
	if (count <= 100) return "11_100";
	if (count <= 1_000) return "101_1k";
	if (count <= 10_000) return "1k_10k";
	return "10k_plus";
}

export function sourceSizeBucket(bytes: number | undefined): SourceSizeBucket {
	if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return "unknown";
	if (bytes < 1_000_000) return "lt_1mb";
	if (bytes < 10_000_000) return "1_10mb";
	if (bytes < 100_000_000) return "10_100mb";
	if (bytes < 1_000_000_000) return "100mb_1gb";
	return "1gb_plus";
}

export function sourceDurationBucket(durationMs: number): SourceDurationBucket {
	if (!Number.isFinite(durationMs) || durationMs < 0) return "unknown";
	const duration = durationMs;
	if (duration < 1_000) return "lt_1s";
	if (duration < 10_000) return "1_10s";
	if (duration < 60_000) return "10_60s";
	if (duration < 600_000) return "1_10m";
	if (duration < 3_600_000) return "10_60m";
	return "60m_plus";
}

export function sourceLagBucket(lagMs: number | null | undefined): SourceLagBucket {
	if (lagMs === null || lagMs === undefined || !Number.isFinite(lagMs) || lagMs < 0) return "unknown";
	if (lagMs < 3_600_000) return "lt_1h";
	if (lagMs < 21_600_000) return "1_6h";
	if (lagMs < 86_400_000) return "6_24h";
	if (lagMs < 604_800_000) return "1_7d";
	return "7d_plus";
}

export function sourceFailureClass(error: unknown): SourceFailureClass {
	const text =
		error instanceof Error
			? `${error.name} ${error.message}`
			: typeof error === "object" && error !== null && "message" in error
				? String((error as { readonly message?: unknown }).message ?? "")
				: String(error);
	const code =
		typeof error === "object" && error !== null && "code" in error
			? String((error as { readonly code?: unknown }).code ?? "")
			: "";
	if (/cancel|abort/i.test(text)) return "cancelled";
	if (/unsupported|unknown provider|no sync/i.test(text)) return "unsupported";
	if (
		/configuration|config(?:uration)?|required|must be provided|at least one .* (?:id|guild|repo|source)/i.test(text)
	) {
		return "configuration";
	}
	if (/EACCES|ENOENT|EISDIR/i.test(code) || /enoent|eacces|file|directory|path|vault/i.test(text)) return "filesystem";
	if (/403|permission|forbidden|not authorized|authorization/i.test(text)) return "authorization";
	if (/token|credential|secret|auth|401/i.test(text)) return "authentication";
	if (/429|rate limit|too many requests/i.test(text)) return "rate_limited";
	if (/json|parse|invalid|malformed|schema/i.test(text)) return "parse";
	if (/network|fetch|socket|timeout|dns|connect|gateway|http 5/i.test(text)) return "network";
	return "unknown";
}

function sourceKey(sourceIdentity: string): string {
	return createHash("sha256").update(sourceIdentity).digest("hex").slice(0, 32);
}

function sourceIdentity(source: SourceLifecycleSource): string {
	return source.id || `${source.kind}:${source.root ?? ""}`;
}

function emit(properties: Readonly<Record<string, string | number | boolean | null>>): void {
	getActiveTelemetry()?.record(SOURCE_LIFECYCLE_EVENT, properties);
}

function readState(row: Record<string, unknown> | null | undefined): SourceLifecycleState | null {
	if (!row) return null;
	return {
		sourceKey: String(row.source_key),
		sourceClass: sourceClassForKind(String(row.source_class)),
		mode: row.mode === "recurring" ? "recurring" : "one_shot",
		connectedAt: typeof row.connected_at === "string" ? row.connected_at : null,
		firstIndexedAt: typeof row.first_indexed_at === "string" ? row.first_indexed_at : null,
		firstSearchableAt: typeof row.first_searchable_at === "string" ? row.first_searchable_at : null,
		firstRecallAt: typeof row.first_recall_at === "string" ? row.first_recall_at : null,
		lastSuccessAt: typeof row.last_success_at === "string" ? row.last_success_at : null,
		lastFreshnessState:
			row.last_freshness_state === "healthy" ||
			row.last_freshness_state === "stale" ||
			row.last_freshness_state === "unknown"
				? row.last_freshness_state
				: null,
		lastFreshnessEventAt: typeof row.last_freshness_event_at === "string" ? row.last_freshness_event_at : null,
	};
}

async function readLifecycleState(agentId: string, key: string): Promise<SourceLifecycleState | null> {
	const row = await dbOwnerQuery<Record<string, unknown> | null>(
		ownerStatement(
			`SELECT source_key, source_class, mode, connected_at, first_indexed_at,
				first_searchable_at, first_recall_at, last_success_at,
				last_freshness_state, last_freshness_event_at
			 FROM source_lifecycle_state WHERE agent_id = ? AND source_key = ?`,
			[agentId, key],
			"get",
		),
		{ operation: "sources.lifecycle.state-read", lane: "read" },
	);
	return readState(row);
}

export async function recordSourceConnected(
	source: SignetSourceEntry,
	agentId: string,
	mode = sourceModeFor(source),
): Promise<void> {
	if (!getActiveTelemetry()?.enabled) return;
	const now = new Date().toISOString();
	const key = sourceKey(sourceIdentity(source));
	try {
		const results = await writeBatch(
			[
				ownerStatement(
					`INSERT OR IGNORE INTO source_lifecycle_state
					 (agent_id, source_key, source_class, mode, connected_at)
					 VALUES (?, ?, ?, ?, NULL)`,
					[agentId, key, sourceClassForKind(String(source.kind)), mode],
				),
				ownerStatement(
					`UPDATE source_lifecycle_state SET connected_at = ?, mode = ?
					 WHERE agent_id = ? AND source_key = ? AND connected_at IS NULL`,
					[now, mode, agentId, key],
				),
			],
			"sources.lifecycle.connected",
		);
		const claimed = Number((results[1] as { readonly changes?: number }).changes ?? 0) > 0;
		if (claimed)
			emit({ phase: "connect", outcome: "success", sourceClass: sourceClassForKind(String(source.kind)), mode });
	} catch (error) {
		rethrowLifecycleFailure("connected", error);
	}
}

export function recordSourceConnectionFailure(kind: string, error: unknown, mode: SourceMode = "one_shot"): void {
	const sourceClass = sourceClassForKind(kind);
	const now = Date.now();
	const previous = recentConnectionFailures.get(sourceClass) ?? 0;
	if (now - previous < CONNECTION_FAILURE_INTERVAL_MS) return;
	recentConnectionFailures.set(sourceClass, now);
	emit({
		phase: "connect",
		outcome: "failed",
		sourceClass,
		mode,
		failureClass: sourceFailureClass(error),
	});
}

async function sourceSizeBytes(source: SourceLifecycleSource, agentId: string): Promise<number | undefined> {
	const rootPrefix = `${(source.root ?? "").replace(/\\/g, "/").replace(/\/$/, "")}/`;
	const legacyObsidianClause =
		source.kind === "obsidian"
			? "OR (harness = 'obsidian' AND source_id IS NULL AND source_path >= ? AND source_path < ?)"
			: "";
	try {
		const row = await dbOwnerQuery<{ readonly bytes?: unknown } | null>(
			ownerStatement(
				`SELECT SUM(length(content)) AS bytes
				 FROM memory_artifacts
				 WHERE agent_id = ? AND (source_id = ? ${legacyObsidianClause})
				   AND COALESCE(is_deleted, 0) = 0`,
				[agentId, source.id, ...(source.kind === "obsidian" ? [rootPrefix, `${rootPrefix}\\uffff`] : [])],
				"get",
			),
			{ operation: "sources.lifecycle.size-read", lane: "read" },
		);
		return typeof row?.bytes === "number" && Number.isFinite(row.bytes) ? row.bytes : undefined;
	} catch (error) {
		rethrowLifecycleFailure("size-read", error);
	}
}

export async function sourceHasSearchableArtifacts(source: SignetSourceEntry, agentId: string): Promise<boolean> {
	if (!getActiveTelemetry()?.enabled) return false;
	const rootPrefix = `${source.root.replace(/\\/g, "/").replace(/\/$/, "")}/`;
	const legacyObsidianClause =
		source.kind === "obsidian"
			? "OR (harness = 'obsidian' AND source_id IS NULL AND source_path >= ? AND source_path < ?)"
			: "";
	try {
		const row = await dbOwnerQuery<Record<string, unknown> | null>(
			ownerStatement(
				`SELECT 1 AS n FROM memory_artifacts
				 WHERE agent_id = ? AND (source_id = ? ${legacyObsidianClause})
				   AND COALESCE(is_deleted, 0) = 0
				   AND COALESCE(source_kind, '') NOT LIKE 'source_%_failure'
				   AND COALESCE(source_kind, '') NOT LIKE 'source_%_checkpoint'
				 LIMIT 1`,
				[agentId, source.id, ...(source.kind === "obsidian" ? [rootPrefix, `${rootPrefix}\\uffff`] : [])],
				"get",
			),
			{ operation: "sources.lifecycle.searchable-read", lane: "read" },
		);
		return row != null;
	} catch (error) {
		rethrowLifecycleFailure("searchable-read", error);
	}
}

function freshnessEventNeeded(
	state: SourceLifecycleState | null,
	freshness: SourceFreshnessState,
	nowMs: number,
): boolean {
	if (!state || state.lastFreshnessState !== freshness || !state.lastFreshnessEventAt) return true;
	const last = Date.parse(state.lastFreshnessEventAt);
	return !Number.isFinite(last) || nowMs - last >= FRESHNESS_EVENT_INTERVAL_MS;
}

export async function recordSourceIndexOperation(input: SourceIndexTelemetryInput): Promise<void> {
	if (!getActiveTelemetry()?.enabled) return;
	const mode = input.mode ?? sourceModeFor(input.source);
	const now = new Date();
	const nowIso = now.toISOString();
	const sourceClass = sourceClassForKind(String(input.source.kind));
	const accepted = boundedCount(input.accepted);
	const discovered = boundedCount(input.discovered);
	const skipped = boundedCount(input.skipped ?? Math.max(0, discovered - accepted - boundedCount(input.failed ?? 0)));
	const failed = boundedCount(input.failed ?? 0);
	const bytes = input.sourceBytes ?? (await sourceSizeBytes(input.source, input.agentId));
	const searchable = input.searchable ?? (accepted > 0 || (bytes !== undefined && bytes > 0));
	const sizeBucket = sourceSizeBucket(bytes);
	let firstIndexed = false;
	let firstSearchable = false;
	let freshness: { readonly state: SourceFreshnessState; readonly lag: SourceLagBucket } | null = null;

	try {
		const key = sourceKey(sourceIdentity(input.source));
		const before = await readLifecycleState(input.agentId, key);
		if (accepted > 0 && !before?.firstIndexedAt) firstIndexed = true;
		if (searchable && !before?.firstSearchableAt) firstSearchable = true;
		const success = input.outcome === "success" && input.updateFreshness !== false;
		const nextSuccessAt = success ? nowIso : (before?.lastSuccessAt ?? null);
		const freshnessState: SourceFreshnessState = success ? "healthy" : before?.lastSuccessAt ? "stale" : "unknown";
		const lagMs = before?.lastSuccessAt ? now.getTime() - Date.parse(before.lastSuccessAt) : null;
		if (
			mode === "recurring" &&
			input.updateFreshness !== false &&
			freshnessEventNeeded(before, freshnessState, now.getTime())
		) {
			freshness = { state: freshnessState, lag: sourceLagBucket(success ? 0 : lagMs) };
		}
		await writeBatch(
			[
				ownerStatement(
					`INSERT OR IGNORE INTO source_lifecycle_state
					 (agent_id, source_key, source_class, mode, connected_at)
					 VALUES (?, ?, ?, ?, NULL)`,
					[input.agentId, key, sourceClass, mode],
				),
				ownerStatement(
					`UPDATE source_lifecycle_state SET
					 mode = ?,
					 first_indexed_at = CASE WHEN ? = 1 AND first_indexed_at IS NULL THEN ? ELSE first_indexed_at END,
					 first_searchable_at = CASE WHEN ? = 1 AND first_searchable_at IS NULL THEN ? ELSE first_searchable_at END,
					 last_success_at = ?,
					 last_freshness_state = CASE WHEN ? = 'recurring' THEN ? ELSE last_freshness_state END,
					 last_freshness_event_at = CASE WHEN ? = 1 THEN ? ELSE last_freshness_event_at END
					 WHERE agent_id = ? AND source_key = ?`,
					[
						mode,
						firstIndexed ? 1 : 0,
						nowIso,
						firstSearchable ? 1 : 0,
						nowIso,
						nextSuccessAt,
						mode,
						freshness?.state ?? before?.lastFreshnessState ?? null,
						freshness ? 1 : 0,
						freshness ? nowIso : null,
						input.agentId,
						key,
					],
				),
			],
			"sources.lifecycle.index",
		);
	} catch (error) {
		rethrowLifecycleFailure("index", error);
	}

	emit({
		phase: "index",
		outcome: input.outcome,
		sourceClass,
		mode,
		discovered,
		accepted,
		skipped,
		failed,
		countBucket: sourceCountBucket(discovered),
		sourceSizeBucket: sizeBucket,
		durationBucket: sourceDurationBucket(input.durationMs),
		...(input.failureClass ? { failureClass: input.failureClass } : {}),
	});
	if (firstIndexed) emit({ phase: "readiness", readiness: "indexed", outcome: "success", sourceClass, mode });
	if (firstSearchable) emit({ phase: "readiness", readiness: "searchable", outcome: "success", sourceClass, mode });
	const freshnessEvent = freshness as { readonly state: SourceFreshnessState; readonly lag: SourceLagBucket } | null;
	if (freshnessEvent)
		emit({
			phase: "freshness",
			freshness: freshnessEvent.state,
			lagBucket: freshnessEvent.lag,
			outcome: input.outcome,
			sourceClass,
			mode,
		});
}

function recallClass(result: SourceRecallTelemetryResult): SourceClass | null {
	const source = result.source ?? "";
	const sourceId = result.source_id ?? "";
	if (source === "source_obsidian" || sourceId.startsWith("obsidian:")) return "note_vault";
	if (sourceId.startsWith("github:")) return "repository";
	if (sourceId.startsWith("discord:") || sourceId.startsWith("discord-cache:")) return "transcript";
	if (source === "native_memory") return "transcript";
	return null;
}

function recallSourceIdCandidates(value: string): readonly string[] {
	const parts = value.split(":");
	const candidates: string[] = [];
	for (let index = 1; index <= Math.min(parts.length, 4); index++) {
		const candidate = parts.slice(0, index).join(":");
		if (candidate) candidates.push(candidate);
	}
	return candidates;
}

export async function recordFirstSourceRecall(
	agentId: string,
	results: readonly SourceRecallTelemetryResult[],
): Promise<void> {
	if (!getActiveTelemetry()?.enabled) return;
	const byClass = new Map<SourceClass, string[]>();
	const seenIds = new Set<string>();
	for (const result of results) {
		const klass = recallClass(result);
		if (!klass) continue;
		const ids = byClass.get(klass) ?? [];
		for (const sourceId of result.source_id ? recallSourceIdCandidates(result.source_id) : []) {
			if (seenIds.has(sourceId) || seenIds.size >= MAX_RECALL_CLAIMS_PER_CALL) continue;
			seenIds.add(sourceId);
			ids.push(sourceId);
		}
		byClass.set(klass, ids);
	}
	for (const [sourceClass, ids] of byClass) await claimFirstSourceRecall(agentId, sourceClass, ids);
}

/** Record a rate-limited checkpoint for a long-lived source stream. */
export async function recordSourceFreshness(source: SignetSourceEntry, agentId: string): Promise<void> {
	if (sourceModeFor(source) !== "recurring") return;
	const now = new Date();
	const nowIso = now.toISOString();
	let lag: SourceLagBucket = "unknown";
	let suppressed = false;
	try {
		const key = sourceKey(sourceIdentity(source));
		const state = await readLifecycleState(agentId, key);
		if (state?.lastFreshnessEventAt) {
			const lastEvent = Date.parse(state.lastFreshnessEventAt);
			if (Number.isFinite(lastEvent) && now.getTime() - lastEvent < FRESHNESS_EVENT_INTERVAL_MS) {
				suppressed = true;
			}
		}
		if (!suppressed) {
			const previous = state?.lastSuccessAt ? Date.parse(state.lastSuccessAt) : Number.NaN;
			lag = sourceLagBucket(Number.isFinite(previous) ? now.getTime() - previous : null);
			await writeBatch(
				[
					ownerStatement(
						`INSERT OR IGNORE INTO source_lifecycle_state
							 (agent_id, source_key, source_class, mode, connected_at)
							 VALUES (?, ?, ?, 'recurring', NULL)`,
						[agentId, key, sourceClassForKind(String(source.kind))],
					),
					ownerStatement(
						`UPDATE source_lifecycle_state
							 SET mode = 'recurring', last_success_at = ?, last_freshness_state = 'healthy', last_freshness_event_at = ?
							 WHERE agent_id = ? AND source_key = ?`,
						[nowIso, nowIso, agentId, key],
					),
				],
				"sources.lifecycle.freshness",
			);
		}
	} catch (error) {
		rethrowLifecycleFailure("freshness", error);
	}
	if (suppressed) return;
	emit({
		phase: "freshness",
		freshness: "healthy",
		lagBucket: lag,
		outcome: "success",
		sourceClass: sourceClassForKind(String(source.kind)),
		mode: "recurring",
	});
}

/** Claim readiness once a recurring source has produced its first item. */
export async function recordSourceReadiness(source: SignetSourceEntry, agentId: string): Promise<void> {
	const processKey = `${agentId}:${sourceKey(sourceIdentity(source))}`;
	if (readinessClaimedInProcess.has(processKey)) return;
	const now = new Date().toISOString();
	let firstIndexed = false;
	let firstSearchable = false;
	try {
		const key = sourceKey(sourceIdentity(source));
		const state = await readLifecycleState(agentId, key);
		if (state?.firstIndexedAt && state.firstSearchableAt) {
			readinessClaimedInProcess.add(processKey);
			return;
		}
		firstIndexed = !state?.firstIndexedAt;
		firstSearchable = !state?.firstSearchableAt;
		await writeBatch(
			[
				ownerStatement(
					`INSERT OR IGNORE INTO source_lifecycle_state
					 (agent_id, source_key, source_class, mode, connected_at)
					 VALUES (?, ?, ?, 'recurring', NULL)`,
					[agentId, key, sourceClassForKind(String(source.kind))],
				),
				ownerStatement(
					`UPDATE source_lifecycle_state SET
					 mode = 'recurring',
					 first_indexed_at = COALESCE(first_indexed_at, ?),
					 first_searchable_at = COALESCE(first_searchable_at, ?)
					 WHERE agent_id = ? AND source_key = ?`,
					[now, now, agentId, key],
				),
			],
			"sources.lifecycle.readiness",
		);
	} catch (error) {
		rethrowLifecycleFailure("readiness", error);
	}
	readinessClaimedInProcess.add(processKey);
	const sourceClass = sourceClassForKind(String(source.kind));
	if (firstIndexed)
		emit({ phase: "readiness", readiness: "indexed", outcome: "success", sourceClass, mode: "recurring" });
	if (firstSearchable)
		emit({ phase: "readiness", readiness: "searchable", outcome: "success", sourceClass, mode: "recurring" });
}

export async function removeSourceLifecycleState(source: SignetSourceEntry, agentId: string): Promise<void> {
	const processKey = `${agentId}:${sourceKey(sourceIdentity(source))}`;
	readinessClaimedInProcess.delete(processKey);
	try {
		await writeBatch(
			[
				ownerStatement("DELETE FROM source_lifecycle_state WHERE agent_id = ? AND source_key = ?", [
					agentId,
					sourceKey(sourceIdentity(source)),
				]),
			],
			"sources.lifecycle.remove",
		);
	} catch (error) {
		rethrowLifecycleFailure("remove", error);
	}
}

async function claimFirstSourceRecall(
	agentId: string,
	sourceClass: SourceClass,
	candidateIds: readonly string[],
): Promise<void> {
	try {
		const keys = candidateIds.map(sourceKey);
		if (keys.length === 0) return;
		const rows = await dbOwnerQuery<readonly Record<string, unknown>[]>(
			ownerStatement(
				`SELECT source_key, source_class, mode, connected_at, first_indexed_at, first_searchable_at,
					first_recall_at, last_success_at, last_freshness_state, last_freshness_event_at
				 FROM source_lifecycle_state
				 WHERE agent_id = ? AND source_class = ? AND first_searchable_at IS NOT NULL
					AND first_recall_at IS NULL AND source_key IN (${keys.map(() => "?").join(",")})
				 ORDER BY first_searchable_at ASC LIMIT 20`,
				[agentId, sourceClass, ...keys],
				"all",
			),
			{ operation: "sources.lifecycle.recall-read", lane: "read" },
		);
		const states = rows.map(readState).filter((state): state is SourceLifecycleState => state !== null);
		const claimedAt = new Date().toISOString();
		const results =
			states.length > 0
				? await writeBatch(
						states.map((state) =>
							ownerStatement(
								`UPDATE source_lifecycle_state SET first_recall_at = ?
								 WHERE agent_id = ? AND source_key = ? AND first_recall_at IS NULL`,
								[claimedAt, agentId, state.sourceKey],
							),
						),
						"sources.lifecycle.first-recall",
					)
				: [];
		const claimed = states.filter(
			(_, index) => Number((results[index] as { readonly changes?: number }).changes ?? 0) > 0,
		);
		for (const state of claimed) {
			const searchableAt = state.firstSearchableAt ? Date.parse(state.firstSearchableAt) : Number.NaN;
			emit({
				phase: "first_recall",
				outcome: "success",
				sourceClass,
				mode: state.mode,
				latencyBucket: sourceDurationBucket(Number.isFinite(searchableAt) ? Date.now() - searchableAt : 0),
			});
		}
	} catch (error) {
		rethrowLifecycleFailure("first-recall", error);
	}
}
