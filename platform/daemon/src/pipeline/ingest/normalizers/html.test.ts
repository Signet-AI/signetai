import { describe, expect, test } from "bun:test";
import "./html";
import { getEdgeNormalizer, normalizeSource } from "../envelope";

const DOC = `<!doctype html>
<html>
<head>
<title>Test Page</title>
<script>var evil = "should not survive";</script>
<style>body { color: red; }</style>
<meta charset="utf-8">
</head>
<body>
<h1>Main Heading</h1>
<p>First paragraph with <strong>bold</strong>, <em>italic</em>, and a <a href="https://example.com">link</a>.</p>
<p>Second paragraph about A &amp; B and 3 &lt; 4.</p>
<ul>
<li>Alpha</li>
<li>Beta</li>
<li>Gamma</li>
</ul>
<pre><code>function hello() {
  return "world";
}</code></pre>
<table>
<tr><th>Name</th><th>Value</th></tr>
<tr><td>One</td><td>1</td></tr>
<tr><td>Two</td><td>2</td></tr>
</table>
</body>
</html>`;

describe("html normalizer", () => {
	test("registers itself at import time as the html EdgeNormalizer", () => {
		const n = getEdgeNormalizer("html");
		expect(n).toBeDefined();
		expect(n?.format).toBe("html");
		expect(n?.providerGated).toBe(false);
	});

	test("converts a multi-paragraph doc to structure-preserving markdown", () => {
		const res = normalizeSource(DOC, { sourcePath: "page.html" });
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.source.format).toBe("html");
		expect(res.source.sourcePath).toBe("page.html");
		const text = res.source.text;

		// (a) heading on its own line, prefixed "# "
		expect(text).toMatch(/^# Main Heading$/m);

		// (b) paragraphs separated by blank lines, NOT flattened to one line
		expect(text).toMatch(/\n\n/);
		expect(text.split("\n").length).toBeGreaterThan(10);
		expect(text.includes("\n")).toBe(true);

		// (c) list items are "- " lines
		expect(text).toMatch(/^- Alpha$/m);
		expect(text).toMatch(/^- Beta$/m);
		expect(text).toMatch(/^- Gamma$/m);

		// (d) code block is fenced with internal newlines intact
		expect(text).toContain("```\nfunction hello() {\n  return \"world\";\n}\n```");

		// (e) table is a markdown pipe table
		expect(text).toMatch(/^\| Name \| Value \|$/m);
		expect(text).toMatch(/^\| --- \| --- \|$/m);
		expect(text).toMatch(/^\| One \| 1 \|$/m);

		// script/style/meta text is dropped entirely
		expect(text).not.toContain("evil");
		expect(text).not.toContain("color: red");
		expect(text).not.toContain("charset");

		// 5 core entities decode; &amp; -> &, &lt; -> <
		expect(text).toContain("A & B and 3 < 4");
		expect(text).not.toContain("&amp;");
		expect(text).not.toContain("&lt;");

		// inline formatting + link survive
		expect(text).toContain("**bold**");
		expect(text).toContain("*italic*");
		expect(text).toContain("[link](https://example.com)");

		// title is carried through as provenance metadata, not in body text
		expect(res.source.title).toBe("Test Page");
		expect(text).not.toContain("Test Page");

		// hard guard: the output is NOT a url-fetcher-style single flattened line
		const firstPara = text.split("\n\n").find((p) => p.startsWith("First paragraph"));
		expect(firstPara).toBeDefined();
		expect(firstPara).toBe(
			'First paragraph with **bold**, *italic*, and a [link](https://example.com).',
		);
	});

	test("ordered lists render with numeric markers and inline code/images/blockquote/hr/br survive", () => {
		const html = [
			"<h2>Section</h2>",
			"<ol><li>first</li><li>second</li></ol>",
			"<p>Inline <code>let x = 1</code> here.</p>",
			"<p>Image: <img src=\"http://img.test/a.png\" alt=\"Alt\"></p>",
			"<blockquote><p>Quoted text.</p></blockquote>",
			"<hr>",
			"<p>Line one<br>Line two</p>",
		].join("\n");
		const res = normalizeSource(html);
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		const text = res.source.text;

		expect(text).toMatch(/^## Section$/m);
		expect(text).toMatch(/^1\. first$/m);
		expect(text).toMatch(/^2\. second$/m);
		expect(text).toContain("`let x = 1`");
		expect(text).toContain("![Alt](http://img.test/a.png)");
		expect(text).toMatch(/^> Quoted text\.$/m);
		expect(text).toMatch(/\n---\n/);
		expect(text).toMatch(/Line one\s*\n\s*Line two/);
	});

	test("pre block preserves every internal newline and does not decode entities", () => {
		const html = `<pre><code>a &amp; b
c   d
	dented</code></pre>`;
		const res = normalizeSource(html);
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		const text = res.source.text;
		// internal newlines and spaces/tabs preserved verbatim
		expect(text).toContain("```\na &amp; b\nc   d\n\tdented\n```");
		expect(text).not.toContain("a & b");
	});

	test("nested lists indent continuation lines", () => {
		const html = "<ul><li>parent<ul><li>child</li></ul></li></ul>";
		const res = normalizeSource(html);
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.source.text).toBe("- parent\n  - child\n");
	});
});
