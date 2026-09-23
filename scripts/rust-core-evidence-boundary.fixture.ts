import { test, expect } from "bun:test";

test("unrelated selected test does not invoke database boundary", () => {
	expect(true).toBe(true);
});

// biome-ignore lint/suspicious/noUndeclaredEnvVars: explicit native evidence probe
if (process.env.SIGNET_RUST_CORE_EVIDENCE_PROBE) {
	test("probe invokes core driver", async () => {
		const { Database } = await import("./rust-baseline-proof-core.preload");
		try {
			await new Database("/tmp/evidence-probe").init();
		} catch {
			// /bin/cat is only an invocation probe; its response is intentionally invalid.
		}
	});
}
