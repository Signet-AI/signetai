import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSimpleYaml } from "@signet/core";
import { cudaSupportProblem, parseNvidiaSmi } from "./detect.js";
import { acceleratorPaths, applyAccelerationConfig, readAccelerationStatus } from "./index.js";
import { CUDA_LIBRARIES, CUDA_PROVIDER, ONNXRUNTIME_NODE_VERSION } from "./manifest.js";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function workspace(yaml: string): string {
	const dir = mkdtempSync(join(tmpdir(), "signet-accelerate-config-"));
	dirs.push(dir);
	writeFileSync(join(dir, "agent.yaml"), yaml);
	return dir;
}

interface WrittenConfig {
	readonly embedding: Record<string, unknown>;
	readonly memory: { readonly pipelineV2: { readonly reranker: Record<string, unknown> } };
}

function readYaml(dir: string): WrittenConfig {
	return parseSimpleYaml(readFileSync(join(dir, "agent.yaml"), "utf8")) as unknown as WrittenConfig;
}

describe("accelerator manifest", () => {
	it("pins the onnxruntime-node version the daemon build bundles", () => {
		const daemonRequire = createRequire(new URL("../../../../../platform/daemon/package.json", import.meta.url));
		const transformersRequire = createRequire(daemonRequire.resolve("@huggingface/transformers/package.json"));
		const bundled = JSON.parse(readFileSync(transformersRequire.resolve("onnxruntime-node/package.json"), "utf8")) as {
			version: string;
		};
		expect(ONNXRUNTIME_NODE_VERSION).toBe(bundled.version);
	});

	it("pins every CUDA dependency the ONNX Runtime CUDA provider links against", () => {
		const names = new Set(
			[...(CUDA_LIBRARIES["linux-x64"] ?? []), CUDA_PROVIDER["linux-x64"]].flatMap((zip) =>
				(zip?.members ?? []).map((member) => member.name),
			),
		);
		for (const needed of [
			"libcublasLt.so.12",
			"libcublas.so.12",
			"libcurand.so.10",
			"libcufft.so.11",
			"libcudart.so.12",
			"libcudnn.so.9",
			"libonnxruntime_providers_cuda.so",
			"libonnxruntime_providers_shared.so",
		])
			expect(names.has(needed)).toBe(true);
	});
});

describe("GPU detection", () => {
	it("parses nvidia-smi and gates CUDA on platform and driver", () => {
		const gpus = parseNvidiaSmi("NVIDIA GeForce RTX 3090, 580.95.05, 24576\n");
		expect(gpus).toEqual([
			{ name: "NVIDIA GeForce RTX 3090", driver: "580.95.05", driverMajor: 580, memoryMiB: 24576 },
		]);
		expect(cudaSupportProblem(gpus, "linux-x64")).toBeNull();
		expect(cudaSupportProblem(gpus, "darwin-arm64")).toMatch(/linux-x64 only/);
		expect(cudaSupportProblem([], "linux-x64")).toMatch(/no NVIDIA GPU/);
		expect(cudaSupportProblem(parseNvidiaSmi("Tesla T4, 470.82.01, 15360"), "linux-x64")).toMatch(/older than 525/);
	});
});

describe("acceleration config", () => {
	const base = `embedding:\n  provider: native\n  model: nomic-embed-text-v1.5\n  dimensions: 768\nmemory:\n  pipelineV2:\n    reranker:\n      topN: 20\n`;

	it("enables the native runtime for embeddings and the cross-encoder, keeping other settings", () => {
		const dir = workspace(base);
		const paths = acceleratorPaths(dir);
		const change = applyAccelerationConfig(dir, "cpu", paths);
		const yaml = readYaml(dir);
		expect(yaml.embedding).toMatchObject({
			provider: "native",
			runtime: "onnxruntime",
			onnxRuntimePath: paths.ortPackageDir,
		});
		expect(yaml.memory.pipelineV2.reranker).toMatchObject({
			topN: 20,
			device: "cpu",
			onnxRuntimePath: paths.ortPackageDir,
		});
		expect(change.embeddingRuntimeChanged).toBe(true);
		expect(readAccelerationStatus(dir)).toMatchObject({ embeddingRuntime: "onnxruntime", rerankerDevice: "cpu" });
	});

	it("points the CUDA cross-encoder at the installed libraries and can switch back off", () => {
		const dir = workspace(base);
		const paths = acceleratorPaths(dir);
		applyAccelerationConfig(dir, "cuda", paths);
		expect(readYaml(dir).memory.pipelineV2.reranker).toMatchObject({
			device: "cuda",
			cudaLibraryPaths: [paths.cudaLibDir],
		});
		const off = applyAccelerationConfig(dir, "off", paths);
		const yaml = readYaml(dir);
		expect(yaml.memory.pipelineV2.reranker.device).toBe("default");
		expect(yaml.memory.pipelineV2.reranker.cudaLibraryPaths).toBeUndefined();
		expect(yaml.embedding.runtime).toBeUndefined();
		expect(off.embeddingRuntimeChanged).toBe(true);
	});

	it("leaves remote embedding providers alone", () => {
		const dir = workspace("embedding:\n  provider: ollama\n  model: nomic-embed-text\n");
		const change = applyAccelerationConfig(dir, "cpu", acceleratorPaths(dir));
		expect(readYaml(dir).embedding.runtime).toBeUndefined();
		expect(change.embeddingSkipped).toMatch(/ollama/);
		expect(change.embeddingRuntimeChanged).toBe(false);
	});
});
