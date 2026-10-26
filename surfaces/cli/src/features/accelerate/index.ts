import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { formatYaml, readPipelineConfigData } from "@signet/core";
import {
	type Fetcher,
	type ProgressSink,
	downloadVerified,
	extractRemoteZipMember,
	extractTarGzEntries,
	fileMatchesSize,
	readRemoteZipDirectory,
} from "./fetch.js";
import {
	CUDA_LIBRARIES,
	CUDA_PROVIDER,
	ONNXRUNTIME_NODE_TARBALL,
	ONNXRUNTIME_NODE_VERSION,
	ONNXRUNTIME_PLATFORM_FILES,
	type PinnedZip,
	platformKey,
} from "./manifest.js";

export type AccelerationMode = "cpu" | "cuda" | "off";

export interface AcceleratorPaths {
	readonly root: string;
	readonly ortPackageDir: string;
	readonly ortBinDir: string;
	readonly cudaLibDir: string;
}

export function acceleratorPaths(
	agentsDir: string,
	platform: NodeJS.Platform = process.platform,
	arch: string = process.arch,
): AcceleratorPaths {
	const root = join(agentsDir, "runtime", "accelerators");
	const ortPackageDir = join(root, `onnxruntime-node-${ONNXRUNTIME_NODE_VERSION}`);
	return {
		root,
		ortPackageDir,
		ortBinDir: join(ortPackageDir, "bin", "napi-v6", platform, arch),
		cudaLibDir: join(root, "cuda12", "lib"),
	};
}

export interface InstallEvents {
	readonly fetcher?: Fetcher;
	readonly onStep?: (message: string) => void;
	readonly onProgress?: ProgressSink;
}

function cpuRuntimeInstalled(paths: AcceleratorPaths, platform: string): boolean {
	const files = ONNXRUNTIME_PLATFORM_FILES[platform];
	if (!files) return false;
	try {
		const manifest = JSON.parse(readFileSync(join(paths.ortPackageDir, "package.json"), "utf8")) as {
			version?: string;
		};
		if (manifest.version !== ONNXRUNTIME_NODE_VERSION) return false;
	} catch {
		return false;
	}
	return files.every((file) => existsSync(join(paths.ortBinDir, file)));
}

export async function installCpuRuntime(
	paths: AcceleratorPaths,
	events: InstallEvents = {},
	platform: string = platformKey(),
): Promise<"installed" | "present"> {
	const files = ONNXRUNTIME_PLATFORM_FILES[platform];
	if (!files) throw new Error(`no ONNX runtime build is pinned for ${platform}`);
	if (cpuRuntimeInstalled(paths, platform)) return "present";
	const fetcher = events.fetcher ?? fetch;
	const archive = join(paths.root, "downloads", `onnxruntime-node-${ONNXRUNTIME_NODE_VERSION}.tgz`);
	events.onStep?.(`Downloading onnxruntime-node ${ONNXRUNTIME_NODE_VERSION}`);
	await downloadVerified(
		fetcher,
		ONNXRUNTIME_NODE_TARBALL.url,
		ONNXRUNTIME_NODE_TARBALL.integrity,
		archive,
		events.onProgress,
	);
	const [os, arch] = platform.split("-");
	const wanted = new Map<string, string>([["package/package.json", join(paths.ortPackageDir, "package.json")]]);
	for (const file of files) wanted.set(`package/bin/napi-v6/${os}/${arch}/${file}`, join(paths.ortBinDir, file));
	events.onStep?.("Extracting the native runtime for this platform");
	const written = await extractTarGzEntries(archive, wanted);
	rmSync(archive, { force: true });
	const missing = [...wanted.values()].filter((target) => !written.has(target));
	if (missing.length > 0) throw new Error(`the onnxruntime-node archive is missing ${missing.join(", ")}`);
	return "installed";
}

async function sha256File(path: string): Promise<string> {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
	return hash.digest("hex");
}

async function memberPresent(path: string, sha256: string, size: number): Promise<boolean> {
	return fileMatchesSize(path, size) && (await sha256File(path)) === sha256;
}

async function installZipMembers(
	zip: PinnedZip,
	targetDir: string,
	events: InstallEvents,
): Promise<"installed" | "present"> {
	const pending = [];
	for (const member of zip.members) {
		if (!(await memberPresent(join(targetDir, member.name), member.sha256, member.size))) pending.push(member);
	}
	if (pending.length === 0) return "present";
	const fetcher = events.fetcher ?? fetch;
	events.onStep?.(`Downloading ${zip.label} (${pending.map((member) => member.name).join(", ")})`);
	const entries = await readRemoteZipDirectory(fetcher, zip.url);
	for (const member of pending) {
		await extractRemoteZipMember(fetcher, zip.url, entries, member, join(targetDir, member.name), events.onProgress);
	}
	return "installed";
}

