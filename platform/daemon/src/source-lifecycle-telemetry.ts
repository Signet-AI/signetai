import { createHash } from "node:crypto";
import type { SignetSourceEntry, SignetSourceKind } from "@signet/core";
import { getDbAccessor } from "./db-accessor";
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

function readState(
	db: { prepare: (sql: string) => { get: (...args: unknown[]) => unknown } },
	agentId: string,
	key: string,
): SourceLifecycleState | null {
	const row = db
		.prepare(`
		SELECT source_key, source_class, mode, connected_at, first_indexed_at,
			first_searchable_at, first_recall_at, last_success_at,
			last_freshness_state, last_freshness_event_at
		FROM source_lifecycle_state WHERE agent_id = ? AND source_key = ?
	`)
		.get(agentId, key) as Record<string, unknown> | undefined;
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

function ensureState(
	db: { prepare: (sql: string) => { run: (...args: unknown[]) => { changes?: number } } },
	agentId: string,
	source: SourceLifecycleSource,
	mode: SourceMode,
): { readonly key: string; readonly inserted: boolean } {
	const key = sourceKey(sourceIdentity(source));
	const result = db
		.prepare(`
			INSERT OR IGNORE INTO source_lifecycle_state
			(agent_id, source_key, source_class, mode, connected_at)
			VALUES (?, ?, ?, ?, NULL)
		`)
		.run(agentId, key, sourceClassForKind(String(source.kind)), mode);
	return { key, inserted: (result.changes ?? 0) > 0 };
}

export function recordSourceConnected(source: SignetSourceEntry, agentId: string, mode = sourceModeFor(source)): void {
	if (!getActiveTelemetry()?.enabled) return;
	const now = new Date().toISOString();
	try {
		let claimed = false;
		getDbAccessor().withWriteTx((db) => {
			const state = ensureState(db, agentId, source, mode);
			const result = db
				.prepare(`
				UPDATE source_lifecycle_state SET connected_at = ?, mode = ?
				WHERE agent_id = ? AND source_key = ? AND connected_at IS NULL
			`)
				.run(now, mode, agentId, state.key);
			claimed = (result.changes ?? 0) > 0;
		});
		if (claimed) {
			emit({ phase: "connect", outcome: "success", sourceClass: sourceClassForKind(String(source.kind)), mode });
		}
	} catch {
		// Telemetry is best effort and must not affect source configuration.
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

function sourceSizeBytes(source: SourceLifecycleSource, agentId: string): number | undefined {
	try {
		return getDbAccessor().withReadDb((db) => {
			const rootPrefix = `${(source.root ?? "").replace(/\\/g, "/").replace(/\/$/, "")}/`;
			const legacyObsidianClause =
				source.kind === "obsidian"
					? "OR (harness = 'obsidian' AND source_id IS NULL AND source_path >= ? AND source_path < ?)"
					: "";
			const row = db
				.prepare(`
				SELECT SUM(length(content)) AS bytes
				FROM memory_artifacts
				WHERE agent_id = ?
				  AND (
					source_id = ?
					${legacyObsidianClause}
				  )
				  AND COALESCE(is_deleted, 0) = 0
			`)
				.get(agentId, source.id, ...(source.kind === "obsidian" ? [rootPrefix, `${rootPrefix}\uffff`] : [])) as
				| { bytes?: unknown }
				| undefined;
			return typeof row?.bytes === "number" && Number.isFinite(row.bytes) ? row.bytes : undefined;
		});
	} catch {
		return undefined;
	}
}

export function sourceHasSearchableArtifacts(source: SignetSourceEntry, agentId: string): boolean {
	if (!getActiveTelemetry()?.enabled) return false;
	try {
		return getDbAccessor().withReadDb((db) => {
			const rootPrefix = `${source.root.replace(/\\/g, "/").replace(/\/$/, "")}/`;
			const legacyObsidianClause =
				source.kind === "obsidian"
					? "OR (harness = 'obsidian' AND source_id IS NULL AND source_path >= ? AND source_path < ?)"
					: "";
			const row = db
				.prepare(
					`SELECT 1 AS n FROM memory_artifacts
					 WHERE agent_id = ?
					   AND (
						 source_id = ?
						 ${legacyObsidianClause}
					   )
					   AND COALESCE(is_deleted, 0) = 0
					   AND COALESCE(source_kind, '') NOT LIKE 'source_%_failure'
					   AND COALESCE(source_kind, '') NOT LIKE 'source_%_checkpoint'
					 LIMIT 1`,
				)
				.get(agentId, source.id, ...(source.kind === "obsidian" ? [rootPrefix, `${rootPrefix}\uffff`] : []));
			return Boolean(row);
		});
	} catch {
		return false;
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

export function recordSourceIndexOperation(input: SourceIndexTelemetryInput): void {
	if (!getActiveTelemetry()?.enabled) return;
	const mode = input.mode ?? sourceModeFor(input.source);
	const now = new Date();
	const nowIso = now.toISOString();
	const sourceClass = sourceClassForKind(String(input.source.kind));
	const accepted = boundedCount(input.accepted);
	const discovered = boundedCount(input.discovered);
	const skipped = boundedCount(input.skipped ?? Math.max(0, discovered - accepted - boundedCount(input.failed ?? 0)));
	const failed = boundedCount(input.failed ?? 0);
	const bytes = input.sourceBytes ?? sourceSizeBytes(input.source, input.agentId);
	const searchable = input.searchable ?? (accepted > 0 || (bytes !== undefined && bytes > 0));
	const sizeBucket = sourceSizeBucket(bytes);
	let firstIndexed = false;
	let firstSearchable = false;
	let freshness: { readonly state: SourceFreshnessState; readonly lag: SourceLagBucket } | null = null;

	try {
		getDbAccessor().withWriteTx((db) => {
			const ensured = ensureState(db, input.agentId, input.source, mode);
			const before = readState(db, input.agentId, ensured.key);
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
			db.prepare(`
				UPDATE source_lifecycle_state SET
					mode = ?,
					first_indexed_at = CASE WHEN ? = 1 AND first_indexed_at IS NULL THEN ? ELSE first_indexed_at END,
					first_searchable_at = CASE WHEN ? = 1 AND first_searchable_at IS NULL THEN ? ELSE first_searchable_at END,
					last_success_at = ?,
					last_freshness_state = CASE WHEN ? = 'recurring' THEN ? ELSE last_freshness_state END,
					last_freshness_event_at = CASE WHEN ? = 1 THEN ? ELSE last_freshness_event_at END
				WHERE agent_id = ? AND source_key = ?
			`).run(
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
				ensured.key,
			);
		});
	} catch {
		// A missing or unavailable DB must not turn a completed source sync into a failure.
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

export function recordFirstSourceRecall(agentId: string, results: readonly SourceRecallTelemetryResult[]): void {
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
	for (const [sourceClass, ids] of byClass) claimFirstSourceRecall(agentId, sourceClass, ids);
}

/** Record a rate-limited checkpoint for a long-lived source stream. */
export function recordSourceFreshness(source: SignetSourceEntry, agentId: string): void {
	if (sourceModeFor(source) !== "recurring") return;
	const now = new Date();
	const nowIso = now.toISOString();
	let lag: SourceLagBucket = "unknown";
	let suppressed = false;
	try {
		getDbAccessor().withWriteTx((db) => {
			const ensured = ensureState(db, agentId, source, "recurring");
			const state = readState(db, agentId, ensured.key);
			if (state?.lastFreshnessEventAt) {
				const lastEvent = Date.parse(state.lastFreshnessEventAt);
				if (Number.isFinite(lastEvent) && now.getTime() - lastEvent < FRESHNESS_EVENT_INTERVAL_MS) {
					suppressed = true;
					return;
				}
			}
			const previous = state?.lastSuccessAt ? Date.parse(state.lastSuccessAt) : Number.NaN;
			lag = sourceLagBucket(Number.isFinite(previous) ? now.getTime() - previous : null);
			db.prepare(`
				UPDATE source_lifecycle_state
				SET mode = 'recurring', last_success_at = ?, last_freshness_state = 'healthy', last_freshness_event_at = ?
				WHERE agent_id = ? AND source_key = ?
			`).run(nowIso, nowIso, agentId, ensured.key);
		});
	} catch {
		// Best effort.
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
export function recordSourceReadiness(source: SignetSourceEntry, agentId: string): void {
	const processKey = `${agentId}:${sourceKey(sourceIdentity(source))}`;
	if (readinessClaimedInProcess.has(processKey)) return;
	const now = new Date().toISOString();
	let firstIndexed = false;
	let firstSearchable = false;
	try {
		getDbAccessor().withWriteTx((db) => {
			const ensured = ensureState(db, agentId, source, "recurring");
			const state = readState(db, agentId, ensured.key);
			if (state?.firstIndexedAt && state.firstSearchableAt) {
				readinessClaimedInProcess.add(processKey);
				return;
			}
			firstIndexed = !state?.firstIndexedAt;
			firstSearchable = !state?.firstSearchableAt;
			db.prepare(`
				UPDATE source_lifecycle_state SET
					mode = 'recurring',
					first_indexed_at = COALESCE(first_indexed_at, ?),
					first_searchable_at = COALESCE(first_searchable_at, ?)
				WHERE agent_id = ? AND source_key = ?
			`).run(now, now, agentId, ensured.key);
		});
	} catch {
		return;
	}
	readinessClaimedInProcess.add(processKey);
	const sourceClass = sourceClassForKind(String(source.kind));
	if (firstIndexed)
		emit({ phase: "readiness", readiness: "indexed", outcome: "success", sourceClass, mode: "recurring" });
	if (firstSearchable)
		emit({ phase: "readiness", readiness: "searchable", outcome: "success", sourceClass, mode: "recurring" });
}

export function removeSourceLifecycleState(source: SignetSourceEntry, agentId: string): void {
	const processKey = `${agentId}:${sourceKey(sourceIdentity(source))}`;
	readinessClaimedInProcess.delete(processKey);
	try {
		getDbAccessor().withWriteTx((db) => {
			db.prepare("DELETE FROM source_lifecycle_state WHERE agent_id = ? AND source_key = ?").run(
				agentId,
				sourceKey(sourceIdentity(source)),
			);
		});
	} catch {
		// Best effort; source deletion must not depend on telemetry state.
	}
}

function claimFirstSourceRecall(agentId: string, sourceClass: SourceClass, candidateIds: readonly string[]): void {
	try {
		const claimed: SourceLifecycleState[] = [];
		getDbAccessor().withWriteTx((db) => {
			const keys = candidateIds.map(sourceKey);
			if (keys.length === 0) return;
			const rows = db
				.prepare(`
					SELECT source_key, source_class, mode, connected_at, first_indexed_at, first_searchable_at,
						first_recall_at, last_success_at, last_freshness_state, last_freshness_event_at
					FROM source_lifecycle_state
					WHERE agent_id = ? AND source_class = ? AND first_searchable_at IS NOT NULL
						AND first_recall_at IS NULL AND source_key IN (${keys.map(() => "?").join(",")})
					ORDER BY first_searchable_at ASC LIMIT 20
				`)
				.all(agentId, sourceClass, ...keys) as Array<Record<string, unknown>>;
			for (const row of rows) {
				const state = readState(db, agentId, String(row.source_key));
				if (!state) continue;
				const result = db
					.prepare(`
				UPDATE source_lifecycle_state SET first_recall_at = ?
				WHERE agent_id = ? AND source_key = ? AND first_recall_at IS NULL
			`)
					.run(new Date().toISOString(), agentId, state.sourceKey);
				if ((result.changes ?? 0) > 0) claimed.push(state);
			}
		});
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
	} catch {
		// Best effort; recall itself must never depend on telemetry state.
	}
}
