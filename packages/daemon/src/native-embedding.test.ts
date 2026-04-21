import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";

// Mock @huggingface/transformers to avoid real model downloads
const mockEmbedFn = mock(async (text: string, _opts: unknown) => ({
	data: new Float32Array(768).fill(1 / Math.sqrt(768)),
}));

const mockPipeline = mock(async () => mockEmbedFn);

mock.module("@huggingface/transformers", () => ({
	pipeline: mockPipeline,
	env: { cacheDir: "", allowLocalModels: false },
}));

// Must import after mocking
const { nativeEmbed, checkNativeProvider, shutdownNativeProvider, getNativeProviderStatus } = await import(
	"./native-embedding"
);

describe("native-embedding", () => {
	afterEach(async () => {
		await shutdownNativeProvider();
		mockPipeline.mockClear();
		mockEmbedFn.mockClear();
	});

	it("nativeEmbed returns 768-dim vector", async () => {
		const vec = await nativeEmbed("hello world");
		expect(vec).toHaveLength(768);
		expect(Array.isArray(vec)).toBe(true);
	});

	it("output is approximately L2-normalized", async () => {
		const vec = await nativeEmbed("test normalization");
		const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
		expect(Math.abs(norm - 1.0)).toBeLessThan(0.01);
	});

	it("singleton: second call reuses pipeline", async () => {
		await nativeEmbed("first");
		await nativeEmbed("second");
		// pipeline() should only be called once (singleton init)
		expect(mockPipeline).toHaveBeenCalledTimes(1);
		// embed fn: 1 warm-up + 2 actual calls = 3
		expect(mockEmbedFn).toHaveBeenCalledTimes(3);
	});

	it("concurrent init calls share the same promise", async () => {
		const results = await Promise.all([nativeEmbed("a"), nativeEmbed("b"), nativeEmbed("c")]);
		expect(results).toHaveLength(3);
		for (const vec of results) {
			expect(vec).toHaveLength(768);
		}
		// pipeline() still only called once
		expect(mockPipeline).toHaveBeenCalledTimes(1);
	});

	it("checkNativeProvider reports status correctly", async () => {
		const status = await checkNativeProvider();
		expect(status.available).toBe(true);
		expect(status.dimensions).toBe(768);
		expect(status.modelCached).toBe(true);
	});

	it("shutdownNativeProvider disposes pipeline", async () => {
		await nativeEmbed("init");
		expect(getNativeProviderStatus().initialized).toBe(true);

		await shutdownNativeProvider();
		expect(getNativeProviderStatus().initialized).toBe(false);

		// Next call should re-initialize
		await nativeEmbed("after shutdown");
		expect(mockPipeline).toHaveBeenCalledTimes(2);
	});

	it("getNativeProviderStatus shows correct state before init", async () => {
		const status = getNativeProviderStatus();
		expect(status.initialized).toBe(false);
		expect(status.initializing).toBe(false);
	});

	it("init failure resets promise for retry after shutdown", async () => {
		mockPipeline.mockImplementationOnce(async () => {
			throw new Error("network timeout");
		});

		const status1 = await checkNativeProvider();
		expect(status1.available).toBe(false);
		expect(status1.error).toContain("network timeout");

		await shutdownNativeProvider();

		const status2 = await checkNativeProvider();
		expect(status2.available).toBe(true);
		expect(mockPipeline).toHaveBeenCalledTimes(2);
	});

	it("init failure enforces cooldown before retry", async () => {
		mockPipeline.mockImplementationOnce(async () => {
			throw new Error("network timeout");
		});

		const status1 = await checkNativeProvider();
		expect(status1.available).toBe(false);
		expect(status1.error).toContain("network timeout");

		const status2 = await checkNativeProvider();
		expect(status2.available).toBe(false);
		expect(status2.error).toContain("network timeout");
		expect(mockPipeline).toHaveBeenCalledTimes(1);
	});
});
