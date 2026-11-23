import { afterEach, expect, test } from "bun:test";
import { api } from "./api";
import { dashboardQueryCache, scopedQueryKey } from "./query-cache";

const originalFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = originalFetch;
});

function watchInferenceReads(): { invalidations: () => number; stop: () => void } {
	let count = 0;
	const stop = dashboardQueryCache.subscribe(scopedQueryKey("inference-status"), (invalidated) => {
		if (invalidated) count++;
	});
	return { invalidations: () => count, stop };
}

test("inference route reads do not invalidate the inference queries that issue them", async () => {
	globalThis.fetch = async () => Response.json({ targetRef: "background/default", text: "OK", attempts: [] });
	const watch = watchInferenceReads();
	await api.getInferenceDecision({ operation: "memory_extraction" });
	await api.executeInferenceProbe({
		operation: "memory_extraction",
		prompt: "Respond with exactly OK.",
		maxTokens: 8,
		timeoutMs: 15_000,
		refresh: true,
	});
	watch.stop();
	expect(watch.invalidations()).toBe(0);
});

test("inference config mutations still invalidate inference queries", async () => {
	globalThis.fetch = async () => Response.json({ success: true });
	const watch = watchInferenceReads();
	await api.putSecret("SIGNET_KEY_ZAI", "fixture-key");
	watch.stop();
	expect(watch.invalidations()).toBe(1);
});
