import { describe, expect, test } from "bun:test";
import { getEdgeNormalizer, normalizeSource, type NormalizeResult } from "../envelope";
import { jsonNormalizer } from "./json";

// Importing the module is what registers it; assert the registry wiring too.
describe("json edge normalizer", () => {
	test("is registered as the json normalizer at import time", () => {
		expect(getEdgeNormalizer("json")).toBe(jsonNormalizer);
		expect(jsonNormalizer.format).toBe("json");
		expect(jsonNormalizer.providerGated).toBe(false);
	});

	test("a JSONL transcript renders to blank-line-separated turns, role bolded, content verbatim and in order", () => {
		const input = [
			'{"role":"user","content":"Hello there"}',
			'{"role":"assistant","content":"Hi! How can I help?"}',
			'{"role":"user","content":"Tell me about JSON."}',
		].join("\n");
		const res = jsonNormalizer.normalize(input);
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.source.format).toBe("json");
		expect(res.source.metadata?.shape).toBe("transcript");
		const expected =
			"**user**:\n\nHello there\n\n" +
			"**assistant**:\n\nHi! How can I help?\n\n" +
			"**user**:\n\nTell me about JSON.";
		expect(res.source.text).toBe(expected);
		// Order preserved.
		expect(res.source.text.indexOf("Hello there")).toBeLessThan(
			res.source.text.indexOf("Hi! How can I help?"),
		);
		expect(res.source.text.indexOf("Hi! How can I help?")).toBeLessThan(
			res.source.text.indexOf("Tell me about JSON."),
		);
		// Content is verbatim, not escaped or flattened.
		expect(res.source.text).toContain("Hi! How can I help?");
		expect(res.source.text).not.toContain("\\u");
		expect(res.source.text.split("\n").length).toBeGreaterThan(3);
	});

	test("a JSONL message with an embedded newline in content is preserved (no whitespace collapse)", () => {
		// The url-fetcher flatten bug collapsed internal whitespace; this must not.
		const input =
			'{"role":"user","content":"line one\\nline two\\n    indented third"}';
		const res = jsonNormalizer.normalize(input);
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		// JSON unescapes \\n to a real newline; the normalizer keeps it.
		expect(res.source.text).toBe("**user**:\n\nline one\nline two\n    indented third");
		expect(res.source.metadata?.shape).toBe("transcript");
	});

	test("a nested object renders to structured markdown (headings + bullets), not one flat line", () => {
		const res = jsonNormalizer.normalize('{"a":{"b":1},"c":[1,2]}');
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.source.metadata?.shape).toBe("object");
		const expected = "## a\n\n- b: 1\n\n## c\n\n- 1\n- 2";
		expect(res.source.text).toBe(expected);
		// Structural proof: it is multi-line markdown, not a flat single line.
		expect(res.source.text.split("\n").length).toBeGreaterThan(1);
		expect(res.source.text).not.toMatch(/^{.*}$/);
		expect(res.source.text).toContain("## a");
		expect(res.source.text).toContain("## c");
	});

	test("a {messages: [...]} object is detected as a transcript", () => {
		const input = JSON.stringify({
			title: "Chat log",
			messages: [
				{ role: "user", content: "ping" },
				{ role: "assistant", content: "pong" },
			],
		});
		const res = jsonNormalizer.normalize(input);
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.source.metadata?.shape).toBe("transcript");
		expect(res.source.text).toBe("**user**:\n\nping\n\n**assistant**:\n\npong");
		// Title hint is surfaced from the top-level string field.
		expect(res.source.title).toBe("Chat log");
	});

	test("a single JSONL object that is not a message renders as key/value lines", () => {
		// Two objects → whole-parse fails → JSONL path; neither is message-shaped.
		const input = '{"name":"event","ts":123}\n{"name":"event2","ts":456}';
		const res = jsonNormalizer.normalize(input);
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.source.metadata?.shape).toBe("jsonl");
		expect(res.source.text).toBe("- name: event\n- ts: 123\n\n- name: event2\n- ts: 456");
	});

	test("malformed JSON returns a structured malformed error, not a silent empty success", () => {
		const res: NormalizeResult = jsonNormalizer.normalize("{not valid json");
		expect(res.ok).toBe(false);
		if (res.ok) return;
		expect(res.format).toBe("json");
		expect(res.reason).toBe("malformed");
		expect(res.message.length).toBeGreaterThan(0);
	});

	test("a JSONL stream with one bad line is malformed (not silently truncated)", () => {
		const input = '{"a":1}\nnotjson\n{"b":2}';
		const res = jsonNormalizer.normalize(input);
		expect(res.ok).toBe(false);
		if (res.ok) return;
		expect(res.reason).toBe("malformed");
	});

	test("empty / whitespace-only input is malformed", () => {
		const res = jsonNormalizer.normalize("   \n  ");
		expect(res.ok).toBe(false);
		if (res.ok) return;
		expect(res.reason).toBe("malformed");
	});

	test("a leading BOM and CRLF are normalized before parsing", () => {
		const input = "﻿{\r\n\"role\": \"user\",\r\n\"content\": \"hi\"\r\n}";
		const res = jsonNormalizer.normalize(input);
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		// Single JSON object that is message-shaped → transcript.
		expect(res.source.metadata?.shape).toBe("transcript");
		expect(res.source.text).toBe("**user**:\n\nhi");
	});

	test("long string values are kept verbatim under a heading, not inlined or truncated", () => {
		const long = "x".repeat(120);
		const input = JSON.stringify({ note: long, count: 3 });
		const res = jsonNormalizer.normalize(input);
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.source.metadata?.shape).toBe("object");
		expect(res.source.text).toBe(`## note\n\n${long}\n\n- count: 3`);
	});

	test("normalizeSource routes a .json path to the json normalizer", () => {
		const res: NormalizeResult = normalizeSource('{"k":1}', { sourcePath: "data.json" });
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.source.format).toBe("json");
		expect(res.source.text).toBe("- k: 1");
	});

	test("normalizeSource routes a .jsonl transcript path to the json normalizer", () => {
		const input = '{"role":"user","content":"hi"}\n{"role":"assistant","content":"hey"}';
		const res: NormalizeResult = normalizeSource(input, { sourcePath: "chat.jsonl" });
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.source.format).toBe("json");
		expect(res.source.metadata?.shape).toBe("transcript");
		expect(res.source.text).toBe("**user**:\n\nhi\n\n**assistant**:\n\nhey");
	});
});
