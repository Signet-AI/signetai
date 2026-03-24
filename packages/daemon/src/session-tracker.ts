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
	readonly runtimePath: RuntimePath;
	readonly claimedAt: string;
	readonly expiresAt: string;
	readonly bypassed: boolean;
}

interface SessionClaim {
	readonly runtimePath: RuntimePath;
	readonly claimedAt: string;
	expiresAt: number;
}

type ClaimResult = { readonly ok: true } | { readonly ok: false; readonly claimedBy: RuntimePath };

const STALE_SESSION_MS = 4 * 60 * 60 * 1000; // 4 hours
const CLEANUP_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const WARN_BEFORE_MS = 30 * 60 * 1000; // warn 30 min before expiry

const sessions = new Map<string, SessionClaim>();
const bypassedSessions = new Set<string>();
/** Sessions that have already received an expiry warning — avoid per-hook spam. */
const warnedSessions = new Set<string>();
let cleanupTimer: ReturnType<typeof setInterval> | null = null;
// Synchronous guard — prevents double-start during concurrent async init.
let cleanupStarted = false;

/**
 * Claim a session for a given runtime path. Returns ok:true if the
 * session is unclaimed or already claimed by the same path. Returns
 * ok:false with claimedBy if claimed by the other path.
 */
export function claimSession(sessionKey: string, runtimePath: RuntimePath): ClaimResult {
	const existing = sessions.get(sessionKey);

	if (existing) {
		if (existing.runtimePath === runtimePath) {
			// Same path reclaiming — refresh expiry
			existing.expiresAt = Date.now() + STALE_SESSION_MS;
			return { ok: true };
		}

		// Check if the existing claim is stale
		if (Date.now() > existing.expiresAt) {
			logger.info("session-tracker", "Evicting stale session claim", {
				sessionKey,
				previousPath: existing.runtimePath,
				newPath: runtimePath,
			});
			sessions.delete(sessionKey);
			// Fall through to create new claim
		} else {
			return { ok: false, claimedBy: existing.runtimePath };
		}
	}

	sessions.set(sessionKey, {
		runtimePath,
		claimedAt: new Date().toISOString(),
		expiresAt: Date.now() + STALE_SESSION_MS,
	});

	logger.info("session-tracker", "Session claimed", {
		sessionKey,
		runtimePath,
	});

	return { ok: true };
}

/**
 * Release a session claim. Called on session-end.
 * Also cleans up bypass state for the session.
 */
export function releaseSession(sessionKey: string): void {
	const removed = sessions.delete(sessionKey);
	bypassedSessions.delete(sessionKey);
	warnedSessions.delete(sessionKey);
	if (removed) {
		logger.info("session-tracker", "Session released", { sessionKey });
	}
}

/**
 * Return true if the session is currently claimed and not stale.
 * Used by hooks to detect daemon-restart mid-session.
 */
export function hasSession(sessionKey: string): boolean {
	const claim = sessions.get(sessionKey);
	if (!claim) return false;
	if (Date.now() > claim.expiresAt) {
		sessions.delete(sessionKey);
		bypassedSessions.delete(sessionKey);
		return false;
	}
	return true;
}

/**
 * Get the runtime path for a session, if claimed.
 */
export function getSessionPath(sessionKey: string): RuntimePath | undefined {
	const claim = sessions.get(sessionKey);
	if (!claim) return undefined;

	if (Date.now() > claim.expiresAt) {
		sessions.delete(sessionKey);
		bypassedSessions.delete(sessionKey);
		return undefined;
	}

	return claim.runtimePath;
}

// ---------------------------------------------------------------------------
// Bypass state
// ---------------------------------------------------------------------------

/** Enable bypass for a session — hooks return empty no-op responses. */
export function bypassSession(sessionKey: string): boolean {
	if (!sessions.has(sessionKey)) {
		logger.warn("session-tracker", "Bypass requested for unknown session", { sessionKey });
		return false;
	}
	bypassedSessions.add(sessionKey);
	logger.info("session-tracker", "Session bypassed", { sessionKey });
	return true;
}

/** Disable bypass for a session — hooks resume normal behavior. */
export function unbypassSession(sessionKey: string): void {
	const removed = bypassedSessions.delete(sessionKey);
	if (removed) {
		logger.info("session-tracker", "Session bypass removed", { sessionKey });
	}
}

/** Check whether a session is currently bypassed. */
export function isSessionBypassed(sessionKey: string): boolean {
	return bypassedSessions.has(sessionKey);
}

/** Get the set of all bypassed session keys. */
export function getBypassedSessionKeys(): ReadonlySet<string> {
	return bypassedSessions;
}

/** List all active sessions with full state. */
export function getActiveSessions(): readonly SessionInfo[] {
	const now = Date.now();
	const result: SessionInfo[] = [];

	for (const [key, claim] of sessions) {
		if (now > claim.expiresAt) {
			sessions.delete(key);
			bypassedSessions.delete(key);
			continue;
		}
		result.push({
			key,
			runtimePath: claim.runtimePath,
			claimedAt: claim.claimedAt,
			expiresAt: new Date(claim.expiresAt).toISOString(),
			bypassed: bypassedSessions.has(key),
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
	const claim = sessions.get(sessionKey);
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
	const claim = sessions.get(sessionKey);
	if (!claim) return null;
	// Reject renewal of already-expired sessions — caller should re-claim
	if (claim.expiresAt <= Date.now()) {
		sessions.delete(sessionKey);
		bypassedSessions.delete(sessionKey);
		warnedSessions.delete(sessionKey);
		return null;
	}
	claim.expiresAt = Date.now() + STALE_SESSION_MS;
	warnedSessions.delete(sessionKey);
	logger.info("session-tracker", "Session renewed", { sessionKey });
	return new Date(claim.expiresAt).toISOString();
}

/**
 * Remove expired session claims.
 */
function cleanupStaleSessions(): void {
	const now = Date.now();
	let cleaned = 0;

	for (const [key, claim] of sessions) {
		if (now > claim.expiresAt) {
			sessions.delete(key);
			bypassedSessions.delete(key);
			warnedSessions.delete(key);
			cleaned++;
			logger.warn("session-tracker", "Session evicted (TTL expired)", {
				sessionKey: key,
				runtimePath: claim.runtimePath,
				claimedAt: claim.claimedAt,
			});
		}
	}

	if (cleaned > 0) {
		logger.info("session-tracker", "Cleaned stale sessions", {
			cleaned,
			remaining: sessions.size,
		});
	}
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

/** Reset all sessions (for testing). */
export function resetSessions(): void {
	sessions.clear();
	bypassedSessions.clear();
	warnedSessions.clear();
}
