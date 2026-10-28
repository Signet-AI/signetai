import { spawnSyncHidden as spawnSync } from "@signet/core";
import { CUDA_MIN_DRIVER_MAJOR } from "./manifest.js";

export interface NvidiaGpu {
	readonly name: string;
	readonly driver: string;
	readonly driverMajor: number;
	readonly memoryMiB: number;
}

export function parseNvidiaSmi(output: string): NvidiaGpu[] {
	return output
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.flatMap((line) => {
			const [name, driver, memory] = line.split(",").map((part) => part.trim());
			if (!name || !driver) return [];
			const driverMajor = Number.parseInt(driver.split(".")[0] ?? "", 10);
			if (!Number.isFinite(driverMajor)) return [];
			return [{ name, driver, driverMajor, memoryMiB: Number.parseInt(memory ?? "0", 10) || 0 }];
		});
}

export function detectNvidiaGpus(run: typeof spawnSync = spawnSync): NvidiaGpu[] {
	try {
		const result = run(
			"nvidia-smi",
			["--query-gpu=name,driver_version,memory.total", "--format=csv,noheader,nounits"],
			{ encoding: "utf8", timeout: 10_000 },
		);
		if (result.status !== 0 || typeof result.stdout !== "string") return [];
		return parseNvidiaSmi(result.stdout);
	} catch {
		return [];
	}
}

export function cudaSupportProblem(gpus: readonly NvidiaGpu[], platform: string): string | null {
	if (platform !== "linux-x64") return `the CUDA accelerator is available on linux-x64 only (this is ${platform})`;
	if (gpus.length === 0) return "no NVIDIA GPU found (nvidia-smi did not report one)";
	const usable = gpus.filter((gpu) => gpu.driverMajor >= CUDA_MIN_DRIVER_MAJOR);
	if (usable.length === 0) {
		return `NVIDIA driver ${gpus[0]?.driver} is older than ${CUDA_MIN_DRIVER_MAJOR}, which CUDA 12 requires`;
	}
	return null;
}
