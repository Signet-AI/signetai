export interface EmbeddingWasmConfig {
	numThreads?: number;
	wasmPaths?: string;
	wasmBinary?: ArrayBuffer;
}

export function configureEmbeddingWasm(wasm: EmbeddingWasmConfig | undefined, wasmDir: string | null): void {
	if (!wasm) return;
	wasm.numThreads = 1;
	if (wasmDir) wasm.wasmPaths = `${wasmDir}/`;
}
