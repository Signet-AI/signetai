/**
 * Session Tracker
 *
 * Lightweight in-memory tracker that ensures exactly one runtime path
 * (plugin or legacy-hook) is active per session. Prevents duplicate
 * capture/recall when both paths are configured.
 *
 * Also tracks per-session bypass state — when bypassed, all hook
 * endpoints return empty no-op responses while MCP tools still work.
 */

import { logger } from "./logger";
import type { PersistedSessionClaim, SessionClaimStore } from "./session-claims";
import {
	hasSessionEndTelemetry,
	hashSessionKey,
	markSessionEndTelemetry,
	normalizeSessionKey,
	resetSessionEndTelemetry,
} from "./session-end-state";
import { getActiveTelemetry } from "./telemetry";

export { normalizeSessionKey } from "./session-end-state";

export type RuntimePath = "plugin" | "legacy";

export interface SessionInfo {
	readonly key: string;
	readonly agentId: string;
	readonly runtimePath: RuntimePath;
	readonly claimedAt: string;
	readonly expiresAt: string;
	readonly bypassed: boolean;
}

interface SessionClaim {
	/** Identity token prevents a delayed eviction result from touching a replacement claim. */
	readonly claimId: symbol;
	readonly sessionKey: string;
	readonly agentId: string;
	readonly runtimePath: RuntimePath;
	/** Harness that claimed the session (for telemetry breakdowns). */
	harness?: string;
	readonly claimedAt: string;
	expiresAt: number;
}

export interface EndedSessionInfo {
	readonly key: string;
	readonly runtimePath?: RuntimePath;
	readonly endedAt: string;
	readonly expiresAt: string;
}

interface EndedSession {
	readonly agentId: string;
	readonly runtimePath?: RuntimePath;
	readonly endedAt: string;
	expiresAt: number;
}

type ClaimResult = { readonly ok: true } | { readonly ok: false; readonly claimedBy: RuntimePath };

/** Session lifecycle info handed to the TTL-eviction handler (#902). */
export interface EvictedSessionInfo {
	readonly sessionKey: string;
	readonly agentId: string;
	readonly runtimePath: RuntimePath;
	readonly harness?: string;
	readonly claimedAt: string;
}

/**
 * Optional handler invoked when a stale session claim is evicted by TTL
 * cleanup. Returns "finalized" when the handler applied a formal lifecycle
 * transition (checkpoint + finalization), "skipped" when finalization was
 * intentionally skipped (e.g. synthesis disabled), or undefined when the
 * handler did not classify the outcome. Counters exposed via
 * `getSessionTrackerStats` are updated accordingly (#902).
 */
export type SessionEvictionOutcome = "finalized" | "skipped" | undefined;
export type SessionEvictionHandler = (
	info: EvictedSessionInfo,
) => SessionEvictionOutcome | Promise<SessionEvictionOutcome>;

const STALE_SESSION_MS = 4 * 60 * 60 * 1000; // 4 hours
const ENDED_SESSION_TOMBSTONE_MS = 30 * 60 * 1000; // 30 minutes
const CLEANUP_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const WARN_BEFORE_MS = 30 * 60 * 1000; // warn 30 min before expiry

const sessions = new Map<string, SessionClaim>();
const endedSessions = new Map<string, EndedSession>();
/** Key → expiresAt timestamp. Entries without a matching session claim are
 *  evicted by `cleanupStaleSessions` once their TTL elapses. */
const bypassedSessions = new Map<string, number>();
/** Sessions that have already received an expiry warning — avoid per-hook spam. */
const warnedSessions = new Set<string>();
let cleanupTimer: ReturnType<typeof setInterval> | null = null;
// Synchronous guard — prevents double-start during concurrent async init.
let cleanupStarted = false;
// TTL-eviction lifecycle hook + counters (#902).
let evictionHandler: SessionEvictionHandler | null = null;
let claimStore: SessionClaimStore | null = null;
let expiredCount = 0;
let unfinalizedCount = 0;

function scopedSessionKey(sessionKey: string, agentId: string): string {
	return agentId === "default" ? sessionKey : JSON.stringify([agentId, sessionKey]);
}

function persistedClaim(
	key: string,
	claim: SessionClaim,
	state: "active" | "expired" | "ended" = "active",
	endedAt: string | null = null,
	endMarker: string | null = null,
): PersistedSessionClaim {
	return {
		sessionKey: key,
		agentId: claim.agentId,
		runtimePath: claim.runtimePath,
		harness: claim.harness ?? null,
		claimedAt: claim.claimedAt,
		expiresAt: new Date(claim.expiresAt).toISOString(),
		state,
		endedAt,
		endMarker,
	};
}

