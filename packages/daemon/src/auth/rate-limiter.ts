/**
 * In-memory sliding window rate limiter for destructive operations.
 * Resets on daemon restart — acceptable for v1.
 */

import type { RateLimitCheck } from "./types";

interface WindowEntry {
	count: number;
	windowStart: number;
}

export class AuthRateLimiter {
	private readonly windowMs: number;
	private readonly maxRequests: number;
	private readonly windows = new Map<string, WindowEntry>();

	constructor(windowMs: number, maxRequests: number) {
		this.windowMs = windowMs;
		this.maxRequests = maxRequests;
	}

	check(key: string): RateLimitCheck {
		const now = Date.now();
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
		const entry = this.windows.get(key);

		if (!entry || now - entry.windowStart >= this.windowMs) {
			this.windows.set(key, { count: 1, windowStart: now });
			return;
		}

		entry.count += 1;
	}

	reset(): void {
		this.windows.clear();
	}
}

export interface RateLimitConfig {
	readonly windowMs: number;
	readonly max: number;
}

export const DEFAULT_RATE_LIMITS: Readonly<
	Record<string, RateLimitConfig>
> = {
	forget: { windowMs: 60_000, max: 30 },
	modify: { windowMs: 60_000, max: 60 },
	batchForget: { windowMs: 60_000, max: 5 },
	forceDelete: { windowMs: 60_000, max: 3 },
	admin: { windowMs: 60_000, max: 10 },
};
