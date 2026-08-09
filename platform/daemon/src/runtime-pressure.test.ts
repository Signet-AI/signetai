import { afterEach, describe, expect, it } from "bun:test";
import {
	bucketAgeSec,
	bucketCpuPressure,
	bucketLatencyMs,
	bucketMemoryPressure,
	bucketQueueDepth,
	bucketWorkerCount,
	buildRuntimePressureEnvelope,
	countActiveWorkers,
	getObservedLatencies,
	getRuntimePressureEnvelope,
	observeDbLatency,
	observeEmbeddingLatency,
	resetRuntimePressureState,
	setRuntimePressureEnvelope,
} from "./runtime-pressure";

afterEach(() => {
	resetRuntimePressureState();
});

describe("runtime pressure buckets", () => {
	it("keeps queue and worker cardinality bounded at each boundary", () => {
		expect(bucketQueueDepth(undefined)).toBe("unknown");
		expect(bucketQueueDepth(0)).toBe("0");
		expect(bucketQueueDepth(10)).toBe("1-10");
		expect(bucketQueueDepth(11)).toBe("11-50");
		expect(bucketQueueDepth(1001)).toBe("1001+");
		expect(bucketWorkerCount(0)).toBe("0");
		expect(bucketWorkerCount(4)).toBe("1-4");
		expect(bucketWorkerCount(5)).toBe("5-16");
		expect(bucketWorkerCount(257)).toBe("257+");
	});

	it("buckets age and latency without exposing exact measurements", () => {
		expect(bucketAgeSec(0)).toBe("<10s");
		expect(bucketAgeSec(60)).toBe("10-60s");
		expect(bucketAgeSec(901)).toBe("901+s");
		expect(bucketLatencyMs(9)).toBe("<10ms");
		expect(bucketLatencyMs(100)).toBe("10-100ms");
		expect(bucketLatencyMs(10_001)).toBe("10001+ms");
		expect(bucketAgeSec(Number.NaN)).toBe("unknown");
		expect(bucketLatencyMs(-1)).toBe("unknown");
	});

	it("maps process resource samples to coarse pressure levels", () => {
		expect(bucketMemoryPressure(100)).toBe("normal");
		expect(bucketMemoryPressure(512)).toBe("high");
		expect(bucketMemoryPressure(undefined)).toBe("unknown");
		expect(bucketCpuPressure(10)).toBe("normal");
		expect(bucketCpuPressure(75)).toBe("high");
		expect(bucketCpuPressure(null)).toBe("unknown");
	});
});

describe("runtime pressure envelope", () => {
	it("retains only the latest bounded latency observations", () => {
		observeDbLatency(12);
		observeEmbeddingLatency(2_500);
		expect(getObservedLatencies()).toEqual({ dbLatencyMs: 12, embeddingLatencyMs: 2_500 });
		observeDbLatency(Number.POSITIVE_INFINITY);
		expect(getObservedLatencies().dbLatencyMs).toBe(12);

		const envelope = buildRuntimePressureEnvelope({
			memoryQueueDepth: 51,
			summaryQueueDepth: 0,
			oldestJobAgeSec: 301,
			activeWorkers: countActiveWorkers([true, true, true, true, true], 1),
			batchSize: 8,
			memoryRssMb: 700,
			cpuPercent: 82,
			recoveryOutcome: "still_degraded",
		});

		expect(envelope).toMatchObject({
			runtimePressureVersion: 1,
			memoryQueueDepthBucket: "51-200",
			summaryQueueDepthBucket: "0",
			oldestJobAgeBucket: "301-900s",
			activeWorkersBucket: "5-16",
			batchSizeBucket: "5-16",
			dbLatencyBucket: "10-100ms",
			embeddingLatencyBucket: "2001-10000ms",
			memoryPressureBucket: "high",
			cpuPressureBucket: "high",
			recoveryOutcome: "still_degraded",
		});
		for (const value of Object.values(envelope)) {
			expect(typeof value === "string" || typeof value === "number").toBe(true);
		}
	});

	it("marks cached context stale without doing work on the read path", () => {
		const envelope = buildRuntimePressureEnvelope({ memoryQueueDepth: 1 });
		setRuntimePressureEnvelope(envelope, 1_000);
		expect(getRuntimePressureEnvelope(2_000).snapshotAgeBucket).toBe("fresh");
		expect(getRuntimePressureEnvelope(16 * 60 * 1000).snapshotAgeBucket).toBe("old");
	});
});