// normalizeSessionKey is defined in session-end-state.ts (single source of
// truth for session-key identity) and re-exported here for the routes.

function evictExpiredSession(mapKey: string, claim: SessionClaim, emitEndTelemetry = true): void {
	if (!sessions.delete(mapKey)) return;
	const key = claim.sessionKey;
	const scopedKey = scopedSessionKey(key, claim.agentId);
	bypassedSessions.delete(scopedKey);
	warnedSessions.delete(scopedKey);
	expiredCount++;
	logger.warn("session-tracker", "Session evicted (TTL expired)", {
		sessionKey: key,
		runtimePath: claim.runtimePath,
		claimedAt: claim.claimedAt,
	});

	// Real session termination: the daemon judged the session abandoned
	// (no hooks for STALE_SESSION_MS). Emit session.end once per session
	// lifetime (#1212) — dedup'd so a session already counted via explicit
	// clear is not double-counted here.
	if (
		emitEndTelemetry &&
		!hasSessionEndTelemetry({ agentId: claim.agentId, harness: claim.harness, sessionKey: key })
	) {
		getActiveTelemetry()?.record("session.end", {
			harness: claim.harness ?? null,
			reason: "expired",
			sessionHash: hashSessionKey(key),
		});
		markSessionEndTelemetry({ agentId: claim.agentId, harness: claim.harness, sessionKey: key });
	}

	if (!evictionHandler) {
		claimStore?.markExpired(key, claim.agentId);
		return;
	}
	const isCurrentClaim = (): boolean => sessions.get(mapKey)?.claimId === claim.claimId;
	const applyOutcome = (outcome: SessionEvictionOutcome): void => {
		if (outcome === "skipped") unfinalizedCount++;
		if (!isCurrentClaim()) return;
		if (outcome === "finalized") {
			claimStore?.remove(key, claim.agentId);
		} else {
			claimStore?.markExpired(key, claim.agentId);
		}
	};
	try {
		const result = evictionHandler({
			sessionKey: key,
			agentId: claim.agentId,
			runtimePath: claim.runtimePath,
			harness: claim.harness,
			claimedAt: claim.claimedAt,
		});
		if (result instanceof Promise) {
			void result.then(applyOutcome).catch((err: unknown) => {
				unfinalizedCount++;
				if (isCurrentClaim()) claimStore?.markExpired(key, claim.agentId);
				logger.warn("session-tracker", "Async session eviction handler failed", {
					sessionKey: key,
					error: err instanceof Error ? err.message : String(err),
				});
			});
			return;
		}
		applyOutcome(result);
	} catch (err) {
		unfinalizedCount++;
		if (isCurrentClaim()) claimStore?.markExpired(key, claim.agentId);
		logger.warn("session-tracker", "Session eviction handler failed", {
			sessionKey: key,
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

/**
 * Claim a session for a given runtime path. Returns ok:true if the
 * session is unclaimed or already claimed by the same path. Returns
 * ok:false with claimedBy if claimed by the other path.
 */
export function claimSession(
	sessionKey: string,
	runtimePath: RuntimePath,
	agentId = "default",
	harness?: string,
): ClaimResult {
	const key = normalizeSessionKey(sessionKey);
	const mapKey = scopedSessionKey(key, agentId);
	const existing = sessions.get(mapKey);
	endedSessions.delete(mapKey);

	if (existing) {
		if (existing.runtimePath === runtimePath) {
			// Same path reclaiming — refresh expiry and repair telemetry metadata.
			if (harness !== undefined) existing.harness = harness;
			existing.expiresAt = Date.now() + STALE_SESSION_MS;
			claimStore?.upsertActive(persistedClaim(key, existing));
			return { ok: true };
		}

		// Check if the existing claim is stale
		if (Date.now() > existing.expiresAt) {
			logger.info("session-tracker", "Evicting stale session claim", {
				sessionKey: key,
				previousPath: existing.runtimePath,
				newPath: runtimePath,
			});
			evictExpiredSession(mapKey, existing);
			// Fall through to create new claim
		} else {
			return { ok: false, claimedBy: existing.runtimePath };
		}
	}

	const claim: SessionClaim = {
		claimId: Symbol("session-claim"),
		sessionKey: key,
		agentId,
		runtimePath,
		harness,
		claimedAt: new Date().toISOString(),
		expiresAt: Date.now() + STALE_SESSION_MS,
	};
	sessions.set(mapKey, claim);
	claimStore?.upsertActive(persistedClaim(key, claim));

	logger.info("session-tracker", "Session claimed", {
		sessionKey: key,
		runtimePath,
	});

	return { ok: true };
}

/**
 * Release a session claim. Called on session-end.
 * Also cleans up bypass state for the session.
 */
export function releaseSession(sessionKey: string, agentId = "default"): void {
	const key = normalizeSessionKey(sessionKey);
	const mapKey = scopedSessionKey(key, agentId);
	const existing = sessions.get(mapKey);
	const removed = sessions.delete(mapKey);
	bypassedSessions.delete(mapKey);
	warnedSessions.delete(mapKey);
	if (existing) claimStore?.remove(key, existing.agentId);
	if (removed) {
		logger.info("session-tracker", "Session released", { sessionKey: key });
	}
}

export function markSessionEnded(sessionKey: string, runtimePath?: RuntimePath, agentId = "default"): void {
	const key = normalizeSessionKey(sessionKey);
	const endedAt = new Date().toISOString();
	const mapKey = scopedSessionKey(key, agentId);
	const existing = sessions.get(mapKey);
	releaseSession(key, agentId);
	const resolvedRuntimePath = runtimePath ?? existing?.runtimePath;
	const tombstoneExpiresAt = Date.now() + ENDED_SESSION_TOMBSTONE_MS;
	endedSessions.set(mapKey, {
		agentId: existing?.agentId ?? agentId,
		runtimePath: resolvedRuntimePath,
		endedAt,
		expiresAt: tombstoneExpiresAt,
	});
	if (claimStore) {
		claimStore.markEnded({
			sessionKey: key,
			agentId: existing?.agentId ?? agentId,
			runtimePath: resolvedRuntimePath ?? null,
			harness: existing?.harness ?? null,
			claimedAt: existing?.claimedAt ?? endedAt,
			expiresAt: new Date(tombstoneExpiresAt).toISOString(),
			state: "ended",
			endedAt,
			endMarker: endedAt,
		});
	}
	logger.info("session-tracker", "Session ended", {
		sessionKey: key,
		runtimePath,
	});
}

/**
 * Return true if the session is currently claimed and not stale.
 * Used by hooks to detect daemon-restart mid-session.
 */
export function hasSession(sessionKey: string, agentId = "default"): boolean {
	const key = normalizeSessionKey(sessionKey);
	const mapKey = scopedSessionKey(key, agentId);
	const claim = sessions.get(mapKey);
	if (!claim) return false;
	if (Date.now() > claim.expiresAt) {
		evictExpiredSession(mapKey, claim);
		return false;
	}
	return true;
}

/**
 * Get the runtime path for a session, if claimed.
 */
export function getSessionPath(sessionKey: string, agentId = "default"): RuntimePath | undefined {
	const key = normalizeSessionKey(sessionKey);
	const mapKey = scopedSessionKey(key, agentId);
	const claim = sessions.get(mapKey);
	if (!claim) return undefined;

	if (Date.now() > claim.expiresAt) {
		evictExpiredSession(mapKey, claim);
		return undefined;
	}

	return claim.runtimePath;
}

export function getEndedSession(sessionKey: string, agentId = "default"): EndedSessionInfo | undefined {
	const key = normalizeSessionKey(sessionKey);
	const ended = endedSessions.get(scopedSessionKey(key, agentId));
	if (!ended) return undefined;

	if (Date.now() > ended.expiresAt) {
		endedSessions.delete(scopedSessionKey(key, agentId));
		return undefined;
	}

	return {
		key,
		runtimePath: ended.runtimePath,
		endedAt: ended.endedAt,
		expiresAt: new Date(ended.expiresAt).toISOString(),
	};
}

// ---------------------------------------------------------------------------
// Bypass state
// ---------------------------------------------------------------------------

/** Enable bypass for a session — hooks return empty no-op responses. */
export function bypassSession(
	sessionKey: string,
	opts?: { readonly allowUnknown?: boolean; readonly ttlMs?: number },
	agentId = "default",
): boolean {
	const key = normalizeSessionKey(sessionKey);
	const mapKey = scopedSessionKey(key, agentId);
	if (!sessions.has(mapKey) && opts?.allowUnknown !== true) {
		logger.warn("session-tracker", "Bypass requested for unknown session", { sessionKey: key });
		return false;
	}
	const ttlMs = opts?.ttlMs;
	const ttl = typeof ttlMs === "number" && Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : STALE_SESSION_MS;
	bypassedSessions.set(mapKey, Date.now() + ttl);
	logger.debug("session-tracker", "Session bypassed", { sessionKey: key });
	return true;
}

/** Disable bypass for a session — hooks resume normal behavior. */
export function unbypassSession(sessionKey: string, agentId = "default"): void {
	const key = normalizeSessionKey(sessionKey);
	const removed = bypassedSessions.delete(scopedSessionKey(key, agentId));
	if (removed) {
		logger.debug("session-tracker", "Session bypass removed", { sessionKey: key });
	}
}

/** Check whether a session is currently bypassed. */
export function isSessionBypassed(sessionKey: string, agentId = "default"): boolean {
	const key = normalizeSessionKey(sessionKey);
	const mapKey = scopedSessionKey(key, agentId);
	const expiresAt = bypassedSessions.get(mapKey);
	if (expiresAt === undefined) return false;
	if (Date.now() > expiresAt) {
		bypassedSessions.delete(mapKey);
		return false;
	}
	return true;
}

/** Get all bypassed session keys with their expiry timestamps. */
export function getBypassedSessionKeys(): ReadonlyMap<string, number> {
	return bypassedSessions;
}

/** List all active sessions with full state. */
export function getActiveSessions(): readonly SessionInfo[] {
	const now = Date.now();
	const result: SessionInfo[] = [];

	for (const [mapKey, claim] of sessions) {
		if (now > claim.expiresAt) {
			evictExpiredSession(mapKey, claim);
			continue;
		}
		result.push({
			key: claim.sessionKey,
			agentId: claim.agentId,
			runtimePath: claim.runtimePath,
			claimedAt: claim.claimedAt,
			expiresAt: new Date(claim.expiresAt).toISOString(),
			bypassed: isSessionBypassed(claim.sessionKey, claim.agentId),
		});
	}

	return result;
}

/**
 * Returns a warning string if the session will expire within WARN_BEFORE_MS,
 * or null if healthy or not found. Throttled — only warns once per session
 * until the session is renewed.
 */
export function getExpiryWarning(sessionKey: string, agentId = "default"): string | null {
	if (isSessionBypassed(sessionKey, agentId)) return null;
	const key = normalizeSessionKey(sessionKey);
	const mapKey = scopedSessionKey(key, agentId);
	const claim = sessions.get(mapKey);
	if (!claim) return null;
	const remaining = claim.expiresAt - Date.now();
	if (remaining <= 0) return "session has expired — reconnect to start a new session";
	if (remaining > WARN_BEFORE_MS) return null;
	if (warnedSessions.has(mapKey)) return null;
	warnedSessions.add(mapKey);
	const mins = Math.max(1, Math.round(remaining / 60_000));
	return `session expires in ~${mins} minute${mins === 1 ? "" : "s"} — consider /checkpoint`;
}

/**
 * Reset a session's TTL. Returns the new expiresAt ISO string, or null
 * if the session is not found.
 */
export function renewSession(sessionKey: string, agentId = "default"): string | null {
	const key = normalizeSessionKey(sessionKey);
	const mapKey = scopedSessionKey(key, agentId);
	const claim = sessions.get(mapKey);
	if (!claim) return null;
	// Reject renewal of already-expired sessions — caller should re-claim
	if (claim.expiresAt <= Date.now()) {
		evictExpiredSession(mapKey, claim);
		return null;
	}
	claim.expiresAt = Date.now() + STALE_SESSION_MS;
	claimStore?.upsertActive(persistedClaim(key, claim));
	// Keep bypass TTL aligned with the session TTL so bypassed sessions
	// do not leak after renewal extends the session lifetime.
	const existing = bypassedSessions.get(mapKey);
	if (existing !== undefined) {
		bypassedSessions.set(mapKey, claim.expiresAt);
	}
	warnedSessions.delete(mapKey);
	logger.info("session-tracker", "Session renewed", { sessionKey: key });
	return new Date(claim.expiresAt).toISOString();
}

/**
 * Remove expired session claims and expired bypass-only entries.
 */
function cleanupStaleSessions(): void {
	const now = Date.now();
	let cleaned = 0;

	for (const [key, claim] of sessions) {
		if (now > claim.expiresAt) {
			evictExpiredSession(key, claim);
			cleaned++;
		}
	}

	for (const [key, expiresAt] of bypassedSessions) {
		if (now > expiresAt) {
			bypassedSessions.delete(key);
			cleaned++;
		}
	}

	for (const [key, ended] of endedSessions) {
		if (now > ended.expiresAt) {
			endedSessions.delete(key);
			cleaned++;
		}
	}

	if (cleaned > 0) {
		logger.info("session-tracker", "Cleaned stale sessions", {
			cleaned,
			remaining: sessions.size,
			bypassOnly: bypassedSessions.size,
		});
	}
}

/** Exposed for tests — runs the cleanup cycle synchronously. */
export function runStaleCleanup(): void {
	cleanupStaleSessions();
}

/** Start periodic stale-session cleanup. */
export function startSessionCleanup(): void {
	// Set flag before setInterval so concurrent callers see it immediately.
	if (cleanupStarted) return;
	cleanupStarted = true;
	cleanupTimer = setInterval(cleanupStaleSessions, CLEANUP_INTERVAL_MS);
}

/** Register the durable claim store after database migrations complete. */
export function setSessionClaimStore(store: SessionClaimStore | null): void {
	claimStore = store;
}

/**
 * Rehydrate claims left by a previous daemon process. Expired rows are sent
 * through the same finalizer as in-process TTL cleanup; ended rows restore the
 * short duplicate-end tombstone without claiming the session again.
 */
export function restorePersistedSessions(): {
	readonly active: number;
	readonly expired: number;
	readonly ended: number;
} {
	if (!claimStore) return { active: 0, expired: 0, ended: 0 };
	const now = Date.now();
	let active = 0;
	let expired = 0;
	let ended = 0;
	for (const row of claimStore.list()) {
		const expiresAt = Date.parse(row.expiresAt);
		if (!Number.isFinite(expiresAt)) {
			claimStore.markExpired(row.sessionKey, row.agentId);
			expired++;
			continue;
		}
		const mapKey = scopedSessionKey(row.sessionKey, row.agentId);
		if (row.state === "ended") {
			if (expiresAt <= now || !row.endedAt) {
				claimStore.remove(row.sessionKey, row.agentId);
				continue;
			}
			endedSessions.set(mapKey, {
				agentId: row.agentId,
				runtimePath: row.runtimePath ?? undefined,
				endedAt: row.endedAt,
				expiresAt,
			});
			ended++;
			continue;
		}
		if (row.runtimePath === null) {
			claimStore.remove(row.sessionKey, row.agentId);
			expired++;
			continue;
		}

		const claim: SessionClaim = {
			claimId: Symbol("session-claim"),
			sessionKey: row.sessionKey,
			agentId: row.agentId,
			runtimePath: row.runtimePath,
			harness: row.harness ?? undefined,
			claimedAt: row.claimedAt,
			expiresAt,
		};
		sessions.set(mapKey, claim);
		if (expiresAt <= now || row.state === "expired") {
			evictExpiredSession(mapKey, claim, row.state !== "expired");
			expired++;
		} else {
			active++;
		}
	}
	return { active, expired, ended };
}

/** Stop periodic cleanup (for graceful shutdown). */
export function stopSessionCleanup(): void {
	cleanupStarted = false;
	if (cleanupTimer) {
		clearInterval(cleanupTimer);
		cleanupTimer = null;
	}
}

/** Exposed for tests to verify module imports do not start cleanup side effects. */
export function isSessionCleanupRunning(): boolean {
	return cleanupStarted;
}

/** Release all active sessions (for graceful shutdown). */
export function releaseAllSessions(): number {
	const count = sessions.size;
	sessions.clear();
	bypassedSessions.clear();
	if (count > 0) {
		logger.info("session-tracker", "Released all sessions for shutdown", { count });
	}
	return count;
}

/** Number of active sessions (for diagnostics). */
export function activeSessionCount(): number {
	return sessions.size;
}

/**
 * Register the TTL-eviction lifecycle handler (or clear it with null). The
 * daemon wires this to a finalizer that checkpoints and enqueues idempotent
 * summary work before an expired session's in-memory state is dropped (#902).
 */
export function setSessionEvictionHandler(handler: SessionEvictionHandler | null): void {
	evictionHandler = handler;
}

/** Expired/unfinalized session counters for diagnostics (#902). */
export function getSessionTrackerStats(): {
	readonly active: number;
	readonly ended: number;
	readonly bypassed: number;
	readonly expired: number;
	readonly unfinalized: number;
} {
	return {
		active: sessions.size,
		ended: endedSessions.size,
		bypassed: bypassedSessions.size,
		expired: expiredCount,
		unfinalized: unfinalizedCount,
	};
}

/** Reset all sessions (for testing). */
export function resetSessions(): void {
	sessions.clear();
	endedSessions.clear();
	bypassedSessions.clear();
	warnedSessions.clear();
	evictionHandler = null;
	expiredCount = 0;
	unfinalizedCount = 0;
	resetSessionEndTelemetry();
}

/** Test-only: force a session claim's expiry so cleanup evicts it. */
export function _expireSessionForTest(sessionKey: string, agentId = "default"): void {
	const key = normalizeSessionKey(sessionKey);
	const claim = sessions.get(scopedSessionKey(key, agentId));
	if (claim) claim.expiresAt = Date.now() - 1;
}
