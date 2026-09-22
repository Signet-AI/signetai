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
	readonly claimId: symbol;
	readonly sessionKey: string;
	readonly agentId: string;
	readonly runtimePath: RuntimePath;
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
export interface EvictedSessionInfo {
	readonly sessionKey: string;
	readonly agentId: string;
	readonly runtimePath: RuntimePath;
	readonly harness?: string;
	readonly claimedAt: string;
}
export type SessionEvictionOutcome = "finalized" | "skipped" | undefined;
export type SessionEvictionHandler = (
	info: EvictedSessionInfo,
) => SessionEvictionOutcome | Promise<SessionEvictionOutcome>;

const STALE_SESSION_MS = 4 * 60 * 60 * 1000;
const ENDED_SESSION_TOMBSTONE_MS = 30 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 15 * 60 * 1000;
const WARN_BEFORE_MS = 30 * 60 * 1000;

const sessions = new Map<string, SessionClaim>();
const endedSessions = new Map<string, EndedSession>();
const bypassedSessions = new Map<string, number>();
const warnedSessions = new Set<string>();
let cleanupTimer: ReturnType<typeof setInterval> | null = null;
let cleanupStarted = false;
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
	const isCurrentClaim = (): boolean => {
		const current = sessions.get(mapKey);
		return current === undefined || current.claimId === claim.claimId;
	};
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
			if (harness !== undefined) existing.harness = harness;
			existing.expiresAt = Date.now() + STALE_SESSION_MS;
			claimStore?.upsertActive(persistedClaim(key, existing));
			return { ok: true };
		}
		if (Date.now() > existing.expiresAt) {
			logger.info("session-tracker", "Evicting stale session claim", {
				sessionKey: key,
				previousPath: existing.runtimePath,
				newPath: runtimePath,
			});
			evictExpiredSession(mapKey, existing);
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
export function unbypassSession(sessionKey: string, agentId = "default"): void {
	const key = normalizeSessionKey(sessionKey);
	const removed = bypassedSessions.delete(scopedSessionKey(key, agentId));
	if (removed) {
		logger.debug("session-tracker", "Session bypass removed", { sessionKey: key });
	}
}
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
export function getBypassedSessionKeys(): ReadonlyMap<string, number> {
	return bypassedSessions;
}
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
export function renewSession(sessionKey: string, agentId = "default"): string | null {
	const key = normalizeSessionKey(sessionKey);
	const mapKey = scopedSessionKey(key, agentId);
	const claim = sessions.get(mapKey);
	if (!claim) return null;
	if (claim.expiresAt <= Date.now()) {
		evictExpiredSession(mapKey, claim);
		return null;
	}
	claim.expiresAt = Date.now() + STALE_SESSION_MS;
	claimStore?.upsertActive(persistedClaim(key, claim));
	const existing = bypassedSessions.get(mapKey);
	if (existing !== undefined) {
		bypassedSessions.set(mapKey, claim.expiresAt);
	}
	warnedSessions.delete(mapKey);
	logger.info("session-tracker", "Session renewed", { sessionKey: key });
	return new Date(claim.expiresAt).toISOString();
}
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
export function runStaleCleanup(): void {
	cleanupStaleSessions();
}
export function startSessionCleanup(): void {
	if (cleanupStarted) return;
	cleanupStarted = true;
	cleanupTimer = setInterval(cleanupStaleSessions, CLEANUP_INTERVAL_MS);
}
export function setSessionClaimStore(store: SessionClaimStore | null): void {
	claimStore = store;
}
function restorePersistedSessionRows(rows: readonly PersistedSessionClaim[]): {
	readonly active: number;
	readonly expired: number;
	readonly ended: number;
} {
	if (!claimStore) return { active: 0, expired: 0, ended: 0 };
	const now = Date.now();
	let active = 0;
	let expired = 0;
	let ended = 0;
	for (const row of rows) {
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

async function persistExpiredClaimAsync(sessionKey: string, agentId: string): Promise<void> {
	if (claimStore?.markExpiredAsync) {
		await claimStore.markExpiredAsync(sessionKey, agentId);
		return;
	}
	claimStore?.markExpired(sessionKey, agentId);
}

async function removePersistedClaimAsync(sessionKey: string, agentId: string): Promise<void> {
	if (claimStore?.removeAsync) {
		await claimStore.removeAsync(sessionKey, agentId);
		return;
	}
	claimStore?.remove(sessionKey, agentId);
}
async function evictRestoredSessionAsync(mapKey: string, claim: SessionClaim, emitEndTelemetry = true): Promise<void> {
	if (!sessions.delete(mapKey)) return;
	const key = claim.sessionKey;
	bypassedSessions.delete(mapKey);
	warnedSessions.delete(mapKey);
	expiredCount++;
	logger.warn("session-tracker", "Session evicted (TTL expired)", {
		sessionKey: key,
		runtimePath: claim.runtimePath,
		claimedAt: claim.claimedAt,
	});
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
		await persistExpiredClaimAsync(key, claim.agentId);
		return;
	}
	const isCurrentClaim = (): boolean => {
		const current = sessions.get(mapKey);
		return current === undefined || current.claimId === claim.claimId;
	};
	let outcome: SessionEvictionOutcome;
	try {
		outcome = await evictionHandler({
			sessionKey: key,
			agentId: claim.agentId,
			runtimePath: claim.runtimePath,
			harness: claim.harness,
			claimedAt: claim.claimedAt,
		});
	} catch (err) {
		unfinalizedCount++;
		if (isCurrentClaim()) await persistExpiredClaimAsync(key, claim.agentId);
		logger.warn("session-tracker", "Async session eviction handler failed", {
			sessionKey: key,
			error: err instanceof Error ? err.message : String(err),
		});
		return;
	}
	if (outcome === "skipped") unfinalizedCount++;
	if (!isCurrentClaim()) return;
	if (outcome === "finalized") await removePersistedClaimAsync(key, claim.agentId);
	else await persistExpiredClaimAsync(key, claim.agentId);
}

async function restorePersistedSessionRowsAsync(rows: readonly PersistedSessionClaim[]): Promise<{
	readonly active: number;
	readonly expired: number;
	readonly ended: number;
}> {
	if (!claimStore) return { active: 0, expired: 0, ended: 0 };
	const now = Date.now();
	let active = 0;
	let expired = 0;
	let ended = 0;
	for (const row of rows) {
		const expiresAt = Date.parse(row.expiresAt);
		if (!Number.isFinite(expiresAt)) {
			await persistExpiredClaimAsync(row.sessionKey, row.agentId);
			expired++;
			continue;
		}
		const mapKey = scopedSessionKey(row.sessionKey, row.agentId);
		if (row.state === "ended") {
			if (expiresAt <= now || !row.endedAt) {
				await removePersistedClaimAsync(row.sessionKey, row.agentId);
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
			await removePersistedClaimAsync(row.sessionKey, row.agentId);
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
			await evictRestoredSessionAsync(mapKey, claim, row.state !== "expired");
			expired++;
		} else {
			active++;
		}
	}
	return { active, expired, ended };
}

export function restorePersistedSessions(): {
	readonly active: number;
	readonly expired: number;
	readonly ended: number;
} {
	if (!claimStore) return { active: 0, expired: 0, ended: 0 };
	return restorePersistedSessionRows(claimStore.list());
}
export async function restorePersistedSessionsAsync(): Promise<{
	readonly active: number;
	readonly expired: number;
	readonly ended: number;
}> {
	if (!claimStore) return { active: 0, expired: 0, ended: 0 };
	const rows = claimStore.listAsync ? await claimStore.listAsync() : claimStore.list();
	return await restorePersistedSessionRowsAsync(rows);
}
export function stopSessionCleanup(): void {
	cleanupStarted = false;
	if (cleanupTimer) {
		clearInterval(cleanupTimer);
		cleanupTimer = null;
	}
}
export function isSessionCleanupRunning(): boolean {
	return cleanupStarted;
}
export function releaseAllSessions(): number {
	const count = sessions.size;
	sessions.clear();
	bypassedSessions.clear();
	if (count > 0) {
		logger.info("session-tracker", "Released all sessions for shutdown", { count });
	}
	return count;
}
export function activeSessionCount(): number {
	return sessions.size;
}
export function setSessionEvictionHandler(handler: SessionEvictionHandler | null): void {
	evictionHandler = handler;
}
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
export function _expireSessionForTest(sessionKey: string, agentId = "default"): void {
	const key = normalizeSessionKey(sessionKey);
	const claim = sessions.get(scopedSessionKey(key, agentId));
	if (claim) claim.expiresAt = Date.now() - 1;
}
