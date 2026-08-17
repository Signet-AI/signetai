import { expect, spyOn, test } from "bun:test";
import { closeDbAccessor, initDbAccessorLite } from "./db-accessor";
import { handleSynthesisRequest, setSynthesisWorker } from "./memory-synthesis";
import * as memoryLineage from "./memory-lineage";

test("regression: required noise purge failures propagate from synthesis", async () => {
	initDbAccessorLite(":memory:", "");
	setSynthesisWorker(null);
	const purgeSpy = spyOn(memoryLineage, "purgeCanonicalNoiseSessionsOnce").mockRejectedValue(new Error("purge failed"));

	try {
		await expect(handleSynthesisRequest({ trigger: "manual" })).rejects.toThrow("purge failed");
	} finally {
		purgeSpy.mockRestore();
		closeDbAccessor();
	}
});
