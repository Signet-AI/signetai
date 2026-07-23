import { describe, expect, it } from "bun:test";
import { configureEmbeddingWasm } from "./embedding-wasm-config";

describe("configureEmbeddingWasm", () => {
	it("disables the ONNX WASM worker pool before inference", () => {
		const wasm = { numThreads: 4, wasmPaths: "https://cdn.example.invalid/" };

		configureEmbeddingWasm(wasm, "/tmp/signet-native-wasm");

		expect(wasm).toEqual({
			numThreads: 1,
			wasmPaths: "/tmp/signet-native-wasm/",
		});
	});

	it("is a no-op when the selected backend has no WASM environment", () => {
		expect(() => configureEmbeddingWasm(undefined, null)).not.toThrow();
	});
});
