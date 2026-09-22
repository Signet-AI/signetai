import { createHash } from "node:crypto";
import { resolveAgentId } from "./agent-id";

const sessionEndSeen = new Map<string, number>();
const SESSION_END_SEEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SESSION_BOUNDARY_REASONS = new Set([
	"clear",
	"session.deleted",
	"session_branch",
	"session_fork",
	"session_shutdown",
	"session_switch",
	"stale-session-sweep",
]);

export type SessionEndIdentity = {
	readonly harness?: string;
	readonly agentId?: string;
	readonly sessionKey?: string;
	readonly sessionId?: string;
};
export function normalizeSessionBoundaryReason(reason: unknown): string | null {
	if (typeof reason !== "string") return null;
	const normalized = reason.trim().toLowerCase();
	return SESSION_BOUNDARY_REASONS.has(normalized) ? normalized : null;
}
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
	return [resolveAgentId({ agentId: identity.agentId, sessionKey: normalized }), normalized].join("\0");
}
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
export function clearSessionEndTelemetry(identity: SessionEndIdentity): void {
	const key = sessionEndDedupeKey(identity);
	if (key) sessionEndSeen.delete(key);
}
export function resetSessionEndTelemetry(): void {
	sessionEndSeen.clear();
}
