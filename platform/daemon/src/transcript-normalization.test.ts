import { describe, expect, it } from "bun:test";
import {
	normalizeCodexTranscript,
	normalizeJsonConversationTranscript,
	normalizeKimiTranscript,
	normalizeSessionTranscript,
} from "./transcript-normalization";

describe("transcript normalization", () => {
	it("normalizes Codex user and assistant events without metadata", () => {
		const raw = [
			JSON.stringify({ type: "session_meta", cwd: "/private/project" }),
			JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "hello\nthere" } }),
			JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "hi\nback" } }),
		].join("\n");

		expect(normalizeCodexTranscript(raw)).toBe("User: hello there\nAssistant: hi back");
	});

	it("falls back to raw text for non-json transcripts", () => {
		expect(normalizeSessionTranscript("test", "User: plain text")).toBe("User: plain text");
	});

	it("falls back to raw text for rendered Codex transcripts", () => {
		const raw = "User: plain Codex transcript\nAssistant: queued";
		expect(normalizeSessionTranscript("codex", raw)).toBe(raw);
	});

	it("uses generic JSONL turns when Codex-specific events are absent", () => {
		const raw = [
			JSON.stringify({ role: "user", content: "generic question" }),
			JSON.stringify({ role: "assistant", content: "generic answer" }),
		].join("\n");

		expect(normalizeSessionTranscript("codex", raw)).toBe("User: generic question\nAssistant: generic answer");
	});

	it("normalizes generic JSON-line conversations", () => {
		const raw = [
			JSON.stringify({ role: "user", content: "question" }),
			JSON.stringify({ role: "assistant", content: [{ type: "text", text: "answer" }] }),
		].join("\n");

		expect(normalizeJsonConversationTranscript(raw)).toBe("User: question\nAssistant: answer");
	});

	it("normalizes Pi-style role aliases without turning unknown roles into users", () => {
		const raw = [
			JSON.stringify({ type: "message", message: { role: "human", parts: [{ text: "hello" }] } }),
			JSON.stringify({ type: "message", message: { role: "agent", content: [{ input_text: "hi" }] } }),
			JSON.stringify({ type: "message", message: { role: "mystery", content: "do not label as user" } }),
			JSON.stringify({ type: "message", message: { role: "toolResult", content: "tool output" } }),
		].join("\n");

		expect(normalizeJsonConversationTranscript(raw)).toBe("User: hello\nAssistant: hi\nTool: tool output");
	});

	it("reports long JSON-line transcripts with no conversation turns", () => {
		let warning: { harness: string; rawChars: number } | undefined;
		const raw = Array.from({ length: 80 }, () => JSON.stringify({ type: "tool_call", payload: "x" })).join("\n");

		expect(normalizeSessionTranscript("custom", raw, (next) => (warning = next))).toBe("");
		expect(warning).toEqual({ harness: "custom", rawChars: raw.length });
	});

	it("normalizes Kimi stream-json user and assistant messages without tool or meta lines", () => {
		const raw = [
			JSON.stringify({ role: "user", content: "hello\nthere" }),
			JSON.stringify({
				role: "assistant",
				tool_calls: [{ type: "function", id: "tc_1", function: { name: "Read", arguments: "{}" } }],
			}),
			JSON.stringify({ role: "tool", tool_call_id: "tc_1", content: "file contents" }),
			JSON.stringify({ role: "assistant", content: "hi\nback" }),
			JSON.stringify({ role: "meta", type: "session.resume_hint", session_id: "abc" }),
		].join("\n");

		expect(normalizeKimiTranscript(raw)).toBe("User: hello there\nAssistant: hi back");
		expect(normalizeSessionTranscript("kimi", raw)).toBe("User: hello there\nAssistant: hi back");
	});

	it("normalizes Kimi array-form assistant content", () => {
		const raw = JSON.stringify({ role: "assistant", content: [{ type: "text", text: "answer" }] });

		expect(normalizeKimiTranscript(raw)).toBe("Assistant: answer");
	});

	it("falls back to raw text for rendered Kimi transcripts", () => {
		const raw = "User: plain Kimi transcript\nAssistant: queued";
		expect(normalizeSessionTranscript("kimi", raw)).toBe(raw);
	});
});
