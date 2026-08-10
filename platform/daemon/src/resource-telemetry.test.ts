import { describe, expect, it } from "bun:test";
import type { ResourceSnapshot } from "./resource-monitor";
import {
	RESOURCE_CPU_BUCKETS,
	RESOURCE_MEMORY_BUCKETS,
	RESOURCE_TELEMETRY_MAX_CADENCE_MS,
	RESOURCE_WORKLOAD_CLASSES,
	addResourceUtilizationSample,
	buildResourceUtilizationTelemetry,
	emptyResourceUtilizationStats,
} from "./resource-telemetry";

function snapshot(overrides: Partial<ResourceSnapshot> = {}): ResourceSnapshot {
	return {
		total: 10,
		memoryMd: 1,
		sockets: 2,
		inotify: 1,
		pipes: 1,
		db: 1,
		other: 4,
		rss: 100,
		heapUsed: 200,
		physicalFootprint: 300,
		peakPhysicalFootprint: 400,
		cpuPercent: 50,
		...overrides,
	};
}

describe("buildResourceUtilizationTelemetry", () => {
	it("uses the existing heartbeat cadence and never adds a high-frequency timer", () => {
		expect(RESOURCE_TELEMETRY_MAX_CADENCE_MS).toBe(5 * 60 * 1000);
	});

	it("maps CPU boundaries, including process values above one host core", () => {
		const values: ReadonlyArray<[number | null, string]> = [
			[null, "unavailable"],
			[0, "zero"],
			[25, "1-25%"],
			[25.1, "26-75%"],
			[75, "26-75%"],
			[75.1, "76-100%"],
			[100, "76-100%"],
			[100.1, "101-200%"],
			[200, "101-200%"],
			[200.1, "201+%"],
		];
		for (const [cpuPercent, expected] of values) {
			expect(
				buildResourceUtilizationTelemetry(snapshot({ cpuPercent }), "normal", false).processCpuUtilizationBucket,
			).toBe(expected);
		}
	});

	it("maps memory boundaries consistently for RSS, heap, and physical footprint", () => {
		const values: ReadonlyArray<[number | null, string]> = [
			[null, "unavailable"],
			[0, "zero"],
			[64, "1-64MiB"],
			[64.1, "65-128MiB"],
			[128, "65-128MiB"],
			[128.1, "129-256MiB"],
			[256, "129-256MiB"],
			[256.1, "257-512MiB"],
			[512, "257-512MiB"],
			[512.1, "513-1024MiB"],
			[1024, "513-1024MiB"],
			[1024.1, "1025+MiB"],
		];
		for (const [memory, expected] of values) {
			const result = buildResourceUtilizationTelemetry(
				snapshot({ rss: memory, heapUsed: memory, physicalFootprint: memory }),
				"normal",
				false,
			);
			expect(result.processRssBucket).toBe(expected);
			expect(result.processHeapUsedBucket).toBe(expected);
			expect(result.processPhysicalFootprintBucket).toBe(expected);
		}
	});

	it("distinguishes unavailable macOS physical footprint from a measured zero", () => {
		expect(
			buildResourceUtilizationTelemetry(snapshot({ physicalFootprint: null }), "normal", false)
				.processPhysicalFootprintBucket,
		).toBe("unavailable");
		expect(
			buildResourceUtilizationTelemetry(snapshot({ physicalFootprint: 0 }), "normal", false)
				.processPhysicalFootprintBucket,
		).toBe("zero");
	});

	it("uses existing workload context with critical pressure taking precedence", () => {
		expect(buildResourceUtilizationTelemetry(snapshot(), "normal", false).resourceWorkloadClass).toBe("normal");
		expect(buildResourceUtilizationTelemetry(snapshot(), "elevated", true).resourceWorkloadClass).toBe("dreaming");
		expect(buildResourceUtilizationTelemetry(snapshot(), "critical", true).resourceWorkloadClass).toBe(
			"critical_pressure",
		);
		expect(buildResourceUtilizationTelemetry(snapshot(), "critical", false).resourcePressureState).toBe("critical");
	});

	it("emits only bounded process telemetry fields", () => {
		const result = buildResourceUtilizationTelemetry(snapshot(), "normal", false);
		expect(result).toEqual({
			resourceTelemetryVersion: 1,
			resourceScope: "process",
			processCpuUtilizationBucket: "26-75%",
			processRssBucket: "65-128MiB",
			processHeapUsedBucket: "129-256MiB",
			processPhysicalFootprintBucket: "257-512MiB",
			resourceWorkloadClass: "normal",
			resourcePressureState: "normal",
		});
		expect(Object.keys(result)).not.toContain("rss");
		expect(Object.keys(result)).not.toContain("heapUsed");
		expect(Object.keys(result)).not.toContain("cpuPercent");
		expect(Object.keys(result)).not.toContain("physicalFootprint");
		expect(RESOURCE_CPU_BUCKETS).toContain(result.processCpuUtilizationBucket);
		expect(RESOURCE_MEMORY_BUCKETS).toContain(result.processRssBucket);
		expect(RESOURCE_WORKLOAD_CLASSES).toContain(result.resourceWorkloadClass);
	});
});

describe("resource utilization aggregation", () => {
	it("counts only complete, versioned process samples", () => {
		const stats = emptyResourceUtilizationStats();
		const properties = buildResourceUtilizationTelemetry(snapshot(), "elevated", true);
		addResourceUtilizationSample(stats, properties);
		addResourceUtilizationSample(stats, { ...properties, resourceTelemetryVersion: 2 });
		addResourceUtilizationSample(stats, { ...properties, resourceScope: "host" });
		addResourceUtilizationSample(stats, { ...properties, processRssBucket: "not-a-bucket" });
		expect(stats.samples).toBe(1);
		expect(stats.byCpuBucket["26-75%"]).toBe(1);
		expect(stats.byWorkloadClass.dreaming).toBe(1);
		expect(stats.byPressureState.elevated).toBe(1);
	});
});
