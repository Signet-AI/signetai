import type { DaemonClient } from "./daemon-client.js";
import { readTrimmedString } from "./helpers.js";

export const WAKE_WAIT_MS = 25_000;
export const WAKE_REQUEST_TIMEOUT_MS = WAKE_WAIT_MS + 10_000;
export const WAKE_DEFAULT_RETRY_MS = 15_000;
export const WAKE_MAX_RETRY_MS = 300_000;
export const WAKE_MIN_LOOP_MS = 1_000;

interface WakeResponse {
	readonly wake?: boolean;
	readonly inject?: string;
	readonly messageIds?: readonly string[];
	readonly reason?: string;
	readonly retryAfterMs?: number;
}

export interface WakeSessionRef {
	readonly sessionKey: string;
	readonly project?: string;
}

export interface WakeWaiterOptions {
	readonly client: DaemonClient;
	readonly harness: string;
	readonly agentId: string | undefined;
	readonly deliver: (inject: string) => unknown;
	readonly waitMs?: number;
	readonly defaultRetryMs?: number;
	readonly minLoopMs?: number;
}

export interface WakeWaiter {
	start(session: WakeSessionRef): void;
	stop(): void;
	readonly running: boolean;
}

function retryDelay(response: WakeResponse | undefined, fallbackMs: number): number {
	const raw = response?.retryAfterMs;
	if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
		return Math.min(raw, WAKE_MAX_RETRY_MS);
	}
	return Math.min(fallbackMs, WAKE_MAX_RETRY_MS);
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal.aborted) {
			resolve();
			return;
		}
		const onAbort = (): void => {
			clearTimeout(timer);
			resolve();
		};
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		timer.unref?.();
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

export function createWakeWaiter(options: WakeWaiterOptions): WakeWaiter {
	const waitMs = options.waitMs ?? WAKE_WAIT_MS;
	const defaultRetryMs = options.defaultRetryMs ?? WAKE_DEFAULT_RETRY_MS;
	const minLoopMs = options.minLoopMs ?? WAKE_MIN_LOOP_MS;
	let controller: AbortController | undefined;
	let activeKey: string | undefined;
	let activeProject: string | undefined;

	async function loop(session: WakeSessionRef, signal: AbortSignal): Promise<void> {
		while (!signal.aborted) {
			const startedAt = Date.now();
			let delayMs = 0;
			const result = await options.client.postResult<WakeResponse>(
				"/api/cross-agent/wake",
				{
					harness: options.harness,
					sessionKey: session.sessionKey,
					agentId: options.agentId,
					project: session.project,
					waitMs,
				},
				waitMs + 10_000,
				signal,
			);
			if (signal.aborted) return;
			if (!result.ok) {
				delayMs = defaultRetryMs;
			} else if (result.data?.wake === true) {
				const inject = readTrimmedString(result.data.inject);
				if (inject) {
					try {
						await options.deliver(inject);
					} catch {
						delayMs = defaultRetryMs;
						const messageIds = (result.data.messageIds ?? []).filter((id) => typeof id === "string");
						if (messageIds.length > 0) {
							for (let attempt = 1; attempt <= 3; attempt++) {
								const released = await options.client
									.postResult(
										"/api/cross-agent/wake/release",
										{
											harness: options.harness,
											sessionKey: session.sessionKey,
											agentId: options.agentId,
											messageIds,
										},
										10_000,
									)
									.catch(() => ({ ok: false as const }));
								if (released.ok) break;
							}
						}
					}
				}
			} else {
				const reason = result.data?.reason;
				if (reason === "superseded") {
					if (controller?.signal === signal) {
						controller = undefined;
						activeKey = undefined;
						activeProject = undefined;
					}
					return;
				}
				if (reason !== "timeout" && reason !== "aborted") {
					delayMs = retryDelay(result.data, defaultRetryMs);
				}
			}
			if (delayMs <= 0 && Date.now() - startedAt < minLoopMs) delayMs = minLoopMs;
			if (delayMs > 0) await abortableSleep(delayMs, signal);
		}
	}

	function stop(): void {
		const current = controller;
		controller = undefined;
		activeKey = undefined;
		activeProject = undefined;
		current?.abort();
	}

	return {
		start(session) {
			if (
				controller &&
				!controller.signal.aborted &&
				activeKey === session.sessionKey &&
				activeProject === session.project
			) {
				return;
			}
			stop();
			const next = new AbortController();
			controller = next;
			activeKey = session.sessionKey;
			activeProject = session.project;
			void loop(session, next.signal).catch(() => undefined);
		},
		stop,
		get running() {
			return controller !== undefined && !controller.signal.aborted;
		},
	};
}
