/**
 * Bounded runtime context for daemon liveness telemetry.
 *
 * This module deliberately stores only the latest coarse observations. The
 * event-loop wedge path must be able to report context without doing database,
 * filesystem, or provider work while the event loop is recovering.
 */

export type PressureBucket =
	| "unknown"
	| "none"
	| "normal"
	| "elevated"
	| "high"
	| "critical"
	| "0"
	| "1-10"
	| "11-50"
	| "51-200"
	| "201-1000"
	| "1001+"
	| "1-4"
	| "5-16"
	| "17-64"
	| "65-256"
	| "257+"
	| "<10ms"
	| "10-100ms"
	| "101-500ms"
	| "501-2000ms"
	| "2001-10000ms"
	| "10001+ms"
	| "<10s"
	| "10-60s"
	| "61-300s"
	| "301-900s"
	| "901+s"
	| "fresh"
	| "stale"
	| "old";

export type PressureRecoveryOutcome = "not_observed" | "recovered" | "restarted" | "still_degraded";

export interface RuntimePressureEnvelope {
	readonly runtimePressureVersion: 1;
	readonly memoryQueueDepthBucket: PressureBucket;
	readonly summaryQueueDepthBucket: PressureBucket;
	readonly oldestJobAgeBucket: PressureBucket;
	readonly activeWorkersBucket: PressureBucket;
	readonly batchSizeBucket: PressureBucket;
	readonly dbLatencyBucket: PressureBucket;
	readonly embeddingLatencyBucket: PressureBucket;
	readonly memoryPressureBucket: PressureBucket;
	readonly cpuPressureBucket: PressureBucket;
	readonly recoveryOutcome: PressureRecoveryOutcome;
	readonly snapshotAgeBucket: PressureBucket;
}

export interface RuntimePressureInputs {
	readonly memoryQueueDepth?: number;
	readonly summaryQueueDepth?: number;
	readonly oldestJobAgeSec?: number;
	readonly activeWorkers?: number;
	readonly batchSize?: number;
	readonly memoryRssMb?: number;
	readonly cpuPercent?: number | null;
	readonly dbLatencyMs?: number | null;
	readonly embeddingLatencyMs?: number | null;
	readonly recoveryOutcome?: PressureRecoveryOutcome;
}

const EMPTY_ENVELOPE: RuntimePressureEnvelope = {
	runtimePressureVersion: 1,
	memoryQueueDepthBucket: "unknown",
	summaryQueueDepthBucket: "unknown",
	oldestJobAgeBucket: "unknown",
	activeWorkersBucket: "unknown",
	batchSizeBucket: "unknown",
	dbLatencyBucket: "unknown",
	embeddingLatencyBucket: "unknown",
	memoryPressureBucket: "unknown",
	cpuPressureBucket: "unknown",
	recoveryOutcome: "not_observed",
	snapshotAgeBucket: "unknown",
};

let latestDbLatencyMs: number | null = null;
let latestEmbeddingLatencyMs: number | null = null;
let latestEnvelope: RuntimePressureEnvelope = EMPTY_ENVELOPE;
let latestEnvelopeAt = 0;

function finite(value: number | null | undefined): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function bucketQueueDepth(value: number | null | undefined): PressureBucket {
	if (!finite(value)) return "unknown";
	if (value === 0) return "0";
	if (value <= 10) return "1-10";
	if (value <= 50) return "11-50";
	if (value <= 200) return "51-200";
	if (value <= 1000) return "201-1000";
	return "1001+";
}

export function bucketWorkerCount(value: number | null | undefined): PressureBucket {
	if (!finite(value)) return "unknown";
	if (value === 0) return "0";
	if (value <= 4) return "1-4";
	if (value <= 16) return "5-16";
	if (value <= 64) return "17-64";
	if (value <= 256) return "65-256";
	return "257+";
}

export function bucketLatencyMs(value: number | null | undefined): PressureBucket {
	if (!finite(value)) return "unknown";
	if (value < 10) return "<10ms";
	if (value <= 100) return "10-100ms";
	if (value <= 500) return "101-500ms";
	if (value <= 2000) return "501-2000ms";
	if (value <= 10000) return "2001-10000ms";
	return "10001+ms";
}

