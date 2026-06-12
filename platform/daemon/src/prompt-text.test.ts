import { describe, expect, test } from "bun:test";
import {
	buildRecallQueryShape,
	extractSubstantiveWords,
	queryAnchorsMissingFromRecall,
	stripUntrustedMetadata,
} from "./prompt-text";

describe("prompt text helpers", () => {
	test("strips untrusted metadata JSON envelopes", () => {
		const cleaned = stripUntrustedMetadata(
			'Conversation info (untrusted metadata):\n{"conversation_label":"OpenClaw Session","message_id":"msg_123","sender_id":"user_456"}\n\nCan you reiterate the release checklist?',
		);

		expect(cleaned).toBe("Can you reiterate the release checklist?");
	});

	test("extracts substantive words without Discord mentions or stopwords", () => {
		expect(extractSubstantiveWords("<@123> Please inspect KA-6 pre-compaction behavior now")).toEqual([
			"ka-6",
			"pre-compaction",
			"inspect",
			"pre",
			"compaction",
			"behavior",
		]);
	});

	test("builds recall query shape from cleaned prompt text", () => {
		const shape = buildRecallQueryShape(
			'Conversation info (untrusted metadata):\n{"channel":"discord"}\n\nFind ultra-needle-transcript-only-5529931 please',
		);

		expect(shape.vectorQuery).toBe("Find ultra-needle-transcript-only-5529931 please");
		expect(shape.keywordTerms).toContain("ultra-needle-transcript-only-5529931");
		expect(shape.keywordTerms).not.toContain("discord");
	});

	test("detects missing anchor terms in recall results", () => {
		expect(queryAnchorsMissingFromRecall("locate ultra-needle-transcript-only-5529931", [])).toBe(false);
		expect(
			queryAnchorsMissingFromRecall("locate ultra-needle-transcript-only-5529931", [
				{ content: "some unrelated memory" },
			]),
		).toBe(true);
		expect(
			queryAnchorsMissingFromRecall("locate ultra-needle-transcript-only-5529931", [
				{ content: "found ultra-needle-transcript-only-5529931 in the transcript" },
			]),
		).toBe(false);
	});
});
