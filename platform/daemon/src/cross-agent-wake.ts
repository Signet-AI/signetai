import { registerDbAccessorCloseParticipant } from "./db-accessor-lifecycle";
import { logger } from "./logger";
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
export const MAX_WAKE_RELEASE_IDS = MAX_WAKE_BATCH;
const MAX_TRACKED_SESSIONS = 10_000;
let trackedSessionCap = MAX_TRACKED_SESSIONS;
export const MAX_ACTIVE_WAKE_WAITERS = 2_000;
let activeWaiterCap = MAX_ACTIVE_WAKE_WAITERS;
const WAITER_CAP_RETRY_MS = 30_000;

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
}

interface Waiter {
	readonly id: number;
	readonly agentId: string;
	readonly sessionKey: string;
	readonly harness: string;
	readonly finish: (result: WakeWaitResult) => void;
	readonly fail: (error: unknown) => void;
	claiming: boolean;
	rerun: boolean;
	done: boolean;
}

const waiters = new Map<string, Waiter>();
interface WakeDelivery {
	readonly sequence: number;
	readonly at: number;
	readonly messageIds: Set<string>;
}

interface WakeHistory {
	deliveries: WakeDelivery[];
	endBoundary: number;
	pendingClaims: number;
}

const wakeHistory = new Map<string, WakeHistory>();
let nextDeliverySequence = 1;
let nextHistoryExpiry = 0;

function scopedKey(agentId: string, sessionKey: string): string {
	return JSON.stringify([agentId, sessionKey]);
}

function waiterKey(waiter: Pick<Waiter, "agentId" | "sessionKey">): string {
	return scopedKey(waiter.agentId, waiter.sessionKey);
}
let nextWaiterId = 1;
let unsubscribe: (() => void) | null = null;

function recentWakes(key: string, nowMs: number): WakeDelivery[] {
	const history = wakeHistory.get(key);
	if (!history) return [];
	history.deliveries = history.deliveries.filter((delivery) => nowMs - delivery.at < WAKE_RATE_WINDOW_MS);
	if (history.deliveries.length === 0 && history.pendingClaims === 0) wakeHistory.delete(key);
	return history.deliveries;
}

function historyCapacityRetryAfter(key: string, nowMs: number): number | null {
	if (wakeHistory.has(key) || wakeHistory.size < trackedSessionCap) return null;
	if (nowMs >= nextHistoryExpiry) {
		let expiry = Number.POSITIVE_INFINITY;
		for (const historyKey of [...wakeHistory.keys()]) {
			const oldest = recentWakes(historyKey, nowMs)[0];
			if (oldest) expiry = Math.min(expiry, oldest.at + WAKE_RATE_WINDOW_MS);
		}
		nextHistoryExpiry = expiry;
		if (wakeHistory.size < trackedSessionCap) return null;
	}
	return Math.max(1_000, Math.min(WAITER_CAP_RETRY_MS, nextHistoryExpiry - nowMs));
}

function rateLimitRetryAfter(key: string, nowMs: number): number | null {
	const times = recentWakes(key, nowMs);
	if (times.length < WAKE_RATE_LIMIT_PER_HOUR) return historyCapacityRetryAfter(key, nowMs);
	const oldest = times[0]?.at ?? nowMs;
	return Math.max(1_000, WAKE_RATE_WINDOW_MS - (nowMs - oldest));
}

