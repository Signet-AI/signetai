import { computeRetryBackoffMs } from "./embedding-repair-state";

export const MAX_CONSECUTIVE_PROVIDER_FAILURES = 6;
export const MAX_PROVIDER_BACKOFF_MS = 60_000;

interface CircuitState { failures: number; retryAt: number; lastNoticeAt: number }
const circuits = new Map<string, CircuitState>();

export interface EmbeddingProviderGateResult {
	readonly available: boolean;
	readonly retryAfterMs?: number;
}

function stateFor(key: string): CircuitState {
	const state = circuits.get(key) ?? { failures: 0, retryAt: 0, lastNoticeAt: 0 };
	circuits.set(key, state);
	return state;
}

export async function awaitEmbeddingProviderAvailable(
	key: string,
	check: () => Promise<boolean>,
	pollMs: number,
): Promise<EmbeddingProviderGateResult> {
	const state = stateFor(key);
	const now = Date.now();
	if (state.retryAt > now) return { available: false, retryAfterMs: state.retryAt - now };
	const available = await check();
	if (available) {
		state.failures = 0;
		state.retryAt = 0;
		return { available: true };
	}
	state.failures = Math.min(state.failures + 1, MAX_CONSECUTIVE_PROVIDER_FAILURES);
	const delay = Math.min(computeRetryBackoffMs(state.failures, pollMs), MAX_PROVIDER_BACKOFF_MS);
	state.retryAt = Date.now() + delay;
	return { available: false, retryAfterMs: delay };
}

export function recordEmbeddingProviderFailure(key: string, pollMs: number): number {
	const state = stateFor(key);
	state.failures = Math.min(state.failures + 1, MAX_CONSECUTIVE_PROVIDER_FAILURES);
	const delay = Math.min(computeRetryBackoffMs(state.failures, pollMs), MAX_PROVIDER_BACKOFF_MS);
	state.retryAt = Date.now() + delay;
	return delay;
}

export function shouldEmitEmbeddingProviderNotice(key: string, now = Date.now()): boolean {
	const state = stateFor(key);
	if (state.lastNoticeAt > now) return false;
	state.lastNoticeAt = state.retryAt;
	return true;
}

export function resetEmbeddingCircuitBreakers(): void { circuits.clear(); }
