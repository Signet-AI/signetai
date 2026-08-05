import { afterEach, describe, expect, it } from "bun:test";
import { checkEmbeddingProvider } from "./utils";

describe("checkEmbeddingProvider native kill-switch (#1073)", () => {
	it("reports native unavailable without touching the native worker when warmNative is false", async () => {
		const status = await checkEmbeddingProvider({
			provider: "native",
			model: "nomic-embed-text-v1.5",
			dimensions: 768,
			base_url: "",
			warmNative: false,
		});
		expect(status.available).toBe(false);
		expect(status.error).toContain("warmNative: false");
	});
});
