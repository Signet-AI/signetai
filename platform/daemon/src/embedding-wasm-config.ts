export interface EmbeddingWasmConfig {
	numThreads?: number;
	wasmPaths?: string;
	/** Preloaded wasm binary — onnxruntime-web 1.26 loads the .wasm via fetch()
	 *  instead of the 1.22-era fs.readFileSync, so the compiled binary must
	 *  hand the materialized binary over directly or session creation dies
	 *  with `fetch() URL is invalid` on the filesystem path. */
	wasmBinary?: ArrayBuffer;
}

export function configureEmbeddingWasm(wasm: EmbeddingWasmConfig | undefined, wasmDir: string | null): void {
	if (!wasm) return;
	// ONNX Runtime defaults Node-like environments to up to four WASM
	// threads. Bun's compiled worker runtime has exhibited thread-pool hangs
	// on both Intel and Apple Silicon Macs, so keep SIMD but disable the
	// auxiliary Emscripten worker pool. ONNX Runtime documents numThreads=1
	// as the no-worker configuration.
	wasm.numThreads = 1;
	if (wasmDir) wasm.wasmPaths = `${wasmDir}/`;
}
