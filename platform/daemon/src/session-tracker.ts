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
	readonly agentId: string;
	readonly runtimePath: RuntimePath;
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
export type SessionEvictionHandler = (info: EvictedSessionInfo) => "finalized" | "skipped" | undefined;

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
let expiredCount = 0;
let unfinalizedCount = 0;

export function normalizeSessionKey(sessionKey: string): string {
	const trimmed = sessionKey.trim();
	if (trimmed.startsWith("session:")) {
		return trimmed.slice("session:".length);
	}
	return trimmed;
}

function evictExpiredSession(key: string, claim: SessionClaim): void {
	if (!sessions.delete(key)) return;
	bypassedSessions.delete(key);
	warnedSessions.delete(key);
	expiredCount++;
	logger.warn("session-tracker", "Session evicted (TTL expired)", {
		sessionKey: key,
		runtimePath: claim.runtimePath,
		claimedAt: claim.claimedAt,
	});

	if (!evictionHandler) return;
	try {
		const outcome = evictionHandler({
			sessionKey: key,
			agentId: claim.agentId,
			runtimePath: claim.runtimePath,
			claimedAt: claim.claimedAt,
		});
		if (outcome === "skipped") unfinalizedCount++;
	} catch (err) {
		unfinalizedCount++;
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
export function claimSession(sessionKey: string, runtimePath: RuntimePath, agentId = "default"): ClaimResult {
	const key = normalizeSessionKey(sessionKey);
	const existing = sessions.get(key);
	endedSessions.delete(key);

	if (existing) {
		if (existing.runtimePath === runtimePath) {
			// Same path reclaiming — refresh expiry
			existing.expiresAt = Date.now() + STALE_SESSION_MS;
			return { ok: true };
		}

		// Check if the existing claim is stale
		if (Date.now() > existing.expiresAt) {
			logger.info("session-tracker", "Evicting stale session claim", {
				sessionKey: key,
				previousPath: existing.runtimePath,
				newPath: runtimePath,
			});
			evictExpiredSession(key, existing);
			// Fall through to create new claim
		} else {
			return { ok: false, claimedBy: existing.runtimePath };
		}
	}

	sessions.set(key, {
		agentId,
		runtimePath,
		claimedAt: new Date().toISOString(),
		expiresAt: Date.now() + STALE_SESSION_MS,
	});

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
export function releaseSession(sessionKey: string): void {
	const key = normalizeSessionKey(sessionKey);
	const removed = sessions.delete(key);
	bypassedSessions.delete(key);
	warnedSessions.delete(key);
	if (removed) {
		logger.info("session-tracker", "Session released", { sessionKey: key });
	}
}

export function markSessionEnded(sessionKey: string, runtimePath?: RuntimePath): void {
	const key = normalizeSessionKey(sessionKey);
	releaseSession(key);
	endedSessions.set(key, {
		runtimePath,
		endedAt: new Date().toISOString(),
		expiresAt: Date.now() + ENDED_SESSION_TOMBSTONE_MS,
	});
	logger.info("session-tracker", "Session ended", {
		sessionKey: key,
		runtimePath,
	});
}

/**
 * Return true if the session is currently claimed and not stale.
 * Used by hooks to detect daemon-restart mid-session.
 */
export function hasSession(sessionKey: string): boolean {
	const key = normalizeSessionKey(sessionKey);
	const claim = sessions.get(key);
	if (!claim) return false;
	if (Date.now() > claim.expiresAt) {
		evictExpiredSession(key, claim);
		return false;
	}
	return true;
}

/**
 * Get the runtime path for a session, if claimed.
 */
export function getSessionPath(sessionKey: string): RuntimePath | undefined {
	const key = normalizeSessionKey(sessionKey);
	const claim = sessions.get(key);
	if (!claim) return undefined;

	if (Date.now() > claim.expiresAt) {
		evictExpiredSession(key, claim);
		return undefined;
	}

	return claim.runtimePath;
}

export function getEndedSession(sessionKey: string): EndedSessionInfo | undefined {
	const key = normalizeSessionKey(sessionKey);
	const ended = endedSessions.get(key);
	if (!ended) return undefined;

	if (Date.now() > ended.expiresAt) {
		endedSessions.delete(key);
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
): boolean {
	const key = normalizeSessionKey(sessionKey);
	if (!sessions.has(key) && opts?.allowUnknown !== true) {
		logger.warn("session-tracker", "Bypass requested for unknown session", { sessionKey: key });
		return false;
	}
	const ttlMs = opts?.ttlMs;
	const ttl = typeof ttlMs === "number" && Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : STALE_SESSION_MS;
	bypassedSessions.set(key, Date.now() + ttl);
	logger.debug("session-tracker", "Session bypassed", { sessionKey: key });
	return true;
}

/** Disable bypass for a session — hooks resume normal behavior. */
export function unbypassSession(sessionKey: string): void {
	const key = normalizeSessionKey(sessionKey);
	const removed = bypassedSessions.delete(key);
	if (removed) {
		logger.debug("session-tracker", "Session bypass removed", { sessionKey: key });
	}
}

/** Check whether a session is currently bypassed. */
export function isSessionBypassed(sessionKey: string): boolean {
	const key = normalizeSessionKey(sessionKey);
	const expiresAt = bypassedSessions.get(key);
	if (expiresAt === undefined) return false;
	if (Date.now() > expiresAt) {
		bypassedSessions.delete(key);
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

	for (const [key, claim] of sessions) {
		if (now > claim.expiresAt) {
			evictExpiredSession(key, claim);
			continue;
		}
		result.push({
			key,
			agentId: claim.agentId,
			runtimePath: claim.runtimePath,
			claimedAt: claim.claimedAt,
			expiresAt: new Date(claim.expiresAt).toISOString(),
			bypassed: isSessionBypassed(key),
		});
	}

	return result;
}

/**
 * Returns a warning string if the session will expire within WARN_BEFORE_MS,
 * or null if healthy or not found. Throttled — only warns once per session
 * until the session is renewed.
 */
export function getExpiryWarning(sessionKey: string): string | null {
	if (isSessionBypassed(sessionKey)) return null;
	const key = normalizeSessionKey(sessionKey);
	const claim = sessions.get(key);
	if (!claim) return null;
	const remaining = claim.expiresAt - Date.now();
	if (remaining <= 0) return "session has expired — reconnect to start a new session";
	if (remaining > WARN_BEFORE_MS) return null;
	if (warnedSessions.has(sessionKey)) return null;
	warnedSessions.add(sessionKey);
	const mins = Math.max(1, Math.round(remaining / 60_000));
	return `session expires in ~${mins} minute${mins === 1 ? "" : "s"} — consider /checkpoint`;
}

/**
 * Reset a session's TTL. Returns the new expiresAt ISO string, or null
 * if the session is not found.
 */
export function renewSession(sessionKey: string): string | null {
	const key = normalizeSessionKey(sessionKey);
	const claim = sessions.get(key);
	if (!claim) return null;
	// Reject renewal of already-expired sessions — caller should re-claim
	if (claim.expiresAt <= Date.now()) {
		evictExpiredSession(key, claim);
		return null;
	}
	claim.expiresAt = Date.now() + STALE_SESSION_MS;
	// Keep bypass TTL aligned with the session TTL so bypassed sessions
	// do not leak after renewal extends the session lifetime.
	const existing = bypassedSessions.get(key);
	if (existing !== undefined) {
		bypassedSessions.set(key, claim.expiresAt);
	}
	warnedSessions.delete(key);
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
}

/** Test-only: force a session claim's expiry so cleanup evicts it. */
export function _expireSessionForTest(sessionKey: string): void {
	const key = normalizeSessionKey(sessionKey);
	const claim = sessions.get(key);
	if (claim) claim.expiresAt = Date.now() - 1;
}
