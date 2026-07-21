import { describe, expect, test } from "bun:test";
import { detectFormat, normalizeSource } from "./envelope";

describe("ingest envelope", () => {
	test("detectFormat uses the extension hint, then content sniff", () => {
		expect(detectFormat({ sourcePath: "note.md" }, "")).toBe("markdown");
		expect(detectFormat({ sourcePath: "page.html" }, "")).toBe("html");
		expect(detectFormat({ sourcePath: "data.json" }, "")).toBe("json");
		expect(detectFormat({ sourcePath: "readme.txt" }, "")).toBe("plain");
		// Content sniff when no hint.
		expect(detectFormat(undefined, "<!doctype html><html>")).toBe("html");
		expect(detectFormat(undefined, '{"a":1}')).toBe("json");
		expect(detectFormat(undefined, "# Heading\n\nbody")).toBe("markdown");
	});

	test("plain normalizer preserves content, normalizes line endings, strips BOM", () => {
		const res = normalizeSource("﻿line one\r\nline two\rline three", { sourcePath: "x.txt" });
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.source.format).toBe("plain");
		expect(res.source.text).toBe("line one\nline two\nline three");
	});

	test("an unrecognized format returns a structured error, not a silent empty success", () => {
		const res = normalizeSource("    "); // no hint, whitespace-only, no detectable structure
		expect(res.ok).toBe(false);
		if (res.ok) return;
		expect(res.reason).toBe("unrecognized");
	});

	test("formatHint forces a format even when unregistered (gdocs)", () => {
		// gdocs is provider-gated and not registered yet → unconfigured error.
		const res = normalizeSource("anything", { formatHint: "gdocs" });
		expect(res.ok).toBe(false);
		if (res.ok) return;
		expect(res.reason).toBe("unconfigured");
		expect(res.format).toBe("gdocs");
	});
});
