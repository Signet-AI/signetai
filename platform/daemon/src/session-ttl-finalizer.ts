import { type ContinuityState, type StructuralSnapshot, getState } from "./continuity-state";
import type { DbAccessor } from "./db-accessor";
import { logger } from "./logger";
import { type WriteCheckpointParams, writeCheckpointAsync } from "./session-checkpoints";
import type { EvictedSessionInfo, SessionEvictionHandler } from "./session-tracker";
import { markSessionTranscriptCompletedInTx } from "./session-transcripts";

export interface TtlFinalizerDeps {
	readonly accessor: DbAccessor;
	readonly maxCheckpointsPerSession: number;
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
export function createTtlEvictionHandler(deps: TtlFinalizerDeps): SessionEvictionHandler {
	return async (info: EvictedSessionInfo): Promise<"finalized" | "skipped" | undefined> => {
		let transcriptFinalized = false;
		const snap = getState(info.sessionKey);
		if (snap && snap.totalPromptCount > 0) {
			try {
				await writeCheckpointAsync(
					deps.accessor,
					snapshotToCheckpoint(snap, info.sessionKey),
					deps.maxCheckpointsPerSession,
				);
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
		try {
			const completedAt = new Date().toISOString();
			const alreadyCompleted = await deps.accessor.withReadDbAsync(
				(db) => {
					const columns = db.prepare("PRAGMA table_info(session_transcripts)").all() as ReadonlyArray<
						Record<string, unknown>
					>;
					if (!columns.some((column) => column.name === "completed_at")) return false;
					const row = db
						.prepare("SELECT completed_at FROM session_transcripts WHERE session_key = ? AND agent_id = ? LIMIT 1")
						.get(info.sessionKey, info.agentId) as { completed_at?: string | null } | undefined;
					return row?.completed_at != null;
				},
				{ siteToken: "session-ttl-finalizer.ts:56" },
			);
			transcriptFinalized =
				alreadyCompleted ||
				(await deps.accessor.withWriteTxAsync(
					(db) => markSessionTranscriptCompletedInTx(db, info.sessionKey, info.agentId, completedAt),
					{ siteToken: "session-ttl-finalizer.ts:71" },
				));
		} catch (err) {
			logger.warn("session-tracker", "TTL-eviction transcript completion failed (non-fatal)", {
				sessionKey: info.sessionKey,
				error: err instanceof Error ? err.message : String(err),
			});
		}

		if (!transcriptFinalized) {
			logger.info("session-tracker", "TTL-evicted session completion skipped", {
				sessionKey: info.sessionKey,
			});
			return "skipped";
		}
		logger.info("session-tracker", "TTL-evicted transcript marked complete", {
			sessionKey: info.sessionKey,
		});
		return "finalized";
	};
}
