import type { DbAccessor, ReadDb } from "../db/owner/accessor";
import { dbOwnerBatch, dbOwnerQuery, ownerStatement } from "../db/owner/runtime";
import type { RuntimePath } from "./tracker";

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
	markExpiredAsync?(sessionKey: string, agentId: string): Promise<void>;
	markEnded(claim: PersistedSessionClaim): void;
	remove(sessionKey: string, agentId: string): void;
	removeAsync?(sessionKey: string, agentId: string): Promise<void>;
	list(): readonly PersistedSessionClaim[];
	listAsync?(): Promise<readonly PersistedSessionClaim[]>;
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

const SESSION_CLAIM_RESTORE_PAGE_ROWS = 1000;

function persistedClaimsFromRows(rows: readonly SessionClaimRow[]): readonly PersistedSessionClaim[] {
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

function readClaims(db: ReadDb): readonly PersistedSessionClaim[] {
	const rows = db
		.prepare(
			`SELECT session_key, agent_id, runtime_path, harness, claimed_at, expires_at,
					state, ended_at, end_marker
			 FROM session_claims
			 ORDER BY claimed_at ASC`,
		)
		.all() as SessionClaimRow[];
	return persistedClaimsFromRows(rows);
}

export function createSessionClaimStore(accessor: DbAccessor): SessionClaimStore {
	return {
		upsertActive(claim): void {
			// @ts-expect-error LEGACY_SYNC_DB_ACCESS: withWriteTx migration site
			accessor.withWriteTx((db: import("../db/owner/accessor").WriteDb) => {
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
			}, "sessions/claims.ts:74");
		},
		markExpired(sessionKey, agentId): void {
			// @ts-expect-error LEGACY_SYNC_DB_ACCESS: withWriteTx migration site
			accessor.withWriteTx((db: import("../db/owner/accessor").WriteDb) => {
				db.prepare(
					`UPDATE session_claims
					 SET state = 'expired'
					 WHERE session_key = ? AND agent_id = ? AND state = 'active'`,
				).run(sessionKey, agentId);
			}, "sessions/claims.ts:92");
		},
		async markExpiredAsync(sessionKey, agentId): Promise<void> {
			await dbOwnerBatch(
				[
					ownerStatement(
						`UPDATE session_claims
						 SET state = 'expired'
						 WHERE session_key = ? AND agent_id = ? AND state = 'active'`,
						[sessionKey, agentId],
					),
				],
				{ operation: "session-claims.restore-expire", lane: "write" },
			);
		},
		markEnded(claim): void {
			// @ts-expect-error LEGACY_SYNC_DB_ACCESS: withWriteTx migration site
			accessor.withWriteTx((db: import("../db/owner/accessor").WriteDb) => {
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
			}, "sessions/claims.ts:115");
		},
		remove(sessionKey, agentId): void {
			// @ts-expect-error LEGACY_SYNC_DB_ACCESS: withWriteTx migration site
			accessor.withWriteTx((db: import("../db/owner/accessor").WriteDb) => {
				db.prepare("DELETE FROM session_claims WHERE session_key = ? AND agent_id = ?").run(sessionKey, agentId);
			}, "sessions/claims.ts:142");
		},
		async removeAsync(sessionKey, agentId): Promise<void> {
			await dbOwnerBatch(
				[ownerStatement("DELETE FROM session_claims WHERE session_key = ? AND agent_id = ?", [sessionKey, agentId])],
				{ operation: "session-claims.restore-remove", lane: "write" },
			);
		},
		list(): readonly PersistedSessionClaim[] {
			// @ts-expect-error LEGACY_SYNC_DB_ACCESS: withReadDb migration site
			return accessor.withReadDb(readClaims, "sessions/claims.ts:154");
		},
		async listAsync(): Promise<readonly PersistedSessionClaim[]> {
			const rows: SessionClaimRow[] = [];
			let cursor: SessionClaimRow | undefined;
			for (;;) {
				const page = await dbOwnerQuery<readonly SessionClaimRow[]>(
					ownerStatement(
						`SELECT session_key, agent_id, runtime_path, harness, claimed_at, expires_at,
								state, ended_at, end_marker
						 FROM session_claims
						 ${cursor ? "WHERE (claimed_at, agent_id, session_key) > (?, ?, ?)" : ""}
						 ORDER BY claimed_at ASC, agent_id ASC, session_key ASC
						 LIMIT ?`,
						cursor
							? [cursor.claimed_at, cursor.agent_id, cursor.session_key, SESSION_CLAIM_RESTORE_PAGE_ROWS]
							: [SESSION_CLAIM_RESTORE_PAGE_ROWS],
						"all",
					),
					{ operation: "session-claims.restore", lane: "read" },
				);
				rows.push(...page);
				cursor = page[page.length - 1];
				if (page.length < SESSION_CLAIM_RESTORE_PAGE_ROWS) break;
			}
			return persistedClaimsFromRows(rows);
		},
	};
}
