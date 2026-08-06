/**
 * TTL-eviction finalizer (#902).
 *
 * When the session tracker's stale-session cleanup evicts a claim whose
 * harness never sent a session-end event, the in-memory lifecycle state is
 * about to be dropped. This finalizer makes that a formal, auditable
 * transition:
 *
 *  1. Persists a `ttl_expired` checkpoint from whatever continuity state
 *     the session still holds (so the latest transcript cursor survives).
 *  2. Enqueues idempotent summary finalization from the stored transcript
 *     when the pipeline is enabled — the same content-hash dedup the
 *     session-end path uses, so a later real session-end cannot double-fire.
 *  3. Returns "skipped" (counted as unfinalized) when synthesis is disabled
 *     or there is nothing to finalize.
 */

import { createHash } from "node:crypto";
import { type ContinuityState, type StructuralSnapshot, getState } from "./continuity-state";
import type { DbAccessor } from "./db-accessor";
import { logger } from "./logger";
import { enqueueSummaryJob } from "./pipeline/summary-worker";
import { type WriteCheckpointParams, writeCheckpoint } from "./session-checkpoints";
import type { EvictedSessionInfo, SessionEvictionHandler } from "./session-tracker";
import { getSessionTranscriptContent } from "./session-transcripts";

const MIN_FINALIZE_TRANSCRIPT_CHARS = 500;
const MAX_TRANSCRIPT_CHARS = 100_000;

export interface TtlFinalizerDeps {
	readonly accessor: DbAccessor;
	readonly maxCheckpointsPerSession: number;
	readonly isSummarySynthesisAvailable: () => boolean;
}

function snapshotToCheckpoint(snap: ContinuityState, sessionKey: string): WriteCheckpointParams {
	const structural = snap.structuralSnapshot as StructuralSnapshot | undefined;
	return {
		sessionKey,
		harness: snap.harness,
		project: snap.project,
		projectNormalized: snap.projectNormalized,
		trigger: "ttl_expired",
		digest: `${snap.totalPromptCount} prompts accumulated before TTL eviction`,
		promptCount: snap.totalPromptCount,
		memoryQueries: snap.pendingQueries,
		recentRemembers: [],
		focalEntityIds: structural?.focalEntityIds,
		focalEntityNames: structural?.focalEntityNames,
		activeAspectIds: structural?.activeAspectIds,
		surfacedConstraintCount: structural?.surfacedConstraintCount,
		traversalMemoryCount: structural?.traversalMemoryCount,
	};
}

function summaryJobsHasContentHashColumn(deps: TtlFinalizerDeps): boolean {
	return deps.accessor.withReadDb((db) =>
		(db.prepare("PRAGMA table_info(summary_jobs)").all() as ReadonlyArray<Record<string, unknown>>).some(
			(col) => col.name === "content_hash",
		),
	);
}

function summaryJobWithContentHashExists(
	deps: TtlFinalizerDeps,
	agentId: string,
	sessionKey: string,
	contentHash: string,
): boolean {
	if (!summaryJobsHasContentHashColumn(deps)) return false;
	return deps.accessor.withReadDb((db) => {
		const row = db
			.prepare(
				`SELECT id FROM summary_jobs
				 WHERE agent_id = ? AND session_key = ? AND content_hash = ?
				 AND status IN ('pending', 'processing', 'completed')
				 LIMIT 1`,
			)
			.get(agentId, sessionKey, contentHash) as { id: string } | undefined;
		return Boolean(row);
	});
}

function storeSummaryJobContentHash(deps: TtlFinalizerDeps, jobId: string, contentHash: string): void {
	if (!summaryJobsHasContentHashColumn(deps)) return;
	deps.accessor.withWriteTx((db) => {
		db.prepare("UPDATE summary_jobs SET content_hash = ? WHERE id = ?").run(contentHash, jobId);
	});
}

/**
 * Build the session-tracker eviction handler. Returns the handler to pass to
 * `setSessionEvictionHandler`.
 */
export function createTtlEvictionHandler(deps: TtlFinalizerDeps): SessionEvictionHandler {
	return (info: EvictedSessionInfo): "finalized" | "skipped" | undefined => {
		let summaryFinalized = false;

		// 1. Persist a ttl_expired checkpoint from residual continuity state.
		const snap = getState(info.sessionKey);
		if (snap && snap.totalPromptCount > 0) {
			try {
				writeCheckpoint(deps.accessor, snapshotToCheckpoint(snap, info.sessionKey), deps.maxCheckpointsPerSession);
				logger.info("session-tracker", "TTL-evicted session checkpointed", {
					sessionKey: info.sessionKey,
					promptCount: snap.totalPromptCount,
				});
			} catch (err) {
				logger.warn("session-tracker", "TTL-eviction checkpoint write failed", {
					sessionKey: info.sessionKey,
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}

		// 2. Enqueue idempotent summary finalization from the stored transcript.
		if (!deps.isSummarySynthesisAvailable()) {
			logger.info("session-tracker", "TTL-evicted session finalization skipped", {
				sessionKey: info.sessionKey,
				reason: "synthesis-unavailable",
			});
			return "skipped";
		}
		try {
			const stored = getSessionTranscriptContent(info.sessionKey, info.agentId);
			if (stored && stored.trim().length >= MIN_FINALIZE_TRANSCRIPT_CHARS) {
				const contentHash = createHash("sha256").update(stored).digest("hex");
				if (summaryJobWithContentHashExists(deps, info.agentId, info.sessionKey, contentHash)) {
					logger.debug("session-tracker", "TTL-eviction summary skipped duplicate content", {
						sessionKey: info.sessionKey,
						contentHash,
					});
					summaryFinalized = true;
				} else {
					const summaryTranscript =
						stored.length > MAX_TRANSCRIPT_CHARS ? `${stored.slice(0, MAX_TRANSCRIPT_CHARS)}\n[truncated]` : stored;
					const jobId = enqueueSummaryJob(deps.accessor, {
						harness: info.runtimePath,
						transcript: summaryTranscript,
						sessionKey: info.sessionKey,
						agentId: info.agentId,
						trigger: "ttl_expired",
						boundaryReason: "session_ttl_expired",
						endedAt: new Date().toISOString(),
					});
					storeSummaryJobContentHash(deps, jobId, contentHash);
					summaryFinalized = true;
					logger.info("session-tracker", "TTL-evicted session finalized", {
						sessionKey: info.sessionKey,
					});
				}
			}
		} catch (err) {
			logger.warn("session-tracker", "TTL-eviction finalization failed (non-fatal)", {
				sessionKey: info.sessionKey,
				error: err instanceof Error ? err.message : String(err),
			});
		}

		// 3. Classify the outcome: an eviction with no checkpoint and no
		//    finalization (synthesis disabled / nothing to finalize) is
		//    counted as unfinalized so diagnostics can surface it.
		if (!summaryFinalized) {
			logger.info("session-tracker", "TTL-evicted session finalization skipped", {
				sessionKey: info.sessionKey,
			});
			return "skipped";
		}
		return "finalized";
	};
}
