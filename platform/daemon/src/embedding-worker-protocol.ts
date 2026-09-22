export interface EmbeddingWorkerInit {
	readonly cacheDir: string;
	readonly wasmDir: string | null;
	readonly transformersRuntimePath: string | null;
	readonly modelId: string;
	readonly expectedDimensions: number;
	readonly remoteHostOverride?: string;
}

export type MainToWorkerMessage =
	| { readonly type: "embed"; readonly id: number; readonly text: string }
	| { readonly type: "checkAvailable"; readonly id: number }
	| { readonly type: "shutdown" };
export interface EmbeddingWorkerStatus {
	readonly initialized: boolean;
	readonly initializing: boolean;
	readonly modelCached: boolean;
	readonly error: string | null;
}

export type WorkerToMainMessage =
	| { readonly type: "ready" }
	| { readonly type: "status"; readonly status: EmbeddingWorkerStatus }
	| { readonly type: "embed_result"; readonly id: number; readonly vector: number[] }
	| { readonly type: "embed_error"; readonly id: number; readonly error: string }
	| { readonly type: "check_result"; readonly id: number; readonly available: boolean; readonly error: string | null }
	| { readonly type: "log"; readonly level: string; readonly message: string; readonly data?: Record<string, unknown> }
	| { readonly type: "error"; readonly error: string; readonly stack?: string };
