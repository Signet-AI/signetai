import { registerDbAccessorCloseParticipant } from "./db-accessor-lifecycle";
import { dbOwnerBatch, dbOwnerQuery, ownerStatement } from "./db-owner-runtime";
import {
	type AgentMessage,
	type CrossAgentMessageRow,
	getAgentPresenceForSession,
	isDirectAgentMessage,
	rowToAgentMessage,
	subscribeCrossAgentEvents,
} from "./cross-agent";
import { formatWakeInject, projectNotificationMessage } from "./notifications/cross-agent-notifications";
import type { HookNotificationItem } from "./notifications/cross-agent-notifications";

export const MAX_WAKE_WAIT_MS = 25_000;
export const WAKE_RATE_LIMIT_PER_HOUR = 30;
const WAKE_RATE_WINDOW_MS = 60 * 60 * 1000;
const MAX_WAKE_BATCH = 10;
const MAX_TRACKED_SESSIONS = 10_000;

export type WakeWaitResult =
	| {
			readonly wake: true;
			readonly inject: string;
			readonly messageIds: readonly string[];
			readonly notifications: { readonly items: readonly HookNotificationItem[] };
	  }
	| {
			readonly wake: false;
			readonly reason: "timeout" | "superseded" | "rate_limited" | "aborted" | "closed";
			readonly retryAfterMs?: number;
	  };

export interface WakeWaitInput {
	readonly agentId: string;
	readonly sessionKey: string;
	readonly harness: string;
	readonly waitMs: number;
	readonly signal?: AbortSignal;
	readonly nowMs?: number;
}

interface Waiter {
	readonly id: number;
	readonly agentId: string;
	readonly sessionKey: string;
	readonly harness: string;
	readonly finish: (result: WakeWaitResult) => void;
	claiming: boolean;
	rerun: boolean;
	done: boolean;
}

const waiters = new Map<string, Waiter>();
const wakeTimes = new Map<string, number[]>();
let nextWaiterId = 1;
let unsubscribe: (() => void) | null = null;

function recentWakes(sessionKey: string, nowMs: number): number[] {
	const times = (wakeTimes.get(sessionKey) ?? []).filter((at) => nowMs - at < WAKE_RATE_WINDOW_MS);
	if (times.length === 0) wakeTimes.delete(sessionKey);
	else wakeTimes.set(sessionKey, times);
	return times;
}

function rateLimitRetryAfter(sessionKey: string, nowMs: number): number | null {
	const times = recentWakes(sessionKey, nowMs);
	if (times.length < WAKE_RATE_LIMIT_PER_HOUR) return null;
	const oldest = times[0] ?? nowMs;
	return Math.max(1_000, WAKE_RATE_WINDOW_MS - (nowMs - oldest));
}

function recordWake(sessionKey: string, nowMs: number): void {
	const times = recentWakes(sessionKey, nowMs);
	times.push(nowMs);
	wakeTimes.set(sessionKey, times);
	if (wakeTimes.size > MAX_TRACKED_SESSIONS) {
		const oldestKey = wakeTimes.keys().next().value;
		if (oldestKey !== undefined) wakeTimes.delete(oldestKey);
	}
}

const CLAIMABLE_SQL = `SELECT m.*, NULL AS acknowledged_at
	FROM cross_agent_messages m
	LEFT JOIN cross_agent_message_wakes w ON w.message_id = m.id
	LEFT JOIN cross_agent_message_receipts r ON r.message_id = m.id AND r.agent_id = ?
	WHERE m.delivery_path = 'local'
	  AND m.broadcast = 0
	  AND m.expires_at > ?
	  AND w.message_id IS NULL
	  AND r.acknowledged_at IS NULL
	  AND (m.from_session_key IS NULL OR m.from_session_key <> ?)
	  AND (
		(m.to_session_key = ? AND (m.to_session_agent_id IS NULL OR m.to_session_agent_id = ?))
		OR (m.to_session_key IS NULL AND m.to_agent_id = ?)
	  )
	ORDER BY m.created_at ASC, m.rowid ASC
	LIMIT ?`;

export async function claimDirectMessageWakes(input: {
	readonly agentId: string;
	readonly sessionKey: string;
	readonly harness: string;
	readonly nowMs?: number;
}): Promise<readonly AgentMessage[]> {
	const now = new Date(input.nowMs ?? Date.now()).toISOString();
	const rows = await dbOwnerQuery<readonly CrossAgentMessageRow[]>(
		ownerStatement(
			CLAIMABLE_SQL,
			[input.agentId, now, input.sessionKey, input.sessionKey, input.agentId, input.agentId, MAX_WAKE_BATCH],
			"all",
		),
		{ operation: "cross-agent.wake.candidates", lane: "read", deadlineMs: 5_000, estimatedWorkUnits: 2 },
	);
	if (rows.length === 0) return [];
	const results = await dbOwnerBatch(
		rows.map((row) =>
			ownerStatement(
				`INSERT OR IGNORE INTO cross_agent_message_wakes (message_id, agent_id, session_key, harness, woken_at)
				 VALUES (?, ?, ?, ?, ?)`,
				[row.id, input.agentId, input.sessionKey, input.harness, now],
			),
		),
		{ operation: "cross-agent.wake.claim", lane: "write", deadlineMs: 5_000, estimatedWorkUnits: rows.length },
	);
	const claimed: AgentMessage[] = [];
	rows.forEach((row, index) => {
		const result = results[index] as { readonly changes?: number } | undefined;
		if (result?.changes === 1) claimed.push(rowToAgentMessage(row));
	});
	return claimed;
}

