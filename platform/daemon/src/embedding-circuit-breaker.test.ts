import { afterEach, describe, expect, it } from "bun:test";
import {
	awaitEmbeddingProviderAvailable,
	recordEmbeddingProviderFailure,
	resetEmbeddingCircuitBreakers,
	shouldEmitEmbeddingProviderNotice,
} from "./embedding-circuit-breaker";

describe("embedding provider circuit breaker", () => {
	afterEach(() => resetEmbeddingCircuitBreakers());

	it("single-flights overlapping provider checks", async () => {
		let calls = 0;
		let release!: (available: boolean) => void;
		const check = () => {
			calls++;
			return new Promise<boolean>((resolve) => {
				release = resolve;
			});
		};
		const first = awaitEmbeddingProviderAvailable("native:test", check, 10_000);
		const second = awaitEmbeddingProviderAvailable("native:test", check, 10_000);
		release(true);
		expect(await Promise.all([first, second])).toEqual([{ available: true }, { available: true }]);
		expect(calls).toBe(1);
	});

	it("emits one notice per active provider-down window", () => {
		recordEmbeddingProviderFailure("native:test", 10_000);
		expect(shouldEmitEmbeddingProviderNotice("native:test", Date.now())).toBe(true);
		expect(shouldEmitEmbeddingProviderNotice("native:test", Date.now())).toBe(false);
	});
});