function recordWake(key: string, nowMs: number, messages: readonly AgentMessage[]): void {
	const history = wakeHistory.get(key) ?? { deliveries: [], endBoundary: 0, pendingClaims: 0 };
	history.deliveries = recentWakes(key, nowMs);
	history.deliveries.push({
		sequence: nextDeliverySequence++,
		at: nowMs,
		messageIds: new Set(messages.map((message) => message.id)),
	});
	wakeHistory.set(key, history);
	nextHistoryExpiry = Math.min(nextHistoryExpiry, nowMs + WAKE_RATE_WINDOW_MS);
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
		OR (
			m.to_session_key IS NULL AND m.to_agent_id = ?
			AND (? = 1 OR (? = 2 AND m.from_session_key = ?))
		)
	  )
	ORDER BY m.created_at ASC, m.rowid ASC
	LIMIT ?`;

export async function claimDirectMessageWakes(input: {
	readonly agentId: string;
	readonly sessionKey: string;
	readonly harness: string;
	readonly includeAgentAddressed?: boolean;
	readonly agentAddressedOnlyFromSession?: string;
	readonly nowMs?: number;
}): Promise<readonly AgentMessage[]> {
	const now = new Date(input.nowMs ?? Date.now()).toISOString();
	const agentAddressed =
		input.agentAddressedOnlyFromSession !== undefined ? 2 : input.includeAgentAddressed === false ? 0 : 1;
	const rows = await dbOwnerQuery<readonly CrossAgentMessageRow[]>(
		ownerStatement(
			CLAIMABLE_SQL,
			[
				input.agentId,
				now,
				input.sessionKey,
				input.sessionKey,
				input.agentId,
				input.agentId,
				agentAddressed,
				agentAddressed,
				input.agentAddressedOnlyFromSession ?? "",
				MAX_WAKE_BATCH,
			],
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

export async function releaseDirectMessageWakes(input: {
	readonly agentId: string;
	readonly sessionKey: string;
	readonly messageIds: readonly string[];
}): Promise<number> {
	const ids = [...new Set(input.messageIds.filter((id) => typeof id === "string" && id.length > 0))];
	const key = scopedKey(input.agentId, input.sessionKey);
	const deliveries = [...(wakeHistory.get(key)?.deliveries ?? [])];
	let released = 0;
	for (let start = 0; start < ids.length; start += MAX_WAKE_BATCH) {
		const chunk = ids.slice(start, start + MAX_WAKE_BATCH);
		const results = await dbOwnerBatch(
			chunk.map((id) =>
				ownerStatement(
					"DELETE FROM cross_agent_message_wakes WHERE message_id = ? AND agent_id = ? AND session_key = ?",
					[id, input.agentId, input.sessionKey],
				),
			),
			{ operation: "cross-agent.wake.release", lane: "write", deadlineMs: 5_000, estimatedWorkUnits: chunk.length },
		);
		for (let index = 0; index < results.length; index++) {
			const changes = (results[index] as { readonly changes?: number } | undefined)?.changes ?? 0;
			released += changes;
			const id = chunk[index];
			if (changes > 0 && id) {
				for (const delivery of deliveries) delivery.messageIds.delete(id);
			}
		}
		const history = wakeHistory.get(key);
		if (history) {
			history.deliveries = history.deliveries.filter((delivery) => delivery.messageIds.size > 0);
			if (history.deliveries.length === 0 && history.pendingClaims === 0) wakeHistory.delete(key);
		}
	}
	return released;
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
			const key = waiterKey(waiter);
			const retryAfterMs = rateLimitRetryAfter(key, performance.now());
			if (retryAfterMs !== null) {
				waiter.finish({ wake: false, reason: "rate_limited", retryAfterMs });
				return;
			}
			const history = wakeHistory.get(key) ?? { deliveries: [], endBoundary: 0, pendingClaims: 0 };
			history.pendingClaims++;
			wakeHistory.set(key, history);
			const preference = agentAddressedPreference(waiter, performance.now());
			let claimed: readonly AgentMessage[];
			try {
				claimed = await claimDirectMessageWakes({
					agentId: waiter.agentId,
					sessionKey: waiter.sessionKey,
					harness: waiter.harness,
					includeAgentAddressed: preference.mode === "all",
					agentAddressedOnlyFromSession: preference.mode === "from" ? preference.sessionKey : undefined,
				});
			} finally {
				history.pendingClaims--;
				if (history.pendingClaims === 0 && history.deliveries.length === 0 && wakeHistory.get(key) === history) {
					wakeHistory.delete(key);
				}
			}
			if (claimed.length > 0) {
				if (waiter.done) {
					await releaseWakeClaimsWithRetry({
						agentId: waiter.agentId,
						sessionKey: waiter.sessionKey,
						messageIds: claimed.map((message) => message.id),
					});
					redispatch(claimed);
					return;
				}
				recordWake(waiterKey(waiter), performance.now(), claimed);
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

type AgentAddressedPreference =
	| { readonly mode: "all" }
	| { readonly mode: "none" }
	| { readonly mode: "from"; readonly sessionKey: string };

function agentAddressedPreference(waiter: Waiter, nowMs: number): AgentAddressedPreference {
	const seen = lastSeenMs(waiter.sessionKey);
	const moreRecent: string[] = [];
	for (const other of waiters.values()) {
		if (other === waiter || other.done || other.agentId !== waiter.agentId) continue;
		if (rateLimitRetryAfter(waiterKey(other), nowMs) !== null) continue;
		if (lastSeenMs(other.sessionKey) > seen) moreRecent.push(other.sessionKey);
	}
	if (moreRecent.length === 0) return { mode: "all" };
	const only = moreRecent[0];
	if (moreRecent.length === 1 && only !== undefined) return { mode: "from", sessionKey: only };
	return { mode: "none" };
}

function logClaimFailure(waiter: Waiter, error: unknown): void {
	logger.warn("hooks", "Direct message wake claim failed", {
		agentId: waiter.agentId,
		sessionKey: waiter.sessionKey,
		harness: waiter.harness,
		error: error instanceof Error ? error.message : String(error),
	});
}

export function selectWakeTarget(message: AgentMessage, nowMs = performance.now()): string | null {
	if (!isDirectAgentMessage(message)) return null;
	const eligible = (waiter: Waiter): boolean =>
		!waiter.done &&
		waiter.sessionKey !== message.fromSessionKey &&
		rateLimitRetryAfter(waiterKey(waiter), nowMs) === null;
	if (message.toSessionKey) {
		const owner = message.toSessionAgentId ?? message.toAgentId;
		const matches = [...waiters.values()].filter(
			(waiter) => waiter.sessionKey === message.toSessionKey && (!owner || waiter.agentId === owner),
		);
		if (matches.length !== 1) return null;
		const waiter = matches[0];
		return waiter && eligible(waiter) ? waiterKey(waiter) : null;
	}
	const candidates = [...waiters.values()]
		.filter((waiter) => waiter.agentId === message.toAgentId && eligible(waiter))
		.sort((a, b) => lastSeenMs(b.sessionKey) - lastSeenMs(a.sessionKey));
	const best = candidates[0];
	return best ? waiterKey(best) : null;
}

export async function releaseWakeClaimsWithRetry(input: {
	readonly agentId: string;
	readonly sessionKey: string;
	readonly messageIds: readonly string[];
}): Promise<void> {
	for (let attempt = 1; ; attempt++) {
		try {
			await releaseDirectMessageWakes(input);
			return;
		} catch (error) {
			if (attempt >= 3) {
				logger.error(
					"hooks",
					"Direct message wake claim release failed; the message waits for the next hook",
					error instanceof Error ? error : new Error(String(error)),
					{ agentId: input.agentId, sessionKey: input.sessionKey, messageCount: input.messageIds.length },
				);
				throw error;
			}
			await new Promise<void>((resolve) => setTimeout(resolve, 100 * attempt));
		}
	}
}

function redispatch(messages: readonly AgentMessage[]): void {
	for (const message of messages) {
		const target = selectWakeTarget(message);
		const waiter = target ? waiters.get(target) : undefined;
		if (waiter) void attemptClaim(waiter).catch((error) => logClaimFailure(waiter, error));
	}
}

function ensureSubscribed(): void {
	if (unsubscribe) return;
	unsubscribe = subscribeCrossAgentEvents((event) => {
		if (event.type !== "message") return;
		const target = selectWakeTarget(event.message);
		if (!target) return;
		const waiter = waiters.get(target);
		if (!waiter) return;
		void attemptClaim(waiter).catch((error) => logClaimFailure(waiter, error));
	});
}

export async function waitForDirectMessageWake(input: WakeWaitInput): Promise<WakeWaitResult> {
	const nowMs = performance.now();
	const key = scopedKey(input.agentId, input.sessionKey);
	const retryAfterMs = rateLimitRetryAfter(key, nowMs);
	const previous = waiters.get(key);
	if (previous) previous.finish({ wake: false, reason: "superseded" });
	if (retryAfterMs !== null) return { wake: false, reason: "rate_limited", retryAfterMs };
	if (input.signal?.aborted) return { wake: false, reason: "aborted" };
	if (waiters.size >= activeWaiterCap) {
		return { wake: false, reason: "rate_limited", retryAfterMs: WAITER_CAP_RETRY_MS };
	}

	ensureSubscribed();
	const waitMs = Math.max(0, Math.min(MAX_WAKE_WAIT_MS, Math.round(input.waitMs)));
	return await new Promise<WakeWaitResult>((resolve, reject) => {
		let timer: ReturnType<typeof setTimeout> | null = null;
		const onAbort = (): void => waiter.finish({ wake: false, reason: "aborted" });
		const settle = (): boolean => {
			if (waiter.done) return false;
			waiter.done = true;
			if (timer) clearTimeout(timer);
			input.signal?.removeEventListener("abort", onAbort);
			if (waiters.get(key) === waiter) waiters.delete(key);
			return true;
		};
		const waiter: Waiter = {
			id: nextWaiterId++,
			agentId: input.agentId,
			sessionKey: input.sessionKey,
			harness: input.harness,
			claiming: false,
			rerun: false,
			done: false,
			finish: (result) => {
				if (!settle()) return;
				resolve(result);
			},
			fail: (error) => {
				if (!settle()) return;
				reject(error);
			},
		};
		waiters.set(key, waiter);
		input.signal?.addEventListener("abort", onAbort, { once: true });
		void attemptClaim(waiter)
			.catch((error) => {
				logClaimFailure(waiter, error);
				waiter.fail(error);
			})
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

export function consumeSessionEndWake(agentId: string, sessionKey: string): boolean {
	const key = scopedKey(agentId, sessionKey);
	const deliveries = recentWakes(key, performance.now());
	const history = wakeHistory.get(key);
	if (!history) return false;
	const woken = deliveries.some((delivery) => delivery.sequence > history.endBoundary);
	history.endBoundary = nextDeliverySequence - 1;
	return woken;
}

export function wasWokenSince(agentId: string, sessionKey: string, sinceMs: number): boolean {
	return recentWakes(scopedKey(agentId, sessionKey), performance.now()).some((delivery) => delivery.at >= sinceMs);
}

export function activeWakeWaiterCount(): number {
	return waiters.size;
}

export function closeDirectMessageWakeWaiters(): void {
	for (const waiter of [...waiters.values()]) waiter.finish({ wake: false, reason: "closed" });
	waiters.clear();
}

export function setWakeWaiterCapForTest(cap: number): void {
	activeWaiterCap = cap;
}

export function setWakeHistoryCapForTest(cap: number): void {
	trackedSessionCap = cap;
}

export function resetDirectMessageWakeStateForTest(): void {
	activeWaiterCap = MAX_ACTIVE_WAKE_WAITERS;
	trackedSessionCap = MAX_TRACKED_SESSIONS;
	closeDirectMessageWakeWaiters();
	wakeHistory.clear();
	nextHistoryExpiry = 0;
	unsubscribe?.();
	unsubscribe = null;
}

registerDbAccessorCloseParticipant({
	name: "cross-agent-wake-waiters",
	order: 150,
	close: () => closeDirectMessageWakeWaiters(),
});
