import { availableParallelism } from "node:os";

export interface EmbeddingWasmConfig {
	numThreads?: number;
	wasmPaths?: string;
	wasmBinary?: ArrayBuffer;
}

export interface EmbeddingWasmHost {
	readonly platform: NodeJS.Platform;
	readonly parallelism: number;
}

const MAX_LINUX_WASM_THREADS = 4;

export function embeddingWasmThreads(host: EmbeddingWasmHost): number {
	if (host.platform !== "linux") return 1;
	return Math.max(1, Math.min(MAX_LINUX_WASM_THREADS, host.parallelism - 1));
}

export function configureEmbeddingWasm(
	wasm: EmbeddingWasmConfig | undefined,
	wasmDir: string | null,
	host: EmbeddingWasmHost = { platform: process.platform, parallelism: availableParallelism() },
): void {
	if (!wasm) return;
	wasm.numThreads = embeddingWasmThreads(host);
	if (wasmDir) wasm.wasmPaths = `${wasmDir}/`;
}
