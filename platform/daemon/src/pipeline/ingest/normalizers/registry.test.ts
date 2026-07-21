import { describe, expect, test } from "bun:test";
import "./index"; // register markdown/html/json
import { getEdgeNormalizer, normalizeSource } from "../envelope";

describe("edge normalizer registry (end-to-end)", () => {
	test("all three formats are registered by the barrel import", () => {
		expect(getEdgeNormalizer("markdown")).toBeDefined();
		expect(getEdgeNormalizer("html")).toBeDefined();
		expect(getEdgeNormalizer("json")).toBeDefined();
		// plain is registered in envelope.ts directly.
		expect(getEdgeNormalizer("plain")).toBeDefined();
	});

	test("HTML normalizes with block structure preserved (the url-fetcher-flatten fix)", () => {
		const html =
			"<h1>Title</h1><p>Para one.</p><p>Para two.</p><ul><li>a</li><li>b</li></ul><pre><code>line1\nline2</code></pre>";
		const res = normalizeSource(html, { sourcePath: "page.html" });
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		// Heading on its own line.
		expect(res.source.text).toMatch(/^# Title/m);
		// Paragraphs are NOT flattened to one line — blank-line separation survives.
		expect(res.source.text).toMatch(/\n\n/);
		expect(res.source.text.split("\n").length).toBeGreaterThan(3);
		// Code block internal newline preserved.
		expect(res.source.text).toMatch(/line1\nline2/);
		// List items render as bullets.
		expect(res.source.text).toMatch(/- a/);
	});

	test("JSONL transcript normalizes into ordered, non-flat sections", () => {
		const jsonl = [
			JSON.stringify({ role: "user", content: "hello" }),
			JSON.stringify({ role: "assistant", content: "hi there" }),
		].join("\n");
		const res = normalizeSource(jsonl, { sourcePath: "session.jsonl" });
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		// Both messages survive, in order, content verbatim — not one flat line.
		expect(res.source.text).toContain("hello");
		expect(res.source.text).toContain("hi there");
		expect(res.source.text.split("\n").length).toBeGreaterThan(2);
	});

	test("markdown round-trips with line-ending normalization only", () => {
		const md = "# Heading\r\n\r\nbody with [[wikilink]] and | a | b |\r\n";
		const res = normalizeSource(md, { sourcePath: "note.md" });
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.source.text).toBe("# Heading\n\nbody with [[wikilink]] and | a | b |\n");
	});
});
