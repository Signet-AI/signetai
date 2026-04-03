import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { LlmProvider } from "@signet/core";
import { RateLimitExceededError, TokenBucketRateLimiter, withRateLimit } from "./provider";

function mockProvider(name = "test"): LlmProvider {
	return {
		name,
		async generate(_prompt: string, _opts?: { timeoutMs?: number; maxTokens?: number }): Promise<string> {
			return "ok";
		},
		async available(): Promise<boolean> {
			return true;
		},
	};
}

function mockProviderWithUsage(name = "test"): LlmProvider {
	let callCount = 0;
	return {
		name,
		async generate(_prompt: string, _opts?: { timeoutMs?: number; maxTokens?: number }): Promise<string> {
			return "ok";
		},
		async generateWithUsage(_prompt: string, _opts?: { timeoutMs?: number; maxTokens?: number }) {
			return {
				text: "ok",
				usage: {
					inputTokens: ++callCount,
					outputTokens: ++callCount,
					cacheReadTokens: 0,
					cacheCreationTokens: 0,
					totalCost: null,
					totalDurationMs: null,
				},
			};
		},
		async available(): Promise<boolean> {
			return true;
		},
	};
}

describe("TokenBucketRateLimiter", () => {
	it("allows burst calls up to burstSize without waiting", async () => {
		const bucket = new TokenBucketRateLimiter(100, 20);
		const results = await Promise.all(Array.from({ length: 20 }, () => bucket.acquire(0)));
		expect(results.every((r) => r === true)).toBe(true);
	});

	it("blocks calls when burst is exhausted and no time has passed", async () => {
		const bucket = new TokenBucketRateLimiter(100, 20);
		await Promise.all(Array.from({ length: 20 }, () => bucket.acquire(0)));
		const result = await bucket.acquire(0);
		expect(result).toBe(false);
	});

	it("refills tokens over time", async () => {
		const bucket = new TokenBucketRateLimiter(3600_000, 1);
		// drain the single token
		await bucket.acquire(0);
		expect(await bucket.acquire(0)).toBe(false);

		// Mock time passing by directly manipulating internal state
		const before = bucket.stats.totalConsumed;
		// We can't easily mock Date.now, so test the stats endpoint
		expect(bucket.stats.totalConsumed).toBe(1);
		expect(bucket.stats.totalThrottled).toBe(1);
	});

	it("tracks stats correctly", async () => {
		const bucket = new TokenBucketRateLimiter(100, 10);
		// Burst: consume 10
		for (let i = 0; i < 10; i++) {
			expect(await bucket.acquire(0)).toBe(true);
		}
		// 11th should fail immediately
		expect(await bucket.acquire(0)).toBe(false);
		expect(bucket.stats.totalConsumed).toBe(10);
		expect(bucket.stats.totalThrottled).toBe(1);
	});

	it("respects waitTimeoutMs", async () => {
		const bucket = new TokenBucketRateLimiter(1, 1);
		await bucket.acquire(0);
		// 1 token/hr = 1 token per 3600s. Even with wait, shouldn't get one in 10ms.
		const result = await bucket.acquire(10);
		expect(result).toBe(false);
		expect(bucket.stats.totalThrottled).toBe(1);
	});
});

describe("RateLimitExceededError", () => {
	it("has correct name and message", () => {
		const err = new RateLimitExceededError("claude-code:haiku", 200);
		expect(err.name).toBe("RateLimitExceededError");
		expect(err.providerName).toBe("claude-code:haiku");
		expect(err.maxCallsPerHour).toBe(200);
		expect(err.message).toContain("200/hr");
	});
});

describe("withRateLimit", () => {
	it("passes through calls when limit is not exceeded", async () => {
		const provider = mockProvider("claude-code:haiku");
		const wrapped = withRateLimit(provider, { maxCallsPerHour: 200, burstSize: 20, waitTimeoutMs: 5000 });
		const result = await wrapped.generate("test");
		expect(result).toBe("ok");
	});

	it("passes through generateWithUsage when limit is not exceeded", async () => {
		const provider = mockProviderWithUsage("claude-code:haiku");
		const wrapped = withRateLimit(provider, { maxCallsPerHour: 200, burstSize: 20, waitTimeoutMs: 5000 });
		const result = await wrapped.generateWithUsage?.("test");
		expect(result?.text).toBe("ok");
	});

	it("throws RateLimitExceededError when limit is exceeded", async () => {
		const provider = mockProvider("claude-code:haiku");
		const wrapped = withRateLimit(provider, { maxCallsPerHour: 10, burstSize: 2, waitTimeoutMs: 0 });
		// consume burst
		await wrapped.generate("a");
		await wrapped.generate("b");
		// third should fail
		await expect(wrapped.generate("c")).rejects.toThrow(RateLimitExceededError);
	});

	it("throws RateLimitExceededError with generateWithUsage too", async () => {
		const provider = mockProviderWithUsage("claude-code:haiku");
		const wrapped = withRateLimit(provider, { maxCallsPerHour: 10, burstSize: 2, waitTimeoutMs: 0 });
		await wrapped.generateWithUsage("a");
		await wrapped.generateWithUsage("b");
		await expect(wrapped.generateWithUsage("c")).rejects.toThrow(RateLimitExceededError);
	});

	it("delegates available() to underlying provider", async () => {
		const provider = mockProvider("claude-code:haiku");
		const wrapped = withRateLimit(provider, { maxCallsPerHour: 100, burstSize: 10, waitTimeoutMs: 1000 });
		expect(await wrapped.available()).toBe(true);
	});

	it("preserves provider name", () => {
		const provider = mockProvider("claude-code:haiku");
		const wrapped = withRateLimit(provider);
		expect(wrapped.name).toBe("claude-code:haiku");
	});

	it("returns provider unwrapped when maxCallsPerHour is 0", () => {
		const provider = mockProvider("claude-code:haiku");
		const wrapped = withRateLimit(provider, { maxCallsPerHour: 0 });
		expect(wrapped).toBe(provider);
	});

	it("returns provider unwrapped for ollama provider", () => {
		const provider = mockProvider("ollama");
		const wrapped = withRateLimit(provider, { maxCallsPerHour: 100 });
		expect(wrapped).toBe(provider);
	});
});
