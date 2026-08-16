import { describe, expect, it } from "bun:test";
import { DREAMING_LIVE_MAX_PAYLOAD_CHARS, normalizeDreamingLiveEvent } from "./dreaming-live-events";

const PASS_ID = "pass-live-1";

describe("dreaming live event normalization (#1601)", () => {
	it("maps the context sentinel to system_instructions with observed model context", () => {
		expect(
			normalizeDreamingLiveEvent(
				{ type: "signet_context", instructions: "consolidate", modelLabel: "test-model" },
				PASS_ID,
			),
		).toEqual({
			type: "system_instructions",
			passId: PASS_ID,
			instructions: "consolidate",
			modelLabel: "test-model",
		});
	});

	it("maps assistant text deltas to assistant_delta events", () => {
		expect(
			normalizeDreamingLiveEvent(
				{ type: "message_update", assistantMessageEvent: { type: "text_delta", text: "delta" } },
				PASS_ID,
			),
		).toEqual({ type: "assistant_delta", passId: PASS_ID, text: "delta" });
	});

	it("maps thinking deltas to reasoning_delta events", () => {
		expect(
			normalizeDreamingLiveEvent(
				{ type: "message_update", assistantMessageEvent: { type: "thinking_delta", thinking: "thought" } },
				PASS_ID,
			),
		).toEqual({ type: "reasoning_delta", passId: PASS_ID, text: "thought" });
	});

	it("drops deltas that carry no text", () => {
		expect(
			normalizeDreamingLiveEvent(
				{ type: "message_update", assistantMessageEvent: { type: "text_delta" } },
				PASS_ID,
			),
		).toBeNull();
	});

	it("maps completed assistant turns to assistant_turn with optional reasoning", () => {
		expect(
			normalizeDreamingLiveEvent(
				{
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "final" }, { type: "thinking", thinking: "why" }],
					},
				},
				PASS_ID,
			),
		).toEqual({ type: "assistant_turn", passId: PASS_ID, text: "final", reasoning: "why" });
	});

	it("drops user-role turns", () => {
		expect(
			normalizeDreamingLiveEvent(
				{ type: "message_end", message: { role: "user", content: [{ type: "text", text: "x" }] } },
				PASS_ID,
			),
		).toBeNull();
	});

	it("maps tool events to tool_start/tool_update/tool_end with bounded payloads", () => {
		expect(
			normalizeDreamingLiveEvent(
				{ type: "tool_execution_start", toolName: "recall", args: { q: "x" } },
				PASS_ID,
			),
		).toEqual({ type: "tool_start", passId: PASS_ID, tool: "recall", args: { q: "x" } });
		expect(
			normalizeDreamingLiveEvent(
				{ type: "tool_execution_update", toolName: "recall", partialResult: "partial" },
				PASS_ID,
			),
		).toEqual({ type: "tool_update", passId: PASS_ID, tool: "recall", partial: "partial" });
		expect(
			normalizeDreamingLiveEvent(
				{ type: "tool_execution_end", toolName: "recall", result: "done", isError: true },
				PASS_ID,
			),
		).toEqual({ type: "tool_end", passId: PASS_ID, tool: "recall", isError: true, result: "done" });
	});

	it("bounds oversized payloads to a preview marker", () => {
		const big = `{"data":"${"x".repeat(DREAMING_LIVE_MAX_PAYLOAD_CHARS + 1)}"}`;
		const out = normalizeDreamingLiveEvent(
			{ type: "tool_execution_end", toolName: "recall", result: big, isError: false },
			PASS_ID,
		);
		expect(out).toEqual({
			type: "tool_end",
			passId: PASS_ID,
			tool: "recall",
			isError: false,
			result: {
				__truncated: true,
				preview: String(big).slice(0, DREAMING_LIVE_MAX_PAYLOAD_CHARS),
			},
		});
	});

	it("drops control-plane and unmodeled events", () => {
		for (const event of [
			{ type: "prompt", messages: [] },
			{ type: "abort" },
			{ type: "error", error: { message: "x" } },
			{ type: "agent_end" },
			{ type: "turn_end" },
			{ type: "message_start" },
			{ type: "unknown_shape" },
			"junk",
			null,
		]) {
			expect(normalizeDreamingLiveEvent(event, PASS_ID)).toBeNull();
		}
	});
});
