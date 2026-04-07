import { readTrimmedString } from "./helpers.js";

export const MAX_PENDING_SESSIONS = 64;
export const MAX_PENDING_PER_SESSION = 4;
export const MAX_ENDED_SESSIONS = 128;

export function sanitizeInject(inject: string): string {
	return inject.replace(/<\/signet-memory>/gi, "<\\/signet-memory>");
}

export function evictOldestKey<V>(map: Map<string, V>, maxSize: number): void {
	if (map.size < maxSize) return;
	const oldest = map.keys().next().value;
	if (oldest !== undefined) map.delete(oldest);
}

export interface PendingSessionEnd {
	readonly sessionId: string;
	readonly sessionFile: string;
	readonly agentId: string | undefined;
	readonly reason: string;
}

export interface BaseSessionState {
	setActiveSession(sessionId: string | undefined, sessionFile: string | undefined): void;
	getActiveSessionId(): string | undefined;
	getActiveSessionFile(): string | undefined;
	setSessionContext(context: string): void;
	getSessionContext(): string;
	markSessionEnded(sessionId: string | undefined): void;
	clearSessionEnded(sessionId: string | undefined): void;
	sessionAlreadyEnded(sessionId: string | undefined): boolean;
	setPendingSessionContext(sessionId: string | undefined, inject: string | undefined): void;
	clearPendingSessionContext(sessionId: string | undefined): void;
	queuePendingRecall(sessionId: string, inject: string): void;
	clearPendingRecall(sessionId: string | undefined): void;
	clearPendingSessionData(sessionId: string | undefined): void;
	hasPendingRecall(sessionId: string | undefined): boolean;
	consumePendingRecall(sessionId: string | undefined): string | undefined;
	queuePendingSessionEnd(sessionId: string, sessionFile: string, agentId: string | undefined, reason: string): void;
	clearPendingSessionEnd(sessionId: string | undefined): void;
	getPendingSessionEnds(): ReadonlyArray<PendingSessionEnd>;
}

export class BaseSessionStateStore implements BaseSessionState {
	protected readonly pendingSessionContext = new Map<string, string>();
	protected readonly pendingRecall = new Map<string, string[]>();
	private readonly pendingSessionEnds = new Map<string, PendingSessionEnd>();
	private readonly endedSessions = new Map<string, number>();

	private activeSessionId: string | undefined;
	private activeSessionFile: string | undefined;
	private sessionContext = "";

	setActiveSession(sessionId: string | undefined, sessionFile: string | undefined): void {
		this.activeSessionId = sessionId;
		this.activeSessionFile = sessionFile;
	}

	getActiveSessionId(): string | undefined {
		return this.activeSessionId;
	}

	getActiveSessionFile(): string | undefined {
		return this.activeSessionFile;
	}

	setSessionContext(context: string): void {
		this.sessionContext = context;
	}

	getSessionContext(): string {
		return this.sessionContext;
	}

	markSessionEnded(sessionId: string | undefined): void {
		if (!sessionId) return;
		if (!this.endedSessions.has(sessionId)) {
			evictOldestKey(this.endedSessions, MAX_ENDED_SESSIONS);
		}
		this.endedSessions.set(sessionId, Date.now());
	}

	clearSessionEnded(sessionId: string | undefined): void {
		if (!sessionId) return;
		this.endedSessions.delete(sessionId);
	}

	sessionAlreadyEnded(sessionId: string | undefined): boolean {
		if (!sessionId) return false;
		return this.endedSessions.has(sessionId);
	}

	setPendingSessionContext(sessionId: string | undefined, inject: string | undefined): void {
		if (!sessionId) return;
		const trimmed = readTrimmedString(inject);
		if (trimmed) {
			this.pendingSessionContext.set(sessionId, trimmed);
			return;
		}
		this.pendingSessionContext.delete(sessionId);
	}

	clearPendingSessionContext(sessionId: string | undefined): void {
		if (!sessionId) return;
		this.pendingSessionContext.delete(sessionId);
	}

	queuePendingRecall(sessionId: string, inject: string): void {
		if (!this.pendingRecall.has(sessionId)) {
			evictOldestKey(this.pendingRecall, MAX_PENDING_SESSIONS);
		}

		const queue = this.pendingRecall.get(sessionId) ?? [];
		queue.push(inject);
		while (queue.length > MAX_PENDING_PER_SESSION) {
			queue.shift();
		}
		this.pendingRecall.set(sessionId, queue);
	}

	clearPendingRecall(sessionId: string | undefined): void {
		if (!sessionId) return;
		this.pendingRecall.delete(sessionId);
	}

	clearPendingSessionData(sessionId: string | undefined): void {
		if (!sessionId) return;
		this.pendingSessionContext.delete(sessionId);
		this.pendingRecall.delete(sessionId);
		this.pendingSessionEnds.delete(sessionId);
	}

	hasPendingRecall(sessionId: string | undefined): boolean {
		if (!sessionId) return false;
		const queue = this.pendingRecall.get(sessionId);
		return Array.isArray(queue) && queue.length > 0;
	}

	consumePendingRecall(sessionId: string | undefined): string | undefined {
		if (!sessionId) return undefined;
		const queue = this.pendingRecall.get(sessionId);
		if (!queue || queue.length === 0) return undefined;
		const inject = queue.shift();
		if (queue.length === 0) this.pendingRecall.delete(sessionId);
		return readTrimmedString(inject);
	}

	queuePendingSessionEnd(sessionId: string, sessionFile: string, agentId: string | undefined, reason: string): void {
		if (!this.pendingSessionEnds.has(sessionId)) {
			evictOldestKey(this.pendingSessionEnds, MAX_PENDING_SESSIONS);
		}
		this.pendingSessionEnds.set(sessionId, { sessionId, sessionFile, agentId, reason });
	}

	clearPendingSessionEnd(sessionId: string | undefined): void {
		if (!sessionId) return;
		this.pendingSessionEnds.delete(sessionId);
	}

	getPendingSessionEnds(): ReadonlyArray<PendingSessionEnd> {
		return Array.from(this.pendingSessionEnds.values());
	}
}
