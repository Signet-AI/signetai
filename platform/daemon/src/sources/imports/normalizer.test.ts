import { describe, expect, it } from "bun:test";
import { IMPORT_MAX_FILE_BYTES, normalizeImportedFile } from "./normalizer";

function bytes(value: string): Uint8Array {
	return new TextEncoder().encode(value);
}

describe("import normalizer", () => {
	it("preserves structured JSON as canonical pretty-printed content", async () => {
		const result = await normalizeImportedFile(
			"conversation.json",
			bytes('{"messages":[{"role":"user","content":"hello"}]}'),
			"application/json",
		);

		expect(result.ok).toBe(true);
		if (result.ok === false) throw new Error(result.error);
		expect(result.value.format).toBe("json");
		expect(result.value.content).toContain('"messages"');
		expect(result.value.canonicalContent).toBe('{"messages":[{"role":"user","content":"hello"}]}\n');
		expect(result.value.canonicalContent).not.toBe(result.value.content);
		expect(result.value.sourceMeta).toEqual({ representation: "structured-json", rootType: "object" });
		expect(result.value.contentHash).toMatch(/^[a-f0-9]{64}$/);
	});

	it("normalizes CSV as one table artifact with row metadata", async () => {
		const result = await normalizeImportedFile(
			"contacts.csv",
			bytes("name,email\r\nAda,ada@example.com\r\n"),
			"text/csv",
		);

		expect(result.ok).toBe(true);
		if (result.ok === false) throw new Error(result.error);
		expect(result.value.format).toBe("csv");
		expect(result.value.content).toBe("name,email\nAda,ada@example.com\n");
		expect(result.value.sourceMeta).toEqual({ representation: "table", rowCount: 1 });
	});

	it("rejects normalized content that expands beyond the per-file limit", async () => {
		const result = await normalizeImportedFile(
			"large.txt",
			new Uint8Array(IMPORT_MAX_FILE_BYTES).fill(97),
			"text/plain",
		);

		expect(result).toEqual({
			ok: false,
			error: `Normalized file exceeds the ${IMPORT_MAX_FILE_BYTES} byte limit`,
		});
	});

	it("projects HTML to text without scripts or markup", async () => {
		const result = await normalizeImportedFile(
			"page.html",
			bytes("<h1>Hello &amp; world</h1><script>secret()</script><p>Body</p>"),
			"text/html",
		);

		expect(result.ok).toBe(true);
		if (result.ok === false) throw new Error(result.error);
		expect(result.value.content).toBe("Hello & world\nBody\n");
		expect(result.value.content).not.toContain("secret");
	});

	it("rejects unsupported formats before creating a source", async () => {
		expect(await normalizeImportedFile("archive.zip", bytes("PK"), "application/zip")).toEqual({
			ok: false,
			error: "Unsupported file format: .zip",
		});
	});

	it("converts a document format through anydoc", async () => {
		const result = await normalizeImportedFile("note.rtf", bytes("{\\rtf1\\ansi Imported note}"), "application/rtf");

		expect(result.ok).toBe(true);
		if (result.ok === false) throw new Error(result.error);
		expect(result.value.format).toBe("rtf");
		expect(result.value.sourceMeta).toEqual({ representation: "markdown-projection", converter: "anydoc" });
		expect(result.value.content.toLowerCase()).toContain("imported note");
	});
});
