import { describe, expect, it } from "bun:test";
import { configureEmbeddingWasm, embeddingWasmThreads } from "./embedding-wasm-config";

describe("configureEmbeddingWasm", () => {
	it("disables the ONNX WASM worker pool on macOS, where Bun's compiled worker pool has hung", () => {
		const wasm = { numThreads: 4, wasmPaths: "https://cdn.example.invalid/" };

		configureEmbeddingWasm(wasm, "/tmp/signet-native-wasm", { platform: "darwin", parallelism: 12 });

		expect(wasm).toEqual({
			numThreads: 1,
			wasmPaths: "/tmp/signet-native-wasm/",
		});
	});

	it("keeps a single WASM thread on Windows", () => {
		const wasm = { numThreads: 4 };
		configureEmbeddingWasm(wasm, null, { platform: "win32", parallelism: 12 });
		expect(wasm.numThreads).toBe(1);
	});

	it("uses up to four WASM threads on Linux so query embeddings are not single-threaded", () => {
		const wasm = { numThreads: 1 };
		configureEmbeddingWasm(wasm, null, { platform: "linux", parallelism: 24 });
		expect(wasm.numThreads).toBe(4);
	});

	it("leaves one core free on small Linux hosts", () => {
		expect(embeddingWasmThreads({ platform: "linux", parallelism: 3 })).toBe(2);
		expect(embeddingWasmThreads({ platform: "linux", parallelism: 1 })).toBe(1);
	});

	it("is a no-op when the selected backend has no WASM environment", () => {
		expect(() => configureEmbeddingWasm(undefined, null)).not.toThrow();
	});
});
