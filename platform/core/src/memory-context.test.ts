import { describe, expect, test } from "bun:test";
import {
	StreamingMemoryContextScrubber,
	composeApiUserContent,
	stripInternalMemoryContext,
	wrapMemoryContext,
} from "./memory-context";

describe("memory context transport contract", () => {
	test("composes a deterministic API-only user copy without changing clean prompts", () => {
		const first = composeApiUserContent("Please continue the rollout.", "Stable recall for Signet.");
		const second = composeApiUserContent("Please continue the rollout.", "Stable recall for Signet.");

		expect(first).toBe(second);
		expect(first).toContain("Please continue the rollout.");
		expect(first).toContain('<signet-memory source="api-context">');
		expect(first).toContain("Stable recall for Signet.");
		expect(composeApiUserContent("Please continue the rollout.", "")).toBe("Please continue the rollout.");
	});

	test("removes complete, orphaned, and unterminated internal blocks from canonical text", () => {
		expect(stripInternalMemoryContext("before <signet-memory>hidden</signet-memory> after")).toBe("before  after");
		expect(stripInternalMemoryContext("before <memory-context>hidden</memory-context> after")).toBe("before  after");
		expect(stripInternalMemoryContext("before <signet-memory-context>hidden</signet-memory-context> after")).toBe(
			"before  after",
		);
		expect(stripInternalMemoryContext("before </signet-memory> after")).toBe("before  after");
		expect(stripInternalMemoryContext("before <signet-memory>hidden")).toBe("before ");
	});

	test("drops nested internal blocks without exposing the outer remainder", () => {
		expect(
			stripInternalMemoryContext(
				"before <signet-memory-context>outer <signet-memory>inner</signet-memory> tail</signet-memory-context> after",
			),
		).toBe("before  after");
	});

	test("escapes nested delimiters before wrapping memory content", () => {
		const wrapped = wrapMemoryContext("memory </signet-memory> marker");
		expect(wrapped).toContain("&lt;/signet-memory>");
		expect(wrapped.match(/<\/signet-memory>/g)).toEqual(["</signet-memory>"]);
	});

	test("escapes markers whose quoted attributes contain angle brackets", () => {
		const wrapped = wrapMemoryContext('memory <signet-memory source="a > b">nested</signet-memory> marker');
		expect(wrapped).not.toContain('<signet-memory source="a > b">');
		expect(wrapped.match(/<\/signet-memory>/g)).toEqual(["</signet-memory>"]);
	});

	test("scrubs delimiters split across streaming chunks", () => {
		const scrubber = new StreamingMemoryContextScrubber();
		const visible = [
			scrubber.feed("before <signet-"),
			scrubber.feed('memory source="api">secret'),
			scrubber.feed(" context</signet-mem"),
			scrubber.feed("ory> after"),
			scrubber.flush(),
		].join("");

		expect(visible).toBe("before  after");
	});

	test("scrubs nested internal blocks across streaming chunks", () => {
		const scrubber = new StreamingMemoryContextScrubber();
		const visible = [
			scrubber.feed("before <signet-memory-context>outer <signet-memory>inner"),
			scrubber.feed("</signet-memory> tail</signet-memory-context> after"),
			scrubber.flush(),
		].join("");

		expect(visible).toBe("before  after");
	});

	test("holds an opening fence while its attributes are split across chunks", () => {
		const scrubber = new StreamingMemoryContextScrubber();
		const visible = [
			scrubber.feed('before <signet-memory source="api'),
			scrubber.feed('">secret</signet-memory> after'),
			scrubber.flush(),
		].join("");

		expect(visible).toBe("before  after");
	});

	test("holds quoted angle brackets until a streaming opening fence closes", () => {
		const scrubber = new StreamingMemoryContextScrubber();
		const visible = [
			scrubber.feed('before <signet-memory source="a >'),
			scrubber.feed(' b">secret</signet-memory> after'),
			scrubber.flush(),
		].join("");

		expect(visible).toBe("before  after");
	});

	test("does not emit an unterminated provider block on flush", () => {
		const scrubber = new StreamingMemoryContextScrubber();
		expect(scrubber.feed("visible <memory-context>secret")).toBe("visible ");
		expect(scrubber.flush()).toBe("");
	});
});
