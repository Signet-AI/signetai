import { afterEach, describe, expect, test } from "bun:test";
import {
	computeEventLoopStall,
	getDbRuntimeMetrics,
	getEventLoopLiveness,
	recordDbOperation,
	recordEventLoopLag,
	recordEventLoopHeartbeat,
	resetDbObservability,
	setDbQueueTelemetry,
} from "./observability";

afterEach(() => {
	resetDbObservability();
});

describe("database owner observability", () => {
	test("reports bounded operation percentiles and queue wait separately", () => {
		for (const durationMs of [4, 8, 12, 20]) {
			recordDbOperation({
				owner: "write",
				operation: "test.write",
				durationMs,
				queueWaitMs: durationMs / 2,
				queueDepth: 2,
				queueAgeMs: durationMs,
				estimatedWorkUnits: 1,
				outcome: "completed",
			});
		}
		setDbQueueTelemetry({
			readDepth: 3,
			readMaxDepth: 64,
			readOldestAgeMs: 10,
			readActiveLeases: 4,
			writeDepth: 2,
			writeMaxDepth: 64,
			writeOldestAgeMs: 20,
			writeActive: true,
		});

		const metrics = getDbRuntimeMetrics();
		expect(metrics.operations.write.p95Ms).toBe(20);
		expect(metrics.queueWait.write.p50Ms).toBe(4);
		expect(metrics.queue.writeActive).toBe(true);
		expect(metrics.completed).toBe(4);
	});

	test("event-loop liveness is independent of database queue state", () => {
		setDbQueueTelemetry({
			readDepth: 64,
			readMaxDepth: 64,
			readOldestAgeMs: 5_000,
			readActiveLeases: 16,
			writeDepth: 64,
			writeMaxDepth: 64,
			writeOldestAgeMs: 5_000,
			writeActive: true,
		});
		recordEventLoopLag(100);
		expect(getEventLoopLiveness().status).toBe("ok");
		recordEventLoopLag(2_500);
		expect(getEventLoopLiveness().status).toBe("ok");
	});

	test("classifies frozen-clock heartbeat stalls at the two-second wedge threshold", () => {
		expect(computeEventLoopStall(10_000, 12_000, 2_000)).toEqual({
			status: "ok",
			stallMs: 0,
			stallSeconds: 0,
		});
		expect(computeEventLoopStall(10_000, 12_750, 2_000)).toEqual({
			status: "degraded",
			stallMs: 750,
			stallSeconds: 0.75,
		});
		expect(computeEventLoopStall(10_000, 14_000, 2_000).status).toBe("wedged");
	});

	test("latches an observed late heartbeat until one healthy fire clears it", () => {
		recordEventLoopHeartbeat(10_000, 2_000);
		recordEventLoopHeartbeat(12_750, 2_000);

		expect(getEventLoopLiveness(12_750)).toMatchObject({
			status: "degraded",
			stallMs: 750,
			stallSeconds: 0.75,
		});

		recordEventLoopHeartbeat(14_750, 2_000);
		expect(getEventLoopLiveness(14_750)).toMatchObject({
			status: "ok",
			stallMs: 0,
			stallSeconds: 0,
		});
	});
});
