import { resolveAgentId } from "./agent-id";

// Hook dedup state is in-memory and intentionally fail-open on daemon restart.
const sessionStartSeen = new Map<string, number>();
const SESSION_START_SEEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type SessionStartIdentity = {
	readonly harness?: string;
	readonly agentId?: string;
	readonly project?: string;
	readonly cwd?: string;
	readonly sessionKey?: string;
	readonly sessionId?: string;
};

export type SessionStartRecallIdentity = Omit<SessionStartIdentity, "agentId">;

function sessionStartDedupeKey(req: SessionStartIdentity): string | null {
	const sessionKey = req.sessionKey || req.sessionId;
	if (!sessionKey) return null;
	return [
		resolveAgentId({ agentId: req.agentId, sessionKey }),
		req.harness ?? "",
		req.project ?? req.cwd ?? "",
		sessionKey,
	].join("\0");
}

export function sessionStartRecallKey(req: SessionStartRecallIdentity): string | null {
	const sessionKey = req.sessionKey || req.sessionId;
	if (!sessionKey) return null;
	return [req.harness ?? "", req.project ?? req.cwd ?? "", sessionKey].join("\0");
}

export function pruneSessionStartDedupe(now = Date.now()): void {
	for (const [sessionKey, seenAt] of sessionStartSeen.entries()) {
		if (now - seenAt > SESSION_START_SEEN_TTL_MS) sessionStartSeen.delete(sessionKey);
	}
}

export function hasSessionStartDedupe(req: SessionStartIdentity): boolean {
	const key = sessionStartDedupeKey(req);
	return key !== null && sessionStartSeen.has(key);
}

export function markSessionStartDedupe(req: SessionStartIdentity, seenAt = Date.now()): void {
	const key = sessionStartDedupeKey(req);
	if (key) sessionStartSeen.set(key, seenAt);
}

export function clearSessionStartDedupe(req: SessionStartIdentity): void {
	const key = sessionStartDedupeKey(req);
	if (key) sessionStartSeen.delete(key);
}

export function clearRawSessionStartDedupeKey(sessionKey: string | undefined): void {
	if (sessionKey) sessionStartSeen.delete(sessionKey);
}

export { clearSessionStartDedupe as resetSessionStartDedupe };
