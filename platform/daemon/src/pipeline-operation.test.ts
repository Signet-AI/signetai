import { afterEach, describe, expect, it } from "bun:test";
import {
	bucketDurationMs,
	bucketQueueAgeMs,
	normalizePipelineCause,
	recordPipelineOperation,
} from "./pipeline-operation";
import { type TelemetryCollector, type TelemetryEvent, setActiveTelemetry } from "./telemetry";

afterEach(() => setActiveTelemetry(undefined));

describe("pipeline operation telemetry", () => {
	it("keeps logical operation incidents bounded independently from attempts", () => {
		const events: TelemetryEvent[] = [];
		const collector = {
			enabled: true,
			record(event, properties): void {
				events.push({ id: "test", event, timestamp: "2026-01-01T00:00:00.000Z", properties });
			},
		} as unknown as TelemetryCollector;
		setActiveTelemetry(collector);

		recordPipelineOperation({
			operationClass: "indexing",
			outcome: "partial",
			accepted: 999,
			skipped: 1,
			retried: 4,
			failed: 17,
			durationMs: 12_345,
			queueAgeMs: 61_000,
			causeFamily: "context_limit",
		});

		expect(events).toHaveLength(1);
		expect(events[0]?.event).toBe("pipeline.operation");
		expect(events[0]?.properties).toEqual({
			operationClass: "indexing",
			outcome: "partial",
			accepted: 999,
			skipped: 1,
			retried: 4,
			failed: 17,
			durationMs: 12345,
			durationBucket: "10-59s",
			queueAgeMs: 61000,
			queueAgeBucket: "1-4m",
			causeFamily: "context_limit",
		});
	});

	it("normalizes context-limit failures separately from provider outages", () => {
		expect(normalizePipelineCause({ status: 400, message: "maximum context length exceeded" })).toBe("context_limit");
		expect(normalizePipelineCause({ status: 503, message: "service unavailable" })).toBe("provider_unavailable");
		expect(normalizePipelineCause({ status: 429, message: "too many requests" })).toBe("rate_limit");
		expect(normalizePipelineCause({ status: 429, message: "insufficient_quota" })).toBe("quota");
		expect(normalizePipelineCause(new Error("request timed out"))).toBe("timeout");
		expect(normalizePipelineCause({ message: "fetch failed", cause: { code: "ECONNREFUSED" } })).toBe(
			"provider_unavailable",
		);
	});

	it("uses stable duration and queue-age buckets", () => {
		expect(bucketDurationMs(99)).toBe("0-99ms");
		expect(bucketDurationMs(60_000)).toBe("1-4m");
		expect(bucketDurationMs(300_000)).toBe("5m+");
		expect(bucketQueueAgeMs(999)).toBe("0-999ms");
		expect(bucketQueueAgeMs(300_000)).toBe("5m+");
	});
});