function wakeResult(messages: readonly AgentMessage[], sessionKey: string): WakeWaitResult {
	const items = messages.map(projectNotificationMessage);
	return {
		wake: true,
		inject: formatWakeInject(items, sessionKey),
		messageIds: items.map((item) => item.id),
		notifications: { items },
	};
}

async function attemptClaim(waiter: Waiter): Promise<void> {
	if (waiter.done) return;
	if (waiter.claiming) {
		waiter.rerun = true;
		return;
	}
	waiter.claiming = true;
	try {
		do {
			waiter.rerun = false;
			const nowMs = Date.now();
			if (rateLimitRetryAfter(waiter.sessionKey, nowMs) !== null) return;
			const claimed = await claimDirectMessageWakes(waiter);
			if (claimed.length > 0) {
				recordWake(waiter.sessionKey, nowMs);
				waiter.finish(wakeResult(claimed, waiter.sessionKey));
				return;
			}
		} while (waiter.rerun && !waiter.done);
	} finally {
		waiter.claiming = false;
	}
}

function lastSeenMs(sessionKey: string): number {
	const seen = getAgentPresenceForSession(sessionKey)?.lastSeenAt;
	const parsed = seen ? Date.parse(seen) : Number.NaN;
	return Number.isFinite(parsed) ? parsed : 0;
}

export function selectWakeTarget(message: AgentMessage, nowMs = Date.now()): string | null {
	if (!isDirectAgentMessage(message)) return null;
	const eligible = (waiter: Waiter): boolean =>
		!waiter.done &&
		waiter.sessionKey !== message.fromSessionKey &&
		rateLimitRetryAfter(waiter.sessionKey, nowMs) === null;
	if (message.toSessionKey) {
		const waiter = waiters.get(message.toSessionKey);
		if (!waiter || !eligible(waiter)) return null;
		const owner = message.toSessionAgentId ?? message.toAgentId;
		if (owner && owner !== waiter.agentId) return null;
		return waiter.sessionKey;
	}
	const candidates = [...waiters.values()]
		.filter((waiter) => waiter.agentId === message.toAgentId && eligible(waiter))
		.sort((a, b) => lastSeenMs(b.sessionKey) - lastSeenMs(a.sessionKey));
	return candidates[0]?.sessionKey ?? null;
}

function ensureSubscribed(): void {
	if (unsubscribe) return;
	unsubscribe = subscribeCrossAgentEvents((event) => {
		if (event.type !== "message") return;
		const target = selectWakeTarget(event.message);
		if (!target) return;
		const waiter = waiters.get(target);
		if (!waiter) return;
		void attemptClaim(waiter).catch(() => {});
	});
}

export async function waitForDirectMessageWake(input: WakeWaitInput): Promise<WakeWaitResult> {
	const nowMs = input.nowMs ?? Date.now();
	const retryAfterMs = rateLimitRetryAfter(input.sessionKey, nowMs);
	const previous = waiters.get(input.sessionKey);
	if (previous) previous.finish({ wake: false, reason: "superseded" });
	if (retryAfterMs !== null) return { wake: false, reason: "rate_limited", retryAfterMs };
	if (input.signal?.aborted) return { wake: false, reason: "aborted" };

	ensureSubscribed();
	const waitMs = Math.max(0, Math.min(MAX_WAKE_WAIT_MS, Math.round(input.waitMs)));
	return await new Promise<WakeWaitResult>((resolve) => {
		let timer: ReturnType<typeof setTimeout> | null = null;
		const onAbort = (): void => waiter.finish({ wake: false, reason: "aborted" });
		const waiter: Waiter = {
			id: nextWaiterId++,
			agentId: input.agentId,
			sessionKey: input.sessionKey,
			harness: input.harness,
			claiming: false,
			rerun: false,
			done: false,
			finish: (result) => {
				if (waiter.done) return;
				waiter.done = true;
				if (timer) clearTimeout(timer);
				input.signal?.removeEventListener("abort", onAbort);
				if (waiters.get(waiter.sessionKey) === waiter) waiters.delete(waiter.sessionKey);
				resolve(result);
			},
		};
		waiters.set(input.sessionKey, waiter);
		input.signal?.addEventListener("abort", onAbort, { once: true });
		void attemptClaim(waiter)
			.catch(() => {})
			.finally(() => {
				if (waiter.done) return;
				if (waitMs === 0) {
					waiter.finish({ wake: false, reason: "timeout" });
					return;
				}
				timer = setTimeout(() => waiter.finish({ wake: false, reason: "timeout" }), waitMs);
			});
	});
}

export function activeWakeWaiterCount(): number {
	return waiters.size;
}

export function closeDirectMessageWakeWaiters(): void {
	for (const waiter of [...waiters.values()]) waiter.finish({ wake: false, reason: "closed" });
	waiters.clear();
}

export function resetDirectMessageWakeStateForTest(): void {
	closeDirectMessageWakeWaiters();
	wakeTimes.clear();
	unsubscribe?.();
	unsubscribe = null;
}

registerDbAccessorCloseParticipant({
	name: "cross-agent-wake-waiters",
	order: 150,
	close: () => closeDirectMessageWakeWaiters(),
});
