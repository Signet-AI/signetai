import { describe, expect, it } from "bun:test";
import type { DbAccessor } from "./db-accessor";
import { computeEmbeddingRetryBackoffMs, processEmbeddingCycle, startEmbeddingTracker } from "./embedding-tracker";

const cfg = {
	provider: "ollama",
	model: "mxbai-embed-large",
	dimensions: 1024,
	base_url: "http://localhost:11434",
} as const;

describe("computeEmbeddingRetryBackoffMs", () => {
	it("backs off aggressively for repeated failures", () => {
		expect(computeEmbeddingRetryBackoffMs(1, 1_000)).toBe(60_000);
		expect(computeEmbeddingRetryBackoffMs(2, 1_000)).toBe(5 * 60_000);
		expect(computeEmbeddingRetryBackoffMs(3, 1_000)).toBe(30 * 60_000);
		expect(computeEmbeddingRetryBackoffMs(4, 1_000)).toBe(60 * 60_000);
	});

	it("respects larger poll intervals when they exceed the floor", () => {
		expect(computeEmbeddingRetryBackoffMs(1, 20_000)).toBe(100_000);
		expect(computeEmbeddingRetryBackoffMs(2, 20_000)).toBe(500_000);
	});
});

describe("processEmbeddingCycle", () => {
	it("suppresses repeated attempts across cycles for the same failed payload", async () => {
		const failures = new Map<string, { count: number; retryAt: number }>();
		const rows = [{ id: "mem-1", content: "bad", contentHash: "hash-a", currentModel: null }] as const;
		let calls = 0;

		const fetchEmbeddingFn = async () => {
			calls++;
			return null;
		};

		const first = await processEmbeddingCycle(rows, failures, cfg, 1_000, fetchEmbeddingFn, 1_000);
		const second = await processEmbeddingCycle(rows, failures, cfg, 1_000, fetchEmbeddingFn, 2_000);

		expect(first.failed).toBe(1);
		expect(second.failed).toBe(0);
		expect(second.queueDepth).toBe(0);
		expect(calls).toBe(1);
	});

	it("does not suppress a new content hash for the same memory id", async () => {
		const failures = new Map<string, { count: number; retryAt: number }>();
		const fetchCalls: string[] = [];
		const fetchEmbeddingFn = async (text: string) => {
			fetchCalls.push(text);
			return null;
		};

		await processEmbeddingCycle(
			[{ id: "mem-1", content: "bad-old", contentHash: "hash-old", currentModel: null }],
			failures,
			cfg,
			1_000,
			fetchEmbeddingFn,
			1_000,
		);
		const next = await processEmbeddingCycle(
			[{ id: "mem-1", content: "good-new-shape", contentHash: "hash-new", currentModel: null }],
			failures,
			cfg,
			1_000,
			fetchEmbeddingFn,
			2_000,
		);

		expect(next.queueDepth).toBe(1);
		expect(fetchCalls).toEqual(["bad-old", "good-new-shape"]);
	});

	it("clears suppression on success", async () => {
		const failures = new Map<string, { count: number; retryAt: number }>();
		let ok = false;
		const fetchEmbeddingFn = async () => {
			if (!ok) return null;
			return [0.1, 0.2, 0.3];
		};
		const rows = [{ id: "mem-1", content: "retry-me", contentHash: "hash-a", currentModel: null }] as const;

		await processEmbeddingCycle(rows, failures, cfg, 1_000, fetchEmbeddingFn, 1_000);
		ok = true;
		const retry = await processEmbeddingCycle(rows, failures, cfg, 1_000, fetchEmbeddingFn, 70_000);
		const after = await processEmbeddingCycle(rows, failures, cfg, 1_000, fetchEmbeddingFn, 71_000);

		expect(retry.results).toHaveLength(1);
		expect(after.results).toHaveLength(1);
		expect(after.failed).toBe(0);
	});
});

describe("startEmbeddingTracker", () => {
	it("does not probe or load the provider when no stale rows exist", async () => {
		let providerChecks = 0;
		const accessor = {
			withReadDb<T>(callback: (db: { prepare(): { all(): unknown[] } }) => T): T {
				return callback({ prepare: () => ({ all: () => [] }) });
			},
		} as unknown as DbAccessor;
		const handle = startEmbeddingTracker(
			accessor,
			{ provider: "native", model: "test", dimensions: 3, base_url: "" },
			{ enabled: true, pollMs: 5, batchSize: 8 },
			async () => null,
			async () => {
				providerChecks++;
				return { available: true };
			},
		);
		await Bun.sleep(20);
		await handle.stop();
		expect(providerChecks).toBe(0);
	});
});
