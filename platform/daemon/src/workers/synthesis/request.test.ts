import { expect, spyOn, test } from "bun:test";
import { closeDbAccessor, initDbAccessorLite } from "../../db/owner/accessor";
import { handleSynthesisRequest, setSynthesisWorker } from "./request";
import * as memoryLineage from "../../sources/lifecycle/memory-lineage";

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
