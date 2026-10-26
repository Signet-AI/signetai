import { afterEach, describe, expect, it, mock } from "bun:test";
import type { EmbeddingHandleOptions, EmbeddingWorkerHandle } from "./embedding-worker-handle";

interface FakeHandleState {
	initialized: boolean;
	lastError: string | null;
}

const created: EmbeddingHandleOptions[] = [];
const stopped: string[] = [];

function fakeHandle(options: EmbeddingHandleOptions): EmbeddingWorkerHandle {
	const cuda = options.device === "cuda";
	const state: FakeHandleState = { initialized: !cuda, lastError: null };
	return {
		embed: async () => [],
		rerank: async (_query, documents) => documents.map((_, index) => (cuda ? 100 + index : index)),
		checkAvailable: async () => {
			if (cuda) state.lastError = "OrtSessionOptionsAppendExecutionProvider_Cuda: Failed to load shared library";
			return { available: !cuda, dimensions: 0, modelCached: !cuda, error: state.lastError ?? undefined };
		},
		getStatus: () => ({ initialized: state.initialized, initializing: false, modelCached: state.initialized }),
		getLastError: () => state.lastError,
		isPermanentlyDisabled: () => false,
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

	it("uses the default runtime without CUDA settings when the device is default", async () => {
		const scores = await nativeRerank("model", "q", ["a", "b", "c"]);
		expect(scores).toEqual([0, 1, 2]);
		expect(created[0]?.device).toBeUndefined();
		expect(nativeRerankActiveDevice()).toBe("default");
	});
});
