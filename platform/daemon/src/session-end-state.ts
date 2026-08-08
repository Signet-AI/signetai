import { createHash } from "node:crypto";
import { resolveAgentId } from "./agent-id";

/**
 * Session-end telemetry dedup state (#1212).
 *
 * `session.end` must fire at most once per session lifetime — at the real
 * boundary (explicit clear or TTL eviction) — so its counter stays
 * comparable with the dedup'd `session.start`. Hook state is in-memory and
 * intentionally fail-open on daemon restart, mirroring session-start-state.
 */

const sessionEndSeen = new Map<string, number>();
const SESSION_END_SEEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SESSION_BOUNDARY_REASONS = new Set([
	"clear",
	"session.deleted",
	"session_branch",
	"session_fork",
	"session_shutdown",
	"session_switch",
]);

export type SessionEndIdentity = {
	readonly harness?: string;
	readonly agentId?: string;
	readonly sessionKey?: string;
	readonly sessionId?: string;
};

/** Return the canonical boundary reason, or null for ordinary hook calls. */
export function normalizeSessionBoundaryReason(reason: unknown): string | null {
	if (typeof reason !== "string") return null;
	const normalized = reason.trim().toLowerCase();
	return SESSION_BOUNDARY_REASONS.has(normalized) ? normalized : null;
}

/**
 * Normalize a session key: trim and strip the "session:" prefix harnesses
 * send (e.g. openclaw). The dedup map and the anonymous hash MUST use the
 * same normalized identity as the session tracker, or a "session:abc" key
 * on the clear path would diverge from the eviction path's "abc" — double-
 * counting the same lifetime and producing unjoinable hashes (#1212).
 */
export function normalizeSessionKey(sessionKey: string): string {
	const trimmed = sessionKey.trim();
	if (trimmed.startsWith("session:")) {
		return trimmed.slice("session:".length);
	}
	return trimmed;
}

function sessionEndDedupeKey(identity: SessionEndIdentity): string | null {
	const sessionKey = identity.sessionKey ?? identity.sessionId;
	if (!sessionKey) return null;
	const normalized = normalizeSessionKey(sessionKey);
	if (normalized.length === 0) return null;
	return [
		resolveAgentId({ agentId: identity.agentId, sessionKey: normalized }),
		identity.harness ?? "",
		normalized,
	].join("\0");
}

/** Anonymous per-session key for telemetry — hashed, never raw. */
export function hashSessionKey(sessionKey: string | undefined): string | null {
	if (!sessionKey) return null;
	const normalized = normalizeSessionKey(sessionKey);
	if (normalized.length === 0) return null;
	return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

export function pruneSessionEndTelemetry(now = Date.now()): void {
	for (const [key, seenAt] of sessionEndSeen.entries()) {
		if (now - seenAt > SESSION_END_SEEN_TTL_MS) sessionEndSeen.delete(key);
	}
}

export function hasSessionEndTelemetry(identity: SessionEndIdentity): boolean {
	const key = sessionEndDedupeKey(identity);
	return key !== null && sessionEndSeen.has(key);
}

export function markSessionEndTelemetry(identity: SessionEndIdentity, seenAt = Date.now()): void {
	const key = sessionEndDedupeKey(identity);
	if (key) sessionEndSeen.set(key, seenAt);
}

/** Clear the end-telemetry marker when a session lifetime begins anew. */
export function clearSessionEndTelemetry(identity: SessionEndIdentity): void {
	const key = sessionEndDedupeKey(identity);
	if (key) sessionEndSeen.delete(key);
}

/** Reset all markers (for tests). */
export function resetSessionEndTelemetry(): void {
	sessionEndSeen.clear();
}
