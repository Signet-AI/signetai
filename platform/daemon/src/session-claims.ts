import type { DbAccessor, ReadDb } from "./db-accessor";
import type { RuntimePath } from "./session-tracker";

export type PersistedSessionState = "active" | "expired" | "ended";

export interface PersistedSessionClaim {
	readonly sessionKey: string;
	readonly agentId: string;
	readonly runtimePath: RuntimePath | null;
	readonly harness: string | null;
	readonly claimedAt: string;
	readonly expiresAt: string;
	readonly state: PersistedSessionState;
	readonly endedAt: string | null;
	readonly endMarker: string | null;
}

export interface SessionClaimStore {
	upsertActive(claim: PersistedSessionClaim): void;
	markExpired(sessionKey: string, agentId: string): void;
	markEnded(claim: PersistedSessionClaim): void;
	remove(sessionKey: string, agentId: string): void;
	list(): readonly PersistedSessionClaim[];
}

interface SessionClaimRow {
	readonly session_key: string;
	readonly agent_id: string;
	readonly runtime_path: RuntimePath | null;
	readonly harness: string | null;
	readonly claimed_at: string;
	readonly expires_at: string;
	readonly state: PersistedSessionState;
	readonly ended_at: string | null;
	readonly end_marker: string | null;
}

function readClaims(db: ReadDb): readonly PersistedSessionClaim[] {
	const rows = db
		.prepare(
			`SELECT session_key, agent_id, runtime_path, harness, claimed_at, expires_at,
					state, ended_at, end_marker
			 FROM session_claims
			 ORDER BY claimed_at ASC`,
		)
		.all() as SessionClaimRow[];
	return rows.map((row) => ({
		sessionKey: row.session_key,
		agentId: row.agent_id,
		runtimePath: row.runtime_path,
		harness: row.harness,
		claimedAt: row.claimed_at,
		expiresAt: row.expires_at,
		state: row.state,
		endedAt: row.ended_at,
		endMarker: row.end_marker,
	}));
}

export function createSessionClaimStore(accessor: DbAccessor): SessionClaimStore {
	return {
		upsertActive(claim): void {
			// @ts-expect-error LEGACY_SYNC_DB_ACCESS: withWriteTx migration site
			accessor.withWriteTx((db: import("./db-accessor").WriteDb) => {
				db.prepare(
					`INSERT INTO session_claims
						(session_key, agent_id, runtime_path, harness, claimed_at, expires_at, state, ended_at, end_marker)
					 VALUES (?, ?, ?, ?, ?, ?, 'active', NULL, NULL)
					 ON CONFLICT(agent_id, session_key) DO UPDATE SET
						runtime_path = excluded.runtime_path,
						harness = excluded.harness,
						claimed_at = excluded.claimed_at,
						expires_at = excluded.expires_at,
						state = 'active',
						ended_at = NULL,
						end_marker = NULL`,
				).run(claim.sessionKey, claim.agentId, claim.runtimePath, claim.harness, claim.claimedAt, claim.expiresAt);
			});
		},
		markExpired(sessionKey, agentId): void {
			// @ts-expect-error LEGACY_SYNC_DB_ACCESS: withWriteTx migration site
			accessor.withWriteTx((db: import("./db-accessor").WriteDb) => {
				db.prepare(
					`UPDATE session_claims
					 SET state = 'expired'
					 WHERE session_key = ? AND agent_id = ? AND state = 'active'`,
				).run(sessionKey, agentId);
			});
		},
		markEnded(claim): void {
			// @ts-expect-error LEGACY_SYNC_DB_ACCESS: withWriteTx migration site
			accessor.withWriteTx((db: import("./db-accessor").WriteDb) => {
				db.prepare(
					`INSERT INTO session_claims
						(session_key, agent_id, runtime_path, harness, claimed_at, expires_at, state, ended_at, end_marker)
					 VALUES (?, ?, ?, ?, ?, ?, 'ended', ?, ?)
					 ON CONFLICT(agent_id, session_key) DO UPDATE SET
						runtime_path = excluded.runtime_path,
						harness = excluded.harness,
						claimed_at = excluded.claimed_at,
						expires_at = excluded.expires_at,
						state = 'ended',
						ended_at = excluded.ended_at,
						end_marker = excluded.end_marker`,
				).run(
					claim.sessionKey,
					claim.agentId,
					claim.runtimePath,
					claim.harness,
					claim.claimedAt,
					claim.expiresAt,
					claim.endedAt,
					claim.endMarker,
				);
			});
		},
		remove(sessionKey, agentId): void {
			// @ts-expect-error LEGACY_SYNC_DB_ACCESS: withWriteTx migration site
			accessor.withWriteTx((db: import("./db-accessor").WriteDb) => {
				db.prepare("DELETE FROM session_claims WHERE session_key = ? AND agent_id = ?").run(sessionKey, agentId);
			});
		},
		list(): readonly PersistedSessionClaim[] {
			// @ts-expect-error LEGACY_SYNC_DB_ACCESS: withReadDb migration site
			return accessor.withReadDb(readClaims);
		},
	};
}
