import { expect, mock, test } from "bun:test";
import { closeDbAccessor, initDbAccessorLite } from "./db-accessor";

mock.module("./memory-lineage", () => ({
	NOISE_PURGE_REASON: "test purge",
	purgeCanonicalNoiseSessionsOnce: async () => {
		throw new Error("purge failed");
	},
	renderMemoryProjection: async () => ({ content: "rendered", fileCount: 0, indexBlock: "" }),
}));

const { handleSynthesisRequest, setSynthesisWorker } = await import("./memory-synthesis");

test("regression: required noise purge failures propagate from synthesis", async () => {
	initDbAccessorLite(":memory:", "");
	setSynthesisWorker(null);

	try {
		await expect(handleSynthesisRequest({ trigger: "manual" })).rejects.toThrow("purge failed");
	} finally {
		closeDbAccessor();
	}
});
