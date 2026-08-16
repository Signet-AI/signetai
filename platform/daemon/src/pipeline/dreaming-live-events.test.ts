import { describe, expect, it } from "bun:test";
import {
	DREAMING_LIVE_MAX_EVENTS,
	DREAMING_LIVE_MAX_EVENT_CHARS,
	DREAMING_LIVE_MAX_RAW_CHARS,
	DreamingLiveEventHub,
	boundDreamingLiveValue,
	publishDreamingAgentEvent,
	publishDreamingSessionInfo,
} from "./dreaming-live-events";

describe("Dreaming live event hub", () => {
	it("keeps cursors monotonic and delivers terminal state to subscribers", () => {
		const hub = new DreamingLiveEventHub();
		hub.startPass({ passId: "pass-1", agentId: "agent-a", mode: "incremental" });
		const received: number[] = [];
		const subscription = hub.subscribe("pass-1", 0, (event) => received.push(event.cursor));

		expect(subscription?.replay.map((event) => event.type)).toEqual(["pass_started"]);
		hub.publish("pass-1", "assistant_delta", { delta: "hello" });
		hub.finish("pass-1", "completed", { summary: "done" });

		expect(received).toEqual([2, 3]);
		expect(hub.getSnapshot("pass-1")).toEqual(
			expect.objectContaining({ status: "completed", summary: "done", cursor: 3 }),
		);
		expect(hub.getSubscriberCount("pass-1")).toBe(1);
		subscription?.unsubscribe();
		expect(hub.getSubscriberCount("pass-1")).toBe(0);
	});

	it("reports a replay gap after the bounded buffer is exhausted", () => {
		const hub = new DreamingLiveEventHub();
		hub.startPass({ passId: "pass-2", agentId: "agent-a", mode: "incremental" });
		for (let index = 0; index < DREAMING_LIVE_MAX_EVENTS + 20; index += 1) {
			hub.publish("pass-2", "lifecycle", { index });
		}

		const subscription = hub.subscribe("pass-2", 0, () => {});
		expect(subscription?.gap).toEqual(expect.objectContaining({ requestedCursor: 0, reason: "buffer_exhausted" }));
		expect(subscription?.replay.length).toBe(DREAMING_LIVE_MAX_EVENTS);
		expect(subscription?.replay[0]?.cursor).toBeGreaterThan(1);
		subscription?.unsubscribe();
	});

	it("bounds raw payloads and translates Pi lifecycle events without awaiting", () => {
		const hub = new DreamingLiveEventHub();
		hub.startPass({ passId: "pass-3", agentId: "agent-a", mode: "incremental" });
		const events: Array<{ type: string; data: Readonly<Record<string, unknown>> }> = [];
		const subscription = hub.subscribe("pass-3", null, (event) => events.push(event));

		publishDreamingAgentEvent(
			"pass-3",
			{
				type: "tool_execution_start",
				toolCallId: "tool-1",
				toolName: "search_evidence",
				arguments: "x".repeat(DREAMING_LIVE_MAX_RAW_CHARS * 2),
			},
			hub,
		);
		publishDreamingSessionInfo("pass-3", { sessionId: "session-1", systemPrompt: "system".repeat(10_000) }, hub);

		const raw = events.find((event) => event.type === "tool_start")?.data.raw;
		const sessionRaw = events.find((event) => event.type === "session_info")?.data.raw;
		expect(JSON.stringify(raw).length).toBeLessThanOrEqual(DREAMING_LIVE_MAX_RAW_CHARS + 100);
		expect(JSON.stringify(sessionRaw).length).toBeLessThanOrEqual(DREAMING_LIVE_MAX_RAW_CHARS + 100);
		for (const event of events)
			expect(JSON.stringify(event.data).length).toBeLessThanOrEqual(DREAMING_LIVE_MAX_EVENT_CHARS);
		expect(boundDreamingLiveValue("x".repeat(DREAMING_LIVE_MAX_RAW_CHARS * 2))).toEqual(
			expect.objectContaining({ truncated: true }),
		);
		subscription?.unsubscribe();
	});
});
