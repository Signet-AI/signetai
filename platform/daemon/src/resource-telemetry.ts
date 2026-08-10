/**
 * Privacy-safe resource telemetry derived from local process measurements.
 *
 * Raw resource snapshots stay local to diagnostics. This module is the only
 * projection used by fleet telemetry and deliberately emits stable buckets,
 * not measurements or host capacity.
 */
import type { ResourceSnapshot } from "./resource-monitor";
import type { PressureLevel } from "./system-pressure";

export const RESOURCE_TELEMETRY_VERSION = 1;
/** Resource telemetry is emitted only from the existing daemon heartbeat. */
export const RESOURCE_TELEMETRY_MAX_CADENCE_MS = 5 * 60 * 1000;

export const RESOURCE_CPU_BUCKETS = ["unavailable", "zero", "1-25%", "26-75%", "76-100%", "101-200%", "201+%"] as const;
export type ResourceCpuBucket = (typeof RESOURCE_CPU_BUCKETS)[number];

export const RESOURCE_MEMORY_BUCKETS = [
	"unavailable",
	"zero",
	"1-64MiB",
	"65-128MiB",
	"129-256MiB",
	"257-512MiB",
	"513-1024MiB",
	"1025+MiB",
] as const;
export type ResourceMemoryBucket = (typeof RESOURCE_MEMORY_BUCKETS)[number];

export const RESOURCE_WORKLOAD_CLASSES = ["normal", "dreaming", "critical_pressure"] as const;
export type ResourceWorkloadClass = (typeof RESOURCE_WORKLOAD_CLASSES)[number];

export const RESOURCE_PRESSURE_STATES = ["normal", "elevated", "critical"] as const;
export type ResourcePressureState = (typeof RESOURCE_PRESSURE_STATES)[number];

export interface ResourceUtilizationTelemetry {
	readonly resourceTelemetryVersion: number;
	readonly resourceScope: "process";
	readonly processCpuUtilizationBucket: ResourceCpuBucket;
	readonly processRssBucket: ResourceMemoryBucket;
	readonly processHeapUsedBucket: ResourceMemoryBucket;
	readonly processPhysicalFootprintBucket: ResourceMemoryBucket;
	readonly resourceWorkloadClass: ResourceWorkloadClass;
	readonly resourcePressureState: ResourcePressureState;
}

export interface ResourceUtilizationStats {
	samples: number;
	byCpuBucket: Record<ResourceCpuBucket, number>;
	byRssBucket: Record<ResourceMemoryBucket, number>;
	byHeapUsedBucket: Record<ResourceMemoryBucket, number>;
	byPhysicalFootprintBucket: Record<ResourceMemoryBucket, number>;
	byWorkloadClass: Record<ResourceWorkloadClass, number>;
	byPressureState: Record<ResourcePressureState, number>;
}

function emptyCounts<const T extends string>(values: readonly T[]): Record<T, number> {
	return Object.fromEntries(values.map((value) => [value, 0])) as Record<T, number>;
}

function bucketCpu(value: number | null): ResourceCpuBucket {
	if (value === null || !Number.isFinite(value) || value < 0) return "unavailable";
	if (value === 0) return "zero";
	if (value <= 25) return "1-25%";
	if (value <= 75) return "26-75%";
	if (value <= 100) return "76-100%";
	if (value <= 200) return "101-200%";
	return "201+%";
}

function bucketMemory(value: number | null): ResourceMemoryBucket {
	if (value === null || !Number.isFinite(value) || value < 0) return "unavailable";
	if (value === 0) return "zero";
	if (value <= 64) return "1-64MiB";
	if (value <= 128) return "65-128MiB";
	if (value <= 256) return "129-256MiB";
	if (value <= 512) return "257-512MiB";
	if (value <= 1024) return "513-1024MiB";
	return "1025+MiB";
}

function workloadClass(pressure: PressureLevel, dreamingActive: boolean): ResourceWorkloadClass {
	if (pressure === "critical") return "critical_pressure";
	if (dreamingActive) return "dreaming";
	return "normal";
}

export function buildResourceUtilizationTelemetry(
	snapshot: ResourceSnapshot,
	pressure: PressureLevel,
	dreamingActive: boolean,
): ResourceUtilizationTelemetry {
	return {
		resourceTelemetryVersion: RESOURCE_TELEMETRY_VERSION,
		resourceScope: "process",
		processCpuUtilizationBucket: bucketCpu(snapshot.cpuPercent),
		processRssBucket: bucketMemory(snapshot.rss),
		processHeapUsedBucket: bucketMemory(snapshot.heapUsed),
		processPhysicalFootprintBucket: bucketMemory(snapshot.physicalFootprint),
		resourceWorkloadClass: workloadClass(pressure, dreamingActive),
		resourcePressureState: pressure,
	};
}

export function emptyResourceUtilizationStats(): ResourceUtilizationStats {
	return {
		samples: 0,
		byCpuBucket: emptyCounts(RESOURCE_CPU_BUCKETS),
		byRssBucket: emptyCounts(RESOURCE_MEMORY_BUCKETS),
		byHeapUsedBucket: emptyCounts(RESOURCE_MEMORY_BUCKETS),
		byPhysicalFootprintBucket: emptyCounts(RESOURCE_MEMORY_BUCKETS),
		byWorkloadClass: emptyCounts(RESOURCE_WORKLOAD_CLASSES),
		byPressureState: emptyCounts(RESOURCE_PRESSURE_STATES),
	};
}

function isOneOf<T extends string>(value: unknown, values: readonly T[]): value is T {
	return typeof value === "string" && values.includes(value as T);
}

export function addResourceUtilizationSample(
	stats: ResourceUtilizationStats,
	properties: Readonly<Record<string, unknown>>,
): void {
	if (properties.resourceTelemetryVersion !== RESOURCE_TELEMETRY_VERSION) return;
	if (properties.resourceScope !== "process") return;
	const cpu = properties.processCpuUtilizationBucket;
	const rss = properties.processRssBucket;
	const heap = properties.processHeapUsedBucket;
	const physical = properties.processPhysicalFootprintBucket;
	const workload = properties.resourceWorkloadClass;
	const pressure = properties.resourcePressureState;
	if (!isOneOf(cpu, RESOURCE_CPU_BUCKETS)) return;
	if (!isOneOf(rss, RESOURCE_MEMORY_BUCKETS)) return;
	if (!isOneOf(heap, RESOURCE_MEMORY_BUCKETS)) return;
	if (!isOneOf(physical, RESOURCE_MEMORY_BUCKETS)) return;
	if (!isOneOf(workload, RESOURCE_WORKLOAD_CLASSES)) return;
	if (!isOneOf(pressure, RESOURCE_PRESSURE_STATES)) return;
	stats.samples++;
	stats.byCpuBucket[cpu]++;
	stats.byRssBucket[rss]++;
	stats.byHeapUsedBucket[heap]++;
	stats.byPhysicalFootprintBucket[physical]++;
	stats.byWorkloadClass[workload]++;
	stats.byPressureState[pressure]++;
}
