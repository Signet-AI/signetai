export const INTERNAL_FETCH_TIMEOUT_MS = 10_000;
export function fetchInternal(
	input: Parameters<typeof fetch>[0],
	init: RequestInit = {},
	timeoutMs = INTERNAL_FETCH_TIMEOUT_MS,
): Promise<Response> {
	const timeoutSignal = AbortSignal.timeout(timeoutMs);
	const signal = init.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal;
	return fetch(input, {
		...init,
		signal,
	});
}
