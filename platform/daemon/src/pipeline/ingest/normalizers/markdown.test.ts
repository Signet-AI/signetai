import { describe, expect, test } from "bun:test";
import { getEdgeNormalizer, normalizeSource, type NormalizeResult } from "../envelope";
import { markdownNormalizer } from "./markdown";

// Importing the module is what registers it; assert the registry wiring too.
describe("markdown edge normalizer", () => {
	test("is registered as the markdown normalizer at import time", () => {
		// Import side-effect: the registry must hold this exact normalizer.
		expect(getEdgeNormalizer("markdown")).toBe(markdownNormalizer);
		expect(markdownNormalizer.format).toBe("markdown");
		expect(markdownNormalizer.providerGated).toBe(false);
	});

	test("CRLF and lone CR are normalized to LF", () => {
		const input = "# Title\r\n\r\npara one\rpara two\r\n";
		const res = markdownNormalizer.normalize(input);
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.source.format).toBe("markdown");
		expect(res.source.text).toBe("# Title\n\npara one\npara two\n");
	});

	test("a leading BOM is stripped (and not mistaken for content)", () => {
		const input = "﻿# Heading\n\nbody";
		const res = markdownNormalizer.normalize(input);
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.source.text).toBe("# Heading\n\nbody");
		expect(res.source.text.startsWith("﻿")).toBe(false);
	});

	test("frontmatter block is preserved verbatim and parsed into metadata", () => {
		const input =
			"---\n" +
			'title: "My Note"\n' +
			"tags: a, b, c\n" +
			"date: 2026-07-12\n" +
			"nested:\n" +
			"  - item\n" +
			"---\n" +
			"\n" +
			"# Body heading\n";
		const res = markdownNormalizer.normalize(input);
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		// The entire frontmatter block survives in text unchanged.
		expect(res.source.text).toBe(input);
		// And metadata carries the light key parse.
		expect(res.source.metadata?.frontmatter).toEqual({
			title: "My Note",
			tags: "a, b, c",
			date: "2026-07-12",
			nested: "",
		});
	});

	test("a leading --- with no close marker is treated as ordinary content, not frontmatter", () => {
		const input = "---\n\nA thematic break with no closing fence.\n";
		const res = markdownNormalizer.normalize(input);
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.source.text).toBe(input);
		expect(res.source.metadata).toBeUndefined();
	});

	test("wikilinks, tables, code fences, and headings survive byte-for-byte", () => {
		const input = [
			"# Title",
			"",
			"This is a [[wikilink]] and a [[aliases|display]] inline.",
			"",
			"| Col A | Col B |",
			"| --- | --- |",
			"| 1 | 2 |",
			"",
			"```ts",
			"const x = `template ${1}`;",
			"```",
			"",
			"## Subheading",
			"",
			"**bold** and _italic_ and `code`.",
			"",
		].join("\n");
		const res = markdownNormalizer.normalize(input);
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		// Source-preserving: the entire document is byte-equivalent to input.
		expect(res.source.text).toBe(input);
		expect(res.source.text).toContain("[[wikilink]]");
		expect(res.source.text).toContain("[[aliases|display]]");
		expect(res.source.text).toContain("| Col A | Col B |");
		expect(res.source.text).toContain("```ts");
		expect(res.source.text).toContain("const x = `template ${1}`;");
		expect(res.source.text).toContain("## Subheading");
		expect(res.source.text).toContain("**bold** and _italic_ and `code`.");
	});

	test("byte-equivalence modulo line endings + BOM for a rich document with frontmatter", () => {
		// Mixed CRLF/CR, leading BOM, frontmatter, headings, table, fence, wikilink.
		const input =
			"﻿---\r\n" +
			'title: "Rich Doc"\r' +
			"---\n" +
			"\r\n" +
			"# Heading\r\n" +
			"\r\n" +
			"See [[target]] and [[a|b]].\r" +
			"\r\n" +
			"| x | y |\r\n" +
			"| - | - |\r\n" +
			"| 1 | 2 |\r\n" +
			"\r\n" +
			"```py\r\n" +
			"print('hi')\r\n" +
			"```\r\n";
		const expected =
			"---\n" +
			'title: "Rich Doc"\n' +
			"---\n" +
			"\n" +
			"# Heading\n" +
			"\n" +
			"See [[target]] and [[a|b]].\n" +
			"\n" +
			"| x | y |\n" +
			"| - | - |\n" +
			"| 1 | 2 |\n" +
			"\n" +
			"```py\n" +
			"print('hi')\n" +
			"```\n";
		const res = markdownNormalizer.normalize(input);
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.source.text).toBe(expected);
		expect(res.source.metadata?.frontmatter).toEqual({ title: "Rich Doc" });
	});

	test("normalizeSource routes a .md path to the markdown normalizer", () => {
		const res: NormalizeResult = normalizeSource("# Hi\n\n[[link]]", { sourcePath: "note.md" });
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.source.format).toBe("markdown");
		expect(res.source.text).toBe("# Hi\n\n[[link]]");
	});

	test("frontmatter with ... closer is recognized", () => {
		const input = "---\ntitle: Alt\n...\n\nbody\n";
		const res = markdownNormalizer.normalize(input);
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.source.text).toBe(input);
		expect(res.source.metadata?.frontmatter).toEqual({ title: "Alt" });
	});
});
