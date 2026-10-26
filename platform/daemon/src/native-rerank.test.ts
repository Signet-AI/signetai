import { afterEach, describe, expect, it, mock } from "bun:test";
import type { EmbeddingHandleOptions, EmbeddingWorkerHandle } from "./embedding-worker-handle";

interface FakeHandleState {
	initialized: boolean;
	lastError: string | null;
	disabled: boolean;
	reranks: number;
}

const created: EmbeddingHandleOptions[] = [];
const stopped: string[] = [];

function fakeHandle(options: EmbeddingHandleOptions): EmbeddingWorkerHandle {
	const cuda = options.device === "cuda";
	const cudaWorks = cuda && options.onnxRuntimePath?.includes("working") === true;
	const state: FakeHandleState = { initialized: !cuda || cudaWorks, lastError: null, disabled: false, reranks: 0 };
	return {
		embed: async () => [],
		rerank: async (_query, documents) => {
			state.reranks++;
			if (cudaWorks && state.reranks === 2) {
				state.disabled = true;
				state.initialized = false;
				state.lastError = "rerank timed out after 30000ms (worker isolated; provider disabled until daemon restart)";
				throw new Error(state.lastError);
			}
			return documents.map((_, index) => (cuda ? 100 + index : index));
		},
		checkAvailable: async () => {
			if (cuda && !cudaWorks)
				state.lastError = "OrtSessionOptionsAppendExecutionProvider_Cuda: Failed to load shared library";
			return {
				available: state.initialized,
				dimensions: 0,
				modelCached: state.initialized,
				error: state.lastError ?? undefined,
			};
		},
		getStatus: () => ({ initialized: state.initialized, initializing: false, modelCached: state.initialized }),
		getLastError: () => state.lastError,
		isPermanentlyDisabled: () => state.disabled,
		stop: async () => {
			stopped.push(cuda ? "cuda" : "default");
		},
	};
}

mock.module("./embedding-worker-handle", () => ({
	createEmbeddingWorkerHandle: async (options: EmbeddingHandleOptions) => {
		created.push(options);
		return fakeHandle(options);
	},
}));

const { nativeRerank, nativeRerankActiveDevice, shutdownNativeReranker } = await import("./native-rerank");

const cudaRuntime = {
	device: "cuda" as const,
	onnxRuntimePath: "/opt/ort/node_modules/onnxruntime-node",
	cudaLibraryPaths: ["/opt/cuda12/lib"],
};

afterEach(async () => {
	await shutdownNativeReranker();
	created.length = 0;
	stopped.length = 0;
});

describe("nativeRerank runtime selection", () => {
	it("passes the CUDA runtime settings to the cross-encoder worker", async () => {
		await expect(nativeRerank("model", "q", ["a"], cudaRuntime)).rejects.toThrow(/loading/);
		expect(created[0]).toMatchObject({
			task: "rerank",
			device: "cuda",
			onnxRuntimePath: "/opt/ort/node_modules/onnxruntime-node",
			cudaLibraryPaths: ["/opt/cuda12/lib"],
		});
	});

	it("falls back to the default runtime when the CUDA worker cannot initialize, instead of reporting loading forever", async () => {
		await expect(nativeRerank("model", "q", ["a", "b"], cudaRuntime)).rejects.toThrow(/loading/);
		const scores = await nativeRerank("model", "q", ["a", "b"], cudaRuntime);
		expect(scores).toEqual([0, 1]);
		expect(nativeRerankActiveDevice()).toBe("default");
		expect(created.map((options) => options.device ?? "default")).toEqual(["cuda", "default"]);
		expect(stopped).toEqual(["cuda"]);

		await nativeRerank("model", "q", ["a"], cudaRuntime);
		expect(created).toHaveLength(2);
	});

	it("keeps CUDA after a rerank timeout on a worker that initialized, instead of downgrading for the daemon's lifetime", async () => {
		const runtime = { ...cudaRuntime, onnxRuntimePath: "/opt/ort-working/node_modules/onnxruntime-node" };
		expect(await nativeRerank("model", "q", ["a", "b"], runtime)).toEqual([100, 101]);
		expect(nativeRerankActiveDevice()).toBe("cuda");
		await expect(nativeRerank("model", "q", ["a"], runtime)).rejects.toThrow(/timed out/);
		await expect(nativeRerank("model", "q", ["a"], runtime)).rejects.toThrow(/timed out/);

		expect(created.map((options) => options.device ?? "default")).toEqual(["cuda"]);
		expect(nativeRerankActiveDevice()).toBe("cuda");
	});

	it("uses the default runtime without CUDA settings when the device is default", async () => {
		const scores = await nativeRerank("model", "q", ["a", "b", "c"]);
		expect(scores).toEqual([0, 1, 2]);
		expect(created[0]?.device).toBeUndefined();
		expect(nativeRerankActiveDevice()).toBe("default");
	});
});
