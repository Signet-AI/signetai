import { computeRetryBackoffMs } from "./embedding-repair-state";

export const MAX_CONSECUTIVE_PROVIDER_FAILURES = 6;
export const MAX_PROVIDER_BACKOFF_MS = 60_000;

interface CircuitState {
	failures: number;
	retryAt: number;
	lastNoticeAt: number;
}
const circuits = new Map<string, CircuitState>();
const inFlightChecks = new Map<string, Promise<EmbeddingProviderGateResult>>();
let circuitGeneration = 0;

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
	onProviderUnavailable?: () => void,
): Promise<EmbeddingProviderGateResult> {
	const inFlight = inFlightChecks.get(key);
	if (inFlight) return inFlight;
	const flight = checkEmbeddingProviderAvailable(key, check, pollMs, onProviderUnavailable);
	inFlightChecks.set(key, flight);
	try {
		return await flight;
	} finally {
		if (inFlightChecks.get(key) === flight) inFlightChecks.delete(key);
	}
}

async function checkEmbeddingProviderAvailable(
	key: string,
	check: () => Promise<boolean>,
	pollMs: number,
	onProviderUnavailable?: () => void,
): Promise<EmbeddingProviderGateResult> {
	const generation = circuitGeneration;
	const state = stateFor(key);
	const now = Date.now();
	if (state.retryAt > now) return { available: false, retryAfterMs: state.retryAt - now };
	const available = await check();
	if (generation !== circuitGeneration) return { available: true };
	if (available) {
		state.failures = 0;
		state.retryAt = 0;
		state.lastNoticeAt = 0;
		return { available: true };
	}
	state.failures = Math.min(state.failures + 1, MAX_CONSECUTIVE_PROVIDER_FAILURES);
	const delay = Math.min(computeRetryBackoffMs(state.failures, pollMs), MAX_PROVIDER_BACKOFF_MS);
	state.retryAt = Date.now() + delay;
	if (onProviderUnavailable && shouldEmitEmbeddingProviderNotice(key)) onProviderUnavailable();
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
	if (state.retryAt <= now || state.lastNoticeAt > 0) return false;
	state.lastNoticeAt = now;
	return true;
}

export function resetEmbeddingCircuitBreakers(): void {
	circuitGeneration += 1;
	circuits.clear();
	inFlightChecks.clear();
}