export function bucketAgeSec(value: number | null | undefined): PressureBucket {
	if (!finite(value)) return "unknown";
	if (value < 10) return "<10s";
	if (value <= 60) return "10-60s";
	if (value <= 300) return "61-300s";
	if (value <= 900) return "301-900s";
	return "901+s";
}

export function bucketBatchSize(value: number | null | undefined): PressureBucket {
	return bucketWorkerCount(value);
}

export function bucketMemoryPressure(rssMb: number | null | undefined): PressureBucket {
	if (!finite(rssMb)) return "unknown";
	if (rssMb < 256) return "normal";
	if (rssMb < 512) return "elevated";
	if (rssMb < 1024) return "high";
	return "critical";
}

export function bucketCpuPressure(cpuPercent: number | null | undefined): PressureBucket {
	if (!finite(cpuPercent)) return "unknown";
	if (cpuPercent < 25) return "normal";
	if (cpuPercent < 75) return "elevated";
	if (cpuPercent < 100) return "high";
	return "critical";
}

function snapshotAgeBucket(ageMs: number): PressureBucket {
	if (!finite(ageMs)) return "unknown";
	if (ageMs < 2 * 60 * 1000) return "fresh";
	if (ageMs < 15 * 60 * 1000) return "stale";
	return "old";
}

export function countActiveWorkers(runningWorkers: readonly boolean[], activeLlmCalls = 0): number {
	const workerCount = runningWorkers.filter(Boolean).length;
	return workerCount + (finite(activeLlmCalls) ? activeLlmCalls : 0);
}

export function observeDbLatency(latencyMs: number): void {
	if (finite(latencyMs)) latestDbLatencyMs = latencyMs;
}

export function observeEmbeddingLatency(latencyMs: number): void {
	if (finite(latencyMs)) latestEmbeddingLatencyMs = latencyMs;
}

export function getObservedLatencies(): {
	readonly dbLatencyMs: number | null;
	readonly embeddingLatencyMs: number | null;
} {
	return { dbLatencyMs: latestDbLatencyMs, embeddingLatencyMs: latestEmbeddingLatencyMs };
}

export function buildRuntimePressureEnvelope(input: RuntimePressureInputs = {}): RuntimePressureEnvelope {
	const latencies = getObservedLatencies();
	const envelope: RuntimePressureEnvelope = {
		runtimePressureVersion: 1,
		memoryQueueDepthBucket: bucketQueueDepth(input.memoryQueueDepth),
		summaryQueueDepthBucket: bucketQueueDepth(input.summaryQueueDepth),
		oldestJobAgeBucket: bucketAgeSec(input.oldestJobAgeSec),
		activeWorkersBucket: bucketWorkerCount(input.activeWorkers),
		batchSizeBucket: bucketBatchSize(input.batchSize),
		dbLatencyBucket: bucketLatencyMs(input.dbLatencyMs ?? latencies.dbLatencyMs),
		embeddingLatencyBucket: bucketLatencyMs(input.embeddingLatencyMs ?? latencies.embeddingLatencyMs),
		memoryPressureBucket: bucketMemoryPressure(input.memoryRssMb),
		cpuPressureBucket: bucketCpuPressure(input.cpuPercent),
		recoveryOutcome: input.recoveryOutcome ?? "not_observed",
		snapshotAgeBucket: "fresh",
	};
	return envelope;
}

export function setRuntimePressureEnvelope(envelope: RuntimePressureEnvelope, now = Date.now()): void {
	latestEnvelope = envelope;
	latestEnvelopeAt = finite(now) ? now : 0;
}

export function getRuntimePressureEnvelope(now = Date.now()): RuntimePressureEnvelope {
	return {
		...latestEnvelope,
		snapshotAgeBucket: latestEnvelopeAt === 0 ? "unknown" : snapshotAgeBucket(Math.max(0, now - latestEnvelopeAt)),
	};
}

/** Test-only reset that also protects daemon tests from cross-case state. */
export function resetRuntimePressureState(): void {
	latestDbLatencyMs = null;
	latestEmbeddingLatencyMs = null;
	latestEnvelope = EMPTY_ENVELOPE;
	latestEnvelopeAt = 0;
}