export async function installCudaRuntime(
	paths: AcceleratorPaths,
	events: InstallEvents = {},
	platform: string = platformKey(),
): Promise<void> {
	const provider = CUDA_PROVIDER[platform];
	const libraries = CUDA_LIBRARIES[platform];
	if (!provider || !libraries) throw new Error(`no CUDA build is pinned for ${platform}`);
	await installZipMembers(provider, paths.ortBinDir, events);
	mkdirSync(paths.cudaLibDir, { recursive: true });
	for (const library of libraries) await installZipMembers(library, paths.cudaLibDir, events);
}

export interface AccelerationConfigChange {
	readonly file: string;
	readonly embeddingRuntimeChanged: boolean;
	readonly embeddingSkipped: string | null;
	readonly rerankerDevice: string;
}

function asRecord(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function applyAccelerationConfig(
	agentsDir: string,
	mode: AccelerationMode,
	paths: AcceleratorPaths,
): AccelerationConfigChange {
	const { file, root, memory, pipeline } = readPipelineConfigData(agentsDir);
	if (file === null || root === null) throw new Error("No Signet config file found. Run `signet setup` first.");
	const embedding = asRecord(root.embedding);
	const provider = typeof embedding.provider === "string" ? embedding.provider : "native";
	const nativeEmbedding = provider === "native" || provider === "local";
	const previousRuntime = embedding.runtime === "onnxruntime" ? "onnxruntime" : "wasm";
	const nextEmbedding: Record<string, unknown> = { ...embedding };
	if (nativeEmbedding) {
		if (mode === "off") {
			delete nextEmbedding.runtime;
			delete nextEmbedding.onnxRuntimePath;
		} else {
			nextEmbedding.runtime = "onnxruntime";
			nextEmbedding.onnxRuntimePath = paths.ortPackageDir;
		}
	}
	const nextRuntime = nextEmbedding.runtime === "onnxruntime" ? "onnxruntime" : "wasm";
	const reranker: Record<string, unknown> = { ...asRecord(asRecord(pipeline).reranker) };
	delete reranker.cudaLibraryPaths;
	if (mode === "off") {
		reranker.device = "default";
		delete reranker.onnxRuntimePath;
	} else {
		reranker.device = mode;
		reranker.onnxRuntimePath = paths.ortPackageDir;
		if (mode === "cuda") reranker.cudaLibraryPaths = [paths.cudaLibDir];
	}
	const next = {
		...root,
		...(Object.keys(nextEmbedding).length > 0 ? { embedding: nextEmbedding } : {}),
		memory: { ...(memory ?? {}), pipelineV2: { ...(pipeline ?? {}), reranker } },
	};
	writeFileSync(file, formatYaml(next));
	return {
		file,
		embeddingRuntimeChanged: nativeEmbedding && previousRuntime !== nextRuntime,
		embeddingSkipped: nativeEmbedding
			? null
			: `embedding.provider is ${provider}; only native embeddings use this runtime`,
		rerankerDevice: String(reranker.device),
	};
}

export interface AccelerationStatus {
	readonly platform: string;
	readonly cpuRuntimeInstalled: boolean;
	readonly cudaFilesPresent: boolean;
	readonly embeddingRuntime: string;
	readonly rerankerDevice: string;
	readonly paths: AcceleratorPaths;
}

export function readAccelerationStatus(agentsDir: string, platform: string = platformKey()): AccelerationStatus {
	const paths = acceleratorPaths(agentsDir);
	const { root, pipeline } = readPipelineConfigData(agentsDir);
	const embedding = asRecord(root?.embedding);
	const reranker = asRecord(asRecord(pipeline).reranker);
	const libraries = CUDA_LIBRARIES[platform] ?? [];
	const provider = CUDA_PROVIDER[platform];
	return {
		platform,
		cpuRuntimeInstalled: cpuRuntimeInstalled(paths, platform),
		cudaFilesPresent:
			(provider?.members.every((member) => fileMatchesSize(join(paths.ortBinDir, member.name), member.size)) ??
				false) &&
			libraries.every((library) =>
				library.members.every((member) => fileMatchesSize(join(paths.cudaLibDir, member.name), member.size)),
			),
		embeddingRuntime: embedding.runtime === "onnxruntime" ? "onnxruntime" : "wasm",
		rerankerDevice: typeof reranker.device === "string" ? reranker.device : "default",
		paths,
	};
}
