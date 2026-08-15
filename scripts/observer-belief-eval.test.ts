import { describe, expect, it } from "bun:test";
import { runObserverBeliefEval } from "./observer-belief-eval";

describe("observer-belief eval", () => {
	it("derives divergent observer assertions from raw interleaved messages", async () => {
		const result = await runObserverBeliefEval();

		expect(result.passed).toBe(result.total);
		expect(result.results.map((item) => item.name)).toContain(
			"raw interleaved messages produce one provider-derived assertion per observer",
		);
	});
});
