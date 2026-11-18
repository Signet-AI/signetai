import { describe, expect, test } from "bun:test";
import {
	buildRecallQueryShape,
	extractSubstantiveWords,
	isLowSignalPrompt,
	queryAnchorsMissingFromRecall,
	stripProvenanceBlocks,
	stripUntrustedMetadata,
} from "./prompt-text";

describe("prompt text helpers", () => {
	test("strips untrusted metadata JSON envelopes", () => {
		const cleaned = stripUntrustedMetadata(
			'Conversation info (untrusted metadata):\n{"conversation_label":"OpenClaw Session","message_id":"msg_123","sender_id":"user_456"}\n\nCan you reiterate the release checklist?',
		);

		expect(cleaned).toBe("Can you reiterate the release checklist?");
	});

	test("strips paired provenance blocks and keeps other bracketed text", () => {
		const message = [
			"which still is best for the thumbnail? [draft] keep it",
			"",
			"[Discord sender provenance]",
			'Gateway metadata for this message only.\n{"user_id":"903009565744971816","display_name":"Davane"}',
			"[/Discord sender provenance]",
		].join("\n");

		expect(stripProvenanceBlocks(message)).toBe("which still is best for the thumbnail? [draft] keep it");
		expect(stripProvenanceBlocks("[Discord sender provenance] unclosed")).toBe("[Discord sender provenance] unclosed");
	});

	test("strips provenance in linear time on adversarial unmatched tags", () => {
		const hostile = "[Discord sender provenance]".repeat(32_000);
		const started = performance.now();
		expect(stripProvenanceBlocks(hostile)).toBe(hostile);
		expect(performance.now() - started).toBeLessThan(500);
		const closes = "[/Discord sender provenance]".repeat(32_000);
		const closesStarted = performance.now();
		expect(stripProvenanceBlocks(closes)).toBe(closes);
		expect(performance.now() - closesStarted).toBeLessThan(150);
		const closed = `${"[Discord sender provenance]".repeat(5_000)}x[/Discord sender provenance]tail`;
		expect(stripProvenanceBlocks(closed)).toBe("tail");
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

	test("gates greetings and acknowledgements without dropping substantive short prompts", () => {
		for (const prompt of ["hi", "Thanks!", "okay", "hello there", "good morning"]) {
			expect(isLowSignalPrompt(prompt)).toBe(true);
		}

		for (const prompt of ["k8s", "yolo", "Signet", "AI", "v2", "No", "No, use the other option"]) {
			expect(isLowSignalPrompt(prompt)).toBe(false);
		}
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
