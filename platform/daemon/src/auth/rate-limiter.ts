import type { RateLimitCheck } from "./types";

interface WindowEntry {
	count: number;
	windowStart: number;
}

export class AuthRateLimiter {
	private readonly windowMs: number;
	private readonly maxRequests: number;
	private readonly windows = new Map<string, WindowEntry>();
	private cursor: MapIterator<[string, WindowEntry]> | null = null;
	private prune(now: number): void {
		this.cursor ??= this.windows.entries();
		for (let i = 0; i < 128; i++) {
			const item = this.cursor.next();
			if (item.done) {
				this.cursor = null;
				break;
			}
			if (now - item.value[1].windowStart >= this.windowMs) this.windows.delete(item.value[0]);
		}
	}

	constructor(windowMs: number, maxRequests: number) {
		this.windowMs = windowMs;
		this.maxRequests = maxRequests;
	}

	check(key: string): RateLimitCheck {
		const now = Date.now();
		this.prune(now);
		const entry = this.windows.get(key);

		if (!entry || now - entry.windowStart >= this.windowMs) {
			return {
				allowed: true,
				remaining: this.maxRequests,
				resetAt: now + this.windowMs,
			};
		}

		const remaining = Math.max(0, this.maxRequests - entry.count);
		return {
			allowed: remaining > 0,
			remaining,
			resetAt: entry.windowStart + this.windowMs,
		};
	}

	record(key: string): void {
		const now = Date.now();
		this.prune(now);
		const entry = this.windows.get(key);

		if (!entry || now - entry.windowStart >= this.windowMs) {
			if (!entry && this.windows.size >= 10000) {
				let oldestKey: string | undefined,
					oldest = Infinity;
				for (const [candidate, value] of this.windows)
					if (value.windowStart < oldest) {
						oldest = value.windowStart;
						oldestKey = candidate;
					}
				if (oldestKey !== undefined) this.windows.delete(oldestKey);
			}
			this.windows.set(key, { count: 1, windowStart: now });
			return;
		}

		entry.count += 1;
	}

	reset(): void {
		this.windows.clear();
		this.cursor = null;
	}
}

export interface RateLimitConfig {
	readonly windowMs: number;
	readonly max: number;
}

export const DEFAULT_RATE_LIMITS: Readonly<Record<string, RateLimitConfig>> = {
	forget: { windowMs: 60_000, max: 30 },
	modify: { windowMs: 60_000, max: 60 },
	batchForget: { windowMs: 60_000, max: 5 },
	forceDelete: { windowMs: 60_000, max: 3 },
	admin: { windowMs: 60_000, max: 10 },
	login: { windowMs: 60_000, max: 5 },
	inferenceExplain: { windowMs: 60_000, max: 120 },
	inferenceExecute: { windowMs: 60_000, max: 20 },
	inferenceGateway: { windowMs: 60_000, max: 30 },
	recallLlm: { windowMs: 60_000, max: 60 },
};
