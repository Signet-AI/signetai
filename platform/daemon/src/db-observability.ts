/**
 * Bounded, process-local observability for database-owner boundaries.
 *
 * The accessor owns SQLite execution. This module records only bounded numeric
 * samples and stable operation labels, so diagnostics never need to query the
 * database or retain user data while the event loop is under pressure.
 */

export type DbOwner = "read" | "write";
export type DbOperationOutcome = "completed" | "failed" | "cancelled" | "rejected" | "timed_out";

export interface DbOperationSample {
	readonly owner: DbOwner;
	readonly operation: string;
	readonly durationMs: number;
	readonly queueWaitMs: number;
	readonly queueDepth: number;
	readonly queueAgeMs: number | null;
	readonly estimatedWorkUnits: number | null;
	readonly outcome: DbOperationOutcome;
}

export interface DbPercentiles {
	readonly count: number;
	readonly p50Ms: number | null;
	readonly p95Ms: number | null;
	readonly p99Ms: number | null;
	readonly maxMs: number | null;
}

export interface DbQueueTelemetry {
	readonly readDepth: number;
	readonly readMaxDepth: number;
	readonly readOldestAgeMs: number | null;
	readonly readActiveLeases: number;
	readonly writeDepth: number;
	readonly writeMaxDepth: number;
	readonly writeOldestAgeMs: number | null;
	readonly writeActive: boolean;
}

export interface DbRuntimeMetrics {
	readonly version: 1;
	readonly operations: {
		readonly read: DbPercentiles;
		readonly write: DbPercentiles;
	};
	readonly queueWait: {
		readonly read: DbPercentiles;
		readonly write: DbPercentiles;
	};
	readonly queue: DbQueueTelemetry;
	readonly cancelled: number;
	readonly rejected: number;
	readonly timedOut: number;
	readonly failed: number;
	readonly completed: number;
	readonly eventLoopLag: DbPercentiles;
}

const MAX_SAMPLES = 512;
const operationSamples: DbOperationSample[] = [];
const eventLoopLagSamples: number[] = [];
let queue: DbQueueTelemetry = {
	readDepth: 0,
	readMaxDepth: 0,
	readOldestAgeMs: null,
	readActiveLeases: 0,
	writeDepth: 0,
	writeMaxDepth: 0,
	writeOldestAgeMs: null,
	writeActive: false,
};
let cancelled = 0;
let rejected = 0;
let timedOut = 0;
let failed = 0;
let completed = 0;

function appendBounded<T>(items: T[], value: T): void {
	items.push(value);
	if (items.length > MAX_SAMPLES) items.shift();
}

function finite(value: number | null): value is number {
	return value !== null && Number.isFinite(value) && value >= 0;
}

function percentiles(values: readonly number[]): DbPercentiles {
	if (values.length === 0) return { count: 0, p50Ms: null, p95Ms: null, p99Ms: null, maxMs: null };
	const sorted = [...values].sort((a, b) => a - b);
	const pick = (fraction: number): number =>
		sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
	return {
		count: sorted.length,
		p50Ms: pick(0.5),
		p95Ms: pick(0.95),
		p99Ms: pick(0.99),
		maxMs: sorted[sorted.length - 1] ?? null,
	};
}

export function recordDbOperation(sample: DbOperationSample): void {
	if (!finite(sample.durationMs) || !finite(sample.queueWaitMs)) return;
	appendBounded(operationSamples, sample);
	if (sample.outcome === "cancelled") cancelled++;
	else if (sample.outcome === "rejected") rejected++;
	else if (sample.outcome === "timed_out") timedOut++;
	else if (sample.outcome === "failed") failed++;
	else completed++;
}

export function recordEventLoopLag(lagMs: number): void {
	if (!finite(lagMs)) return;
	appendBounded(eventLoopLagSamples, lagMs);
}

export function setDbQueueTelemetry(snapshot: DbQueueTelemetry): void {
	queue = snapshot;
}

export function getDbRuntimeMetrics(): DbRuntimeMetrics {
	return {
		version: 1,
		operations: {
			read: percentiles(
				operationSamples.filter((sample) => sample.owner === "read").map((sample) => sample.durationMs),
			),
			write: percentiles(
				operationSamples.filter((sample) => sample.owner === "write").map((sample) => sample.durationMs),
			),
		},
		queueWait: {
			read: percentiles(
				operationSamples.filter((sample) => sample.owner === "read").map((sample) => sample.queueWaitMs),
			),
			write: percentiles(
				operationSamples.filter((sample) => sample.owner === "write").map((sample) => sample.queueWaitMs),
			),
		},
		queue,
		cancelled,
		rejected,
		timedOut,
		failed,
		completed,
		eventLoopLag: percentiles(eventLoopLagSamples),
	};
}

/** A cheap probe for liveness routes. It never reads database state. */
export function getEventLoopLiveness(): {
	readonly status: "healthy" | "degraded";
	readonly lagP95Ms: number | null;
	readonly lagP99Ms: number | null;
} {
	const lag = percentiles(eventLoopLagSamples);
	return {
		status: lag.p99Ms !== null && lag.p99Ms > 2_000 ? "degraded" : "healthy",
		lagP95Ms: lag.p95Ms,
		lagP99Ms: lag.p99Ms,
	};
}

/** Reset bounded process-local state between daemon test cases. */
export function resetDbObservability(): void {
	operationSamples.length = 0;
	eventLoopLagSamples.length = 0;
	cancelled = 0;
	rejected = 0;
	timedOut = 0;
	failed = 0;
	completed = 0;
	queue = {
		readDepth: 0,
		readMaxDepth: 0,
		readOldestAgeMs: null,
		readActiveLeases: 0,
		writeDepth: 0,
		writeMaxDepth: 0,
		writeOldestAgeMs: null,
		writeActive: false,
	};
}
