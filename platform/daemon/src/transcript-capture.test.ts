import { describe, expect, test } from "bun:test";
import { appendLivePromptTranscript, formatLivePromptTranscript } from "./transcript-capture";

describe("transcript capture helpers", () => {
	test("formats live prompt transcript with optional assistant turn", () => {
		expect(formatLivePromptTranscript("next question", "previous answer")).toBe(
			"Assistant: previous answer\nUser: next question",
		);
		expect(formatLivePromptTranscript("next question")).toBe("User: next question");
	});

	test("appends live prompt transcript without duplicating suffix", () => {
		expect(appendLivePromptTranscript(undefined, "User: hello")).toBe("User: hello");
		expect(appendLivePromptTranscript("Assistant: hi", "User: hello")).toBe("Assistant: hi\nUser: hello");
		expect(appendLivePromptTranscript("Assistant: hi\nUser: hello", "User: hello")).toBe("Assistant: hi\nUser: hello");
	});
});
