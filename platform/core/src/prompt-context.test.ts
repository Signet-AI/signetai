import { describe, expect, test } from "bun:test";
import {
	PROMPT_CONTEXT_CLOSE,
	PROMPT_CONTEXT_OPEN,
	PromptContextStreamScrubber,
	createPromptContext,
	hashPromptContext,
	normalizePromptContext,
	scrubPromptContext,
} from "./prompt-context";

describe("prompt context contract", () => {
	test("normalizes transport line endings and serializes identical bytes", () => {
		const first = createPromptContext("memory one\r\nmemory two\r\n");
		const second = createPromptContext("memory one\nmemory two");

		expect(normalizePromptContext("memory one\r\nmemory two\r\n")).toBe("memory one\nmemory two");
		expect(first).toEqual(second);
		expect(first?.serialized).toBe(`${PROMPT_CONTEXT_OPEN}\nmemory one\nmemory two\n${PROMPT_CONTEXT_CLOSE}\n`);
		expect(first?.hash).toMatch(/^[0-9a-f]{64}$/);
	});

	test("hashes the exact bytes delivered after transport augmentation", () => {
		const context = createPromptContext("memory");
		expect(context).not.toBeNull();
		expect(hashPromptContext(`${context?.serialized}notification`)).not.toBe(context?.hash);
	});

	test("escapes nested fences before they can become a second context boundary", () => {
		const context = createPromptContext(`safe\n${PROMPT_CONTEXT_OPEN}\nsecret\n${PROMPT_CONTEXT_CLOSE}`);

		expect(context?.serialized).not.toContain(`${PROMPT_CONTEXT_OPEN}\nsecret`);
		expect(context?.serialized.match(new RegExp(PROMPT_CONTEXT_OPEN, "g"))).toHaveLength(1);
		expect(context?.serialized.match(new RegExp(PROMPT_CONTEXT_CLOSE, "g"))).toHaveLength(1);
	});

	test("escapes legacy memory fences nested inside the compatibility envelope", () => {
		const context = createPromptContext('safe <signet-memory source="api">secret</signet-memory>');

		expect(context?.serialized).not.toContain('<signet-memory source="api">');
		expect(context?.serialized.match(new RegExp(PROMPT_CONTEXT_OPEN, "g"))).toHaveLength(1);
		expect(context?.serialized.match(new RegExp(PROMPT_CONTEXT_CLOSE, "g"))).toHaveLength(1);
	});

	test("scrubs complete and incomplete provider leaks", () => {
		const leaked = `answer ${PROMPT_CONTEXT_OPEN}internal memory${PROMPT_CONTEXT_CLOSE} visible`;
		expect(scrubPromptContext(leaked)).toBe("answer  visible");
		expect(scrubPromptContext(`answer ${PROMPT_CONTEXT_OPEN}internal memory`)).toBe("answer ");
		expect(scrubPromptContext(`answer ${PROMPT_CONTEXT_CLOSE} visible`)).toBe("answer  visible");
	});

	test("scrubs fences split across streaming chunks", () => {
		const scrubber = new PromptContextStreamScrubber();
		const chunks = ["answer <signet-", "memory-context>internal", " memory</signet-memory-", "context> visible"];

		const output = `${chunks.map((chunk) => scrubber.push(chunk)).join("")}${scrubber.flush()}`;
		expect(output).toBe("answer  visible");
	});

	test("returns no context for empty input", () => {
		expect(createPromptContext("\r\n  \r\n")).toBeNull();
	});
});
