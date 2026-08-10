import { afterEach, describe, expect, it } from "bun:test";
import {
	effectiveRecallLimit,
	normalizeRecallSurface,
	recallResultState,
	recordRecallAttempt,
	recordRecallOutcome,
} from "./recall-telemetry";
import { setActiveTelemetry } from "./telemetry";

describe("recall outcome telemetry", () => {
	const events: Array<{ event: string; properties: Record<string, unknown> }> = [];

	afterEach(() => {
		events.length = 0;
		setActiveTelemetry(undefined);
	});

	it("normalizes surfaces and result states to bounded enums", () => {
		expect(normalizeRecallSurface("tool_call")).toBe("tool_call");
		expect(normalizeRecallSurface("agent-name", "explicit_api")).toBe("explicit_api");
		expect(recallResultState(0)).toBe("empty");
		expect(recallResultState(2)).toBe("non_empty");
		expect(recallResultState(2, true)).toBe("truncated");
		expect(effectiveRecallLimit(undefined)).toBe(10);
		expect(effectiveRecallLimit(50)).toBe(50);
		expect(effectiveRecallLimit(100)).toBe(50);
	});

	it("records attempt and delivery boundaries without content or identity", () => {
		setActiveTelemetry({
			record: (event, properties) => events.push({ event, properties: { ...properties } }),
		} as never);

		recordRecallAttempt("prompt_injection");
		recordRecallOutcome({
			surface: "prompt_injection",
			resultCount: 3,
			delivery: "injected",
		});

		expect(events).toEqual([
			{ event: "recall.attempted", properties: { surface: "prompt_injection" } },
			{
				event: "recall.outcome",
				properties: {
					surface: "prompt_injection",
					resultState: "non_empty",
					deliveryState: "injected",
					results: 3,
				},
			},
		]);
		for (const event of events) {
			expect(Object.keys(event.properties)).not.toContain("query");
			expect(Object.keys(event.properties)).not.toContain("prompt");
			expect(Object.keys(event.properties)).not.toContain("memoryId");
		}
	});

	it("forces failed outcomes to not delivered", () => {
		setActiveTelemetry({
			record: (event, properties) => events.push({ event, properties: { ...properties } }),
		} as never);
		recordRecallOutcome({ surface: "tool_call", delivery: "consumed", error: true });

		expect(events[0]).toEqual({
			event: "recall.outcome",
			properties: {
				surface: "tool_call",
				resultState: "error",
				deliveryState: "not_delivered",
				results: 0,
			},
		});
	});

	it("records bounded reasons for skipped automatic recall", () => {
		setActiveTelemetry({
			record: (event, properties) => events.push({ event, properties: { ...properties } }),
		} as never);

		recordRecallOutcome({
			surface: "prompt_injection",
			delivery: "not_delivered",
			reason: "skipped_low_signal",
		});

		expect(events[0]).toEqual({
			event: "recall.outcome",
			properties: {
				surface: "prompt_injection",
				resultState: "empty",
				deliveryState: "not_delivered",
				results: 0,
				reason: "skipped_low_signal",
			},
		});
	});
});
