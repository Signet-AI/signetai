/**
 * Session Tracker
 *
 * Lightweight in-memory tracker that ensures exactly one runtime path
 * (plugin or legacy-hook) is active per session. Prevents duplicate
 * capture/recall when both paths are configured.
 */

import { logger } from "./logger";

export type RuntimePath = "plugin" | "legacy";

interface SessionClaim {
	readonly runtimePath: RuntimePath;
	readonly claimedAt: string;
	expiresAt: number;
}

type ClaimResult =
	| { readonly ok: true }
	| { readonly ok: false; readonly claimedBy: RuntimePath };

const STALE_SESSION_MS = 4 * 60 * 60 * 1000; // 4 hours
const CLEANUP_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

const sessions = new Map<string, SessionClaim>();
let cleanupTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Claim a session for a given runtime path. Returns ok:true if the
 * session is unclaimed or already claimed by the same path. Returns
 * ok:false with claimedBy if claimed by the other path.
 */
export function claimSession(
	sessionKey: string,
	runtimePath: RuntimePath,
): ClaimResult {
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
 */
export function releaseSession(sessionKey: string): void {
	const removed = sessions.delete(sessionKey);
	if (removed) {
		logger.info("session-tracker", "Session released", { sessionKey });
	}
}

/**
 * Get the runtime path for a session, if claimed.
 */
export function getSessionPath(
	sessionKey: string,
): RuntimePath | undefined {
	const claim = sessions.get(sessionKey);
	if (!claim) return undefined;

	if (Date.now() > claim.expiresAt) {
		sessions.delete(sessionKey);
		return undefined;
	}

	return claim.runtimePath;
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
			cleaned++;
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
	if (cleanupTimer) return;
	cleanupTimer = setInterval(cleanupStaleSessions, CLEANUP_INTERVAL_MS);
}

/** Stop periodic cleanup (for graceful shutdown). */
export function stopSessionCleanup(): void {
	if (cleanupTimer) {
		clearInterval(cleanupTimer);
		cleanupTimer = null;
	}
}

/** Number of active sessions (for diagnostics). */
export function activeSessionCount(): number {
	return sessions.size;
}

/** Reset all sessions (for testing). */
export function resetSessions(): void {
	sessions.clear();
}
