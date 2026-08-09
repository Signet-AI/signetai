import { afterEach, describe, expect, it } from "bun:test";
import { isPipelineTimeout, recordPipelineError } from "./pipeline-error";
import { type TelemetryCollector, type TelemetryEvent, setActiveTelemetry } from "./telemetry";

afterEach(() => {
	setActiveTelemetry(undefined);
});

describe("pipeline error classification", () => {
	it("classifies the inference router deadline error as a timeout", () => {
		expect(isPipelineTimeout(new Error("Agent session exceeded the 90000ms deadline"))).toBe(true);
	});

	it("preserves the stage/code telemetry payload for valid pairs", () => {
		const events: TelemetryEvent[] = [];
		const collector: TelemetryCollector = {
			enabled: true,
			record(event, properties): void {
				events.push({ id: "test", event, timestamp: "2026-01-01T00:00:00.000Z", properties });
			},
			reopenSession(): void {},
			recordFirstUse(): void {},
			async flush(): Promise<void> {},
			start(): void {},
			async stop(): Promise<void> {},
			query(): readonly TelemetryEvent[] {
				return events;
			},
			anonymizeAgentId(agentId: string): string {
				return agentId;
			},
		};
		setActiveTelemetry(collector);

		recordPipelineError("embedding", "EMBEDDING_TIMEOUT");

		expect(events).toHaveLength(1);
		expect(events[0]?.event).toBe("pipeline.error");
		expect(events[0]?.properties).toEqual({ stage: "embedding", code: "EMBEDDING_TIMEOUT" });
	});
});
