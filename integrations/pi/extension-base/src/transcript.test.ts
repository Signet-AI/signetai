import { describe, expect, it } from "bun:test";
import { buildTranscriptFromEntries } from "./transcript.js";

describe("Pi transcript builder", () => {
	it("recognizes role aliases and skips unknown roles", () => {
		const transcript = buildTranscriptFromEntries([
			{ type: "message", message: { role: "human", content: "hello" } },
			{ type: "message", message: { role: "agent", content: [{ input_text: "hi" }] } },
			{ type: "message", message: { role: "mystery", content: "do not mislabel" } },
			{ type: "message", message: { role: "toolResult", content: "tool output" } },
		]);

		expect(transcript).toBe("User: hello\nAssistant: hi\nTool: tool output");
	});
});
