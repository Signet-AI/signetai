import type { Context } from "hono";

export type Release = () => void;
export interface Refusal {
	readonly reason: "admission";
	readonly retryAfter: number;
}
export interface ConcurrencyAdmission {
	acquire(key: string, signal?: AbortSignal): Promise<Release | Refusal>;
	tryAcquire(key: string): Release | null;
	inFlight(): number;
	readonly maxInFlight: number;
}
export interface AdmissionOptions {
	readonly maxWaiters?: number;
	readonly maxWaitMs?: number;
}
interface Waiter {
	readonly deadline: number;
	readonly resolve: (result: Release | Refusal) => void;
	readonly cleanup: () => void;
}

export function admissionKey(c: Context): string {
	const auth = c.get("auth");
	if (!auth?.authenticated) return "local";
	return auth.claims?.scope.user ?? auth.claims?.sub ?? "anonymous-credential";
}

export function createConcurrencyAdmission(maxInFlight: number, options: AdmissionOptions = {}): ConcurrencyAdmission {
	const maxWaiters = options.maxWaiters ?? 64;
	const maxWaitMs = options.maxWaitMs ?? 2_000;
	for (const [name, value] of Object.entries({ maxInFlight, maxWaiters, maxWaitMs })) {
		if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
	}
	let active = 0;
	let queued = 0;
	let meanHoldMs = 0;
	let lastGranted: string | undefined;
	const held = new Map<string, number>();
	const queues = new Map<string, Set<Waiter>>();
	const refusal = (): Refusal => ({
		reason: "admission",
		retryAfter: Math.max(1, Math.min(30, Math.ceil(((queued + 1) * meanHoldMs) / Math.max(1, maxInFlight) / 1_000))),
	});

	function grant(key: string): Release {
		active++;
		held.set(key, (held.get(key) ?? 0) + 1);
		lastGranted = key;
		const started = performance.now();
		let released = false;
		return () => {
			if (released) return;
			released = true;
			const elapsed = performance.now() - started;
			meanHoldMs = meanHoldMs === 0 ? elapsed : meanHoldMs * 0.875 + elapsed * 0.125;
			active--;
			const remaining = (held.get(key) ?? 1) - 1;
			if (remaining === 0) held.delete(key);
			else held.set(key, remaining);
			drain();
		};
	}

	function tryAcquire(key: string): Release | null {
		return queued === 0 && active < maxInFlight ? grant(key) : null;
	}

	function remove(key: string, waiter: Waiter): void {
		const queue = queues.get(key);
		if (!queue?.delete(waiter)) return;
		queued--;
		if (queue.size === 0) queues.delete(key);
		waiter.cleanup();
	}

	function drain(): void {
		while (active < maxInFlight && queued > 0) {
			let selected: string | undefined;
			for (const key of queues.keys()) {
				if (queues.size === 1 || (held.get(key) ?? 0) < Math.ceil(maxInFlight / 2)) {
					selected = key;
					break;
				}
			}
			if (selected === undefined) return;
			const queue = queues.get(selected);
			const waiter = queue?.values().next().value;
			if (!queue || !waiter) return;
			remove(selected, waiter);
			if (performance.now() >= waiter.deadline) {
				waiter.resolve(refusal());
				continue;
			}
			if (queue.size > 0) {
				queues.delete(selected);
				queues.set(selected, queue);
			}
			waiter.resolve(grant(selected));
		}
	}

	return {
		maxInFlight,
		inFlight: () => active,
		tryAcquire,
		async acquire(key, signal) {
			if (signal?.aborted || maxInFlight === 0) return refusal();
			const release = tryAcquire(key);
			if (release) return release;
			if (queued >= maxWaiters || maxWaitMs === 0) return refusal();
			return new Promise<Release | Refusal>((resolve) => {
				const cancel = () => {
					remove(key, waiter);
					resolve(refusal());
					drain();
				};
				const timer = setTimeout(cancel, maxWaitMs);
				const waiter: Waiter = {
					deadline: performance.now() + maxWaitMs,
					resolve,
					cleanup: () => {
						clearTimeout(timer);
						signal?.removeEventListener("abort", cancel);
					},
				};
				const queue = queues.get(key) ?? new Set<Waiter>();
				queue.add(waiter);
				queues.set(key, queue);
				queued++;
				if (lastGranted !== undefined) {
					const lastQueue = queues.get(lastGranted);
					if (lastQueue) {
						queues.delete(lastGranted);
						queues.set(lastGranted, lastQueue);
					}
				}
				signal?.addEventListener("abort", cancel, { once: true });
				drain();
			});
		},
	};
}
