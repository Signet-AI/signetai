import { describe, expect, it } from "bun:test";
import type { LlmProvider } from "@signet/core";
import { RateLimitExceededError, TokenBucketRateLimiter, generateWithTracking, withRateLimit } from "./provider";

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
		const realNow = Date.now;
		let now = 1_000;
		Date.now = () => now;
		try {
			const bucket = new TokenBucketRateLimiter(3600_000, 1);
			expect(await bucket.acquire(0)).toBe(true);
			expect(await bucket.acquire(0)).toBe(false);

			now += 1;
			expect(await bucket.acquire(0)).toBe(true);
			expect(bucket.currentStats().totalConsumed).toBe(2);
			expect(bucket.currentStats().totalThrottled).toBe(1);
		} finally {
			Date.now = realNow;
		}
	});

	it("tracks stats correctly", async () => {
		const bucket = new TokenBucketRateLimiter(100, 10);
		// Burst: consume 10
		for (let i = 0; i < 10; i++) {
			expect(await bucket.acquire(0)).toBe(true);
		}
		// 11th should fail immediately
		expect(await bucket.acquire(0)).toBe(false);
		expect(bucket.currentStats().totalConsumed).toBe(10);
		expect(bucket.currentStats().totalThrottled).toBe(1);
	});

	it("respects waitTimeoutMs", async () => {
		const bucket = new TokenBucketRateLimiter(1, 1);
		await bucket.acquire(0);
		// 1 token/hr = 1 token per 3600s. Even with wait, shouldn't get one in 10ms.
		const result = await bucket.acquire(10);
		expect(result).toBe(false);
		expect(bucket.currentStats().totalThrottled).toBe(1);
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

	it("preserves generate fallback when provider lacks generateWithUsage", async () => {
		const provider = mockProvider("claude-code:haiku");
		const wrapped = withRateLimit(provider, { maxCallsPerHour: 200, burstSize: 20, waitTimeoutMs: 5000 });
		expect(wrapped.generateWithUsage).toBeUndefined();
		const result = await generateWithTracking(wrapped, "test");
		expect(result).toEqual({ text: "ok", usage: null });
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
		if (!wrapped.generateWithUsage) throw new Error("expected generateWithUsage");
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
		const wrapped = withRateLimit(provider, { maxCallsPerHour: 100, burstSize: 10, waitTimeoutMs: 1000 });
		expect(wrapped.name).toBe("claude-code:haiku");
	});

	it("returns provider unwrapped when rate limiting is not configured", () => {
		const provider = mockProvider("claude-code:haiku");
		const wrapped = withRateLimit(provider, undefined);
		expect(wrapped).toBe(provider);
	});

	it("returns provider unwrapped when rate limiting config is empty", () => {
		const provider = mockProvider("claude-code:haiku");
		const wrapped = withRateLimit(provider, {});
		expect(wrapped).toBe(provider);
	});

	it("returns provider unwrapped when maxCallsPerHour is 0", () => {
		const provider = mockProvider("claude-code:haiku");
		const wrapped = withRateLimit(provider, { maxCallsPerHour: 0 });
		expect(wrapped).toBe(provider);
	});

	it("returns provider unwrapped when burstSize is 0", () => {
		const provider = mockProvider("claude-code:haiku");
		const wrapped = withRateLimit(provider, { burstSize: 0, maxCallsPerHour: 100 });
		expect(wrapped).toBe(provider);
	});

	it("returns provider unwrapped for ollama provider", () => {
		const provider = mockProvider("ollama");
		const wrapped = withRateLimit(provider, { maxCallsPerHour: 100 });
		expect(wrapped).toBe(provider);
	});

	it("returns provider unwrapped for command provider", () => {
		const provider = mockProvider("command");
		const wrapped = withRateLimit(provider, { maxCallsPerHour: 100 });
		expect(wrapped).toBe(provider);
	});

	it("falls back to defaults when maxCallsPerHour is undefined", () => {
		const provider = mockProvider("claude-code:haiku");
		const wrapped = withRateLimit(provider, { maxCallsPerHour: undefined, burstSize: 5 });
		expect(wrapped).not.toBe(provider);
	});

	it("falls back to defaults when burstSize is undefined", () => {
		const provider = mockProvider("claude-code:haiku");
		const wrapped = withRateLimit(provider, { burstSize: undefined, maxCallsPerHour: 100 });
		expect(wrapped).not.toBe(provider);
	});

	it("treats explicit waitTimeoutMs: 0 as immediate fail", async () => {
		const provider = mockProvider("claude-code:haiku");
		const wrapped = withRateLimit(provider, {
			maxCallsPerHour: 100,
			burstSize: 1,
			waitTimeoutMs: 0,
		});
		// First call succeeds (burst)
		await wrapped.generate("a");
		// Second call should throw immediately
		await expect(wrapped.generate("b")).rejects.toThrow(RateLimitExceededError);
	});

	it("falls back to default waitTimeoutMs when undefined", async () => {
		const provider = mockProvider("claude-code:haiku");
		const wrapped = withRateLimit(provider, {
			maxCallsPerHour: 100,
			burstSize: 1,
			waitTimeoutMs: undefined,
		});
		expect(wrapped).not.toBe(provider);
	});
});
