/**
 * PDF parser for the ingestion engine.
 *
 * Uses pdf-parse (v2) to extract text, then applies heuristic section detection
 * (large text on its own line → heading, page breaks → section boundaries).
 */

import { readFileSync } from "fs";
import { basename } from "path";
import type { ParsedDocument, ParsedSection } from "./types";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse a PDF file into structured sections.
 *
 * Uses pdf-parse v2 API (PDFParse class with { data } constructor).
 */
export async function parsePdf(filePath: string): Promise<ParsedDocument> {
	let text: string;
	let numPages: number;
	let info: Record<string, unknown> = {};

	try {
		// pdf-parse v2 — dynamic import to keep it optional
		const { PDFParse } = await import("pdf-parse") as any;

		const buffer = readFileSync(filePath);
		const parser = new PDFParse({ data: new Uint8Array(buffer) });

		try {
			const textResult = await parser.getText();
			text = textResult.text || "";
			numPages = textResult.total || 0;
		} catch (textErr) {
			// Some PDFs fail text extraction — try fallback
			throw textErr;
		}

		try {
			const infoResult = await parser.getInfo();
			info = infoResult ?? {};
		} catch {
			// info extraction is optional
		}

		// Clean up
		try { await parser.destroy(); } catch { /* ignore */ }
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (msg.includes("Cannot find") || msg.includes("MODULE_NOT_FOUND")) {
			throw new Error(
				"pdf-parse is not installed. Run: bun add pdf-parse",
			);
		}
		throw new Error(`Failed to parse PDF ${basename(filePath)}: ${msg}`);
	}

	const sections = splitPdfText(text, numPages);

	// Extract title from PDF metadata or first line
	let title: string | null = null;
	const infoTitle = (info as any)?.Title ?? (info as any)?.info?.Title;
	if (typeof infoTitle === "string" && infoTitle.trim()) {
		title = infoTitle.trim();
	} else {
		const firstLine = text.split("\n").find((l: string) => l.trim().length > 0);
		if (firstLine && firstLine.trim().length < 200) {
			title = firstLine.trim();
		}
	}

	return {
		format: "pdf",
		title: title || basename(filePath),
		sections,
		metadata: {
			pages: numPages,
			info,
		},
		totalChars: text.length,
	};
}

// ---------------------------------------------------------------------------
// Internal: split PDF text into sections
// ---------------------------------------------------------------------------

/**
 * PDF text doesn't have heading markers, so we use heuristics:
 * 1. Page breaks (form feeds \f) → new section per page
 * 2. Lines that look like headings (short, possibly all caps, followed by content)
 * 3. Large gaps between paragraphs
 */
function splitPdfText(text: string, numPages: number): ParsedSection[] {
	const sections: ParsedSection[] = [];

	// Split by page breaks first
	const pages = text.split("\f").filter((p) => p.trim().length > 0);

	for (let pageIdx = 0; pageIdx < pages.length; pageIdx++) {
		const pageText = pages[pageIdx].trim();
		if (pageText.length === 0) continue;

		const pageNum = pageIdx + 1;

		// Try to detect headings within the page
		const pageSections = detectPageSections(pageText, pageNum);
		sections.push(...pageSections);
	}

	// If no page breaks were found, treat the entire text as one document
	if (sections.length === 0 && text.trim().length > 0) {
		const pageSections = detectPageSections(text.trim(), 1);
		sections.push(...pageSections);
	}

	return sections;
}

/**
 * Detect sections within a single page of PDF text.
 */
function detectPageSections(pageText: string, pageNum: number): ParsedSection[] {
	const lines = pageText.split("\n");
	const sections: ParsedSection[] = [];

	let currentHeading: string | null = null;
	let currentLines: string[] = [];

	for (const line of lines) {
		const trimmed = line.trim();

		// Heuristic: short line (< 80 chars) that's followed by longer content
		// and is either ALL CAPS or looks like a title
		if (
			trimmed.length > 0 &&
			trimmed.length < 80 &&
			isLikelyHeading(trimmed)
		) {
			// Flush current section
			if (currentLines.length > 0) {
				const content = currentLines.join("\n").trim();
				if (content.length > 0) {
					sections.push({
						heading: currentHeading,
						depth: 1,
						content,
						contentType: "text",
						page: pageNum,
					});
				}
			}
			currentHeading = trimmed;
			currentLines = [];
			continue;
		}

		currentLines.push(line);
	}

	// Flush remaining
	const content = currentLines.join("\n").trim();
	if (content.length > 0) {
		sections.push({
			heading: currentHeading,
			depth: 1,
			content,
			contentType: "text",
			page: pageNum,
		});
	}

	// If nothing was detected, return the entire page as one section
	if (sections.length === 0 && pageText.trim().length > 0) {
		sections.push({
			heading: null,
			depth: 0,
			content: pageText.trim(),
			contentType: "text",
			page: pageNum,
		});
	}

	return sections;
}

/**
 * Heuristic: does this line look like a heading?
 */
function isLikelyHeading(line: string): boolean {
	// All caps (and not just a single word like "THE")
	if (line.length > 3 && line === line.toUpperCase() && /[A-Z]/.test(line)) {
		return true;
	}

	// Numbered heading: "1.", "1.1", "Section 3", "Chapter 5"
	if (/^(\d+\.)+\s/.test(line) || /^(Section|Chapter|Part)\s+\d/i.test(line)) {
		return true;
	}

	// Title case short line (multiple words, each starting with caps)
	const words = line.split(/\s+/);
	if (
		words.length >= 2 &&
		words.length <= 10 &&
		words.filter((w) => /^[A-Z]/.test(w)).length >= words.length * 0.6 &&
		!line.endsWith(".") &&
		!line.endsWith(",")
	) {
		return true;
	}

	return false;
}
