import { describe, expect, test } from "bun:test";
import { formatLivePromptTranscript } from "./capture";

describe("transcript capture helpers", () => {
	test("formats live prompt transcript with optional assistant turn", () => {
		expect(formatLivePromptTranscript("next question", "previous answer")).toBe(
			"Assistant: previous answer\nUser: next question",
		);
		expect(formatLivePromptTranscript("next question")).toBe("User: next question");
	});
});
