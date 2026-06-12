import { describe, expect, it } from "bun:test";
import {
	normalizeCodexTranscript,
	normalizeJsonConversationTranscript,
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

	it("normalizes generic JSON-line conversations", () => {
		const raw = [
			JSON.stringify({ role: "user", content: "question" }),
			JSON.stringify({ role: "assistant", content: [{ type: "text", text: "answer" }] }),
		].join("\n");

		expect(normalizeJsonConversationTranscript(raw)).toBe("User: question\nAssistant: answer");
	});

	it("reports long JSON-line transcripts with no conversation turns", () => {
		let warning: { harness: string; rawChars: number } | undefined;
		const raw = Array.from({ length: 80 }, () => JSON.stringify({ type: "tool_call", payload: "x" })).join("\n");

		expect(normalizeSessionTranscript("custom", raw, (next) => (warning = next))).toBe("");
		expect(warning).toEqual({ harness: "custom", rawChars: raw.length });
	});
});
