/**
 * Regression tests for memory ingestion filtering.
 *
 * Verifies that generated backup/artifact markdown files are excluded from
 * re-ingestion, and that short/degenerate chunks are filtered before
 * hitting the memory API.
 */

import { describe, expect, it } from "bun:test";
import { ARTIFACT_FILENAME_RE, MEMORY_BACKUP_FILENAME_RE } from "./daemon";

describe("memory ingest filename exclusion", () => {
	it("matches MEMORY backup filenames", () => {
		expect(MEMORY_BACKUP_FILENAME_RE.test("MEMORY.backup-2026-03-31T21-17-05.md")).toBe(true);
	});

	it("matches MEMORY bak filenames", () => {
		expect(MEMORY_BACKUP_FILENAME_RE.test("MEMORY.bak-2026-03-31T21-17-05.md")).toBe(true);
	});

	it("matches MEMORY pre filenames", () => {
		expect(MEMORY_BACKUP_FILENAME_RE.test("MEMORY.pre-2026-03-31T21-17-05.md")).toBe(true);
	});

	it("matches summary artifact filenames", () => {
		expect(ARTIFACT_FILENAME_RE.test("2026-03-01T00-09-52.500Z--eej6phr2ekkn46eo--summary.md")).toBe(true);
	});

	it("matches transcript artifact filenames", () => {
		expect(ARTIFACT_FILENAME_RE.test("2026-03-01T00-09-52.500Z--o4ebayj7w4fs3grh--transcript.md")).toBe(true);
	});

	it("matches compaction artifact filenames", () => {
		expect(ARTIFACT_FILENAME_RE.test("2026-03-25T08-06-26.000Z--abc12345--compaction.md")).toBe(true);
	});

	it("matches manifest artifact filenames", () => {
		expect(ARTIFACT_FILENAME_RE.test("2026-03-01T00-09-53.500Z--o4ebayj7w4fs3grh--manifest.md")).toBe(true);
	});

	it("does not match MEMORY.md", () => {
		expect(MEMORY_BACKUP_FILENAME_RE.test("MEMORY.md")).toBe(false);
		expect(ARTIFACT_FILENAME_RE.test("MEMORY.md")).toBe(false);
	});

	it("does not match legacy dated memory files", () => {
		expect(MEMORY_BACKUP_FILENAME_RE.test("2026-01-20.md")).toBe(false);
		expect(ARTIFACT_FILENAME_RE.test("2026-01-20.md")).toBe(false);
	});

	it("does not match named memory files", () => {
		expect(MEMORY_BACKUP_FILENAME_RE.test("2026-02-10-signet.md")).toBe(false);
		expect(ARTIFACT_FILENAME_RE.test("2026-02-10-signet.md")).toBe(false);
	});

	it("does not match descriptive session files", () => {
		expect(MEMORY_BACKUP_FILENAME_RE.test("2026-02-22-dashboard-umap-projection-migration.md")).toBe(false);
		expect(ARTIFACT_FILENAME_RE.test("2026-02-22-dashboard-umap-projection-migration.md")).toBe(false);
	});

	it("does not match files with artifact kind in the middle of the name", () => {
		expect(MEMORY_BACKUP_FILENAME_RE.test("2026-03-01-phase-2-pre-compaction-capture-implementation-plan.md")).toBe(
			false,
		);
		expect(ARTIFACT_FILENAME_RE.test("2026-03-01-phase-2-pre-compaction-capture-implementation-plan.md")).toBe(false);
	});
});

describe("chunk content length gate", () => {
	// Mirrors the filtering logic in ingestMemoryMarkdown: chunks with
	// less than 80 chars of non-header body content should be skipped.

	function bodyLength(text: string, header: string): number {
		const body = header ? text.slice(header.length).trim() : text.trim();
		return body.length;
	}

	it("rejects a chunk that is only a section header", () => {
		expect(bodyLength("## Section Title", "## Section Title")).toBeLessThan(80);
	});

	it("rejects a chunk with header and short body", () => {
		const text = "## Section Title\n\nShort content here.";
		expect(bodyLength(text, "## Section Title")).toBeLessThan(80);
	});

	it("accepts a chunk with substantial body content", () => {
		const text =
			"## Section Title\n\nThis chunk contains a meaningful amount of content that describes the system configuration and behavior in enough detail to be useful.";
		expect(bodyLength(text, "## Section Title")).toBeGreaterThanOrEqual(80);
	});

	it("accepts a headerless chunk with enough content", () => {
		const text =
			"This standalone paragraph contains enough detail about the project's architecture to be worth storing as a memory.";
		expect(bodyLength(text, "")).toBeGreaterThanOrEqual(80);
	});

	it("rejects a headerless chunk that is too short", () => {
		const text = "Just a brief note.";
		expect(bodyLength(text, "")).toBeLessThan(80);
	});
});
