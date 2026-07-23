export interface EmbeddingWasmConfig {
	numThreads?: number;
	wasmPaths?: string;
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
