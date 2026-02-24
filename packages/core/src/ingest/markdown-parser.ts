/**
 * Markdown / TXT parser for the ingestion engine.
 *
 * Parses markdown into sections, respecting heading hierarchy.
 * Handles code blocks, tables, lists, and blockquotes as distinct content types.
 */

import { readFileSync } from "fs";
import { basename } from "path";
import type { ParsedDocument, ParsedSection } from "./types";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse a markdown or plain text file into structured sections.
 */
export function parseMarkdown(filePath: string): ParsedDocument {
	const raw = readFileSync(filePath, "utf-8");
	return parseMarkdownContent(raw, basename(filePath));
}

/**
 * Parse markdown content string directly (for testing / reuse).
 */
export function parseMarkdownContent(
	content: string,
	title: string | null = null,
): ParsedDocument {
	const lines = content.split("\n");
	const sections: ParsedSection[] = [];
	let lineIndex = 0;

	// Extract title from first H1 if present
	let docTitle = title;
	if (lines.length > 0 && lines[0].startsWith("# ")) {
		docTitle = lines[0].replace(/^#\s+/, "").trim();
	}

	// State machine
	let currentHeading: string | null = null;
	let currentDepth = 0;
	let currentLines: string[] = [];
	let currentContentType: ParsedSection["contentType"] = "text";
	let sectionStartLine = 1;
	let inCodeBlock = false;
	let codeBlockLang: string | undefined;
	let inTable = false;

	function flushSection(): void {
		const text = currentLines.join("\n").trim();
		if (text.length > 0) {
			sections.push({
				heading: currentHeading,
				depth: currentDepth,
				content: text,
				contentType: currentContentType,
				language: codeBlockLang,
				lineStart: sectionStartLine,
				lineEnd: lineIndex,
			});
		}
		currentLines = [];
		currentContentType = "text";
		codeBlockLang = undefined;
		sectionStartLine = lineIndex + 1;
	}

	for (lineIndex = 0; lineIndex < lines.length; lineIndex++) {
		const line = lines[lineIndex];

		// Handle code blocks (fenced with ``` or ~~~)
		if (!inCodeBlock && (line.startsWith("```") || line.startsWith("~~~"))) {
			// Start of code block — flush current text section first
			if (currentLines.length > 0 && currentContentType !== "code") {
				flushSection();
			}
			inCodeBlock = true;
			codeBlockLang = line.replace(/^[`~]+/, "").trim() || undefined;
			currentContentType = "code";
			currentLines.push(line);
			continue;
		}

		if (inCodeBlock && (line.startsWith("```") || line.startsWith("~~~"))) {
			// End of code block
			currentLines.push(line);
			inCodeBlock = false;
			flushSection();
			continue;
		}

		if (inCodeBlock) {
			currentLines.push(line);
			continue;
		}

		// Handle headings (ATX style: # H1, ## H2, etc.)
		const headingMatch = line.match(/^(#{1,6})\s+(.+)/);
		if (headingMatch) {
			// Flush the previous section
			flushSection();

			currentDepth = headingMatch[1].length;
			currentHeading = headingMatch[2].trim();
			sectionStartLine = lineIndex + 1;
			continue;
		}

		// Handle tables (lines starting with |)
		if (line.startsWith("|") || (line.match(/^\s*\|/) && line.includes("|"))) {
			if (!inTable && currentLines.length > 0 && currentContentType !== "table") {
				flushSection();
			}
			inTable = true;
			currentContentType = "table";
			currentLines.push(line);
			continue;
		}

		if (inTable && !line.startsWith("|") && !line.match(/^\s*\|/)) {
			inTable = false;
			flushSection();
		}

		// Handle blockquotes
		if (line.startsWith(">")) {
			if (currentContentType !== "blockquote" && currentLines.length > 0) {
				flushSection();
			}
			currentContentType = "blockquote";
			currentLines.push(line);
			continue;
		}

		if (currentContentType === "blockquote" && !line.startsWith(">") && line.trim() !== "") {
			flushSection();
		}

		// Handle list items (detect list context)
		if (line.match(/^\s*[-*+]\s/) || line.match(/^\s*\d+\.\s/)) {
			if (currentContentType !== "list" && currentLines.length > 0) {
				// Only flush if we're switching from non-list to list
				// and we have substantial text content
				if (currentContentType !== "text" || currentLines.some(l => l.trim().length > 0 && !l.match(/^\s*[-*+]\s/) && !l.match(/^\s*\d+\.\s/))) {
					flushSection();
				}
			}
			currentContentType = "list";
			currentLines.push(line);
			continue;
		}

		// Regular text
		if (currentContentType === "list" && line.trim() === "") {
			// Blank line after list — might continue or end
			currentLines.push(line);
			continue;
		}

		if (currentContentType === "list" && line.trim() !== "" && !line.match(/^\s+/)) {
			// Non-indented, non-list line after list = end of list
			flushSection();
			currentContentType = "text";
		}

		currentLines.push(line);
	}

	// Flush remaining
	flushSection();

	const totalChars = sections.reduce((sum, s) => sum + s.content.length, 0);

	return {
		format: "markdown",
		title: docTitle,
		sections,
		metadata: {},
		totalChars,
	};
}

/**
 * Parse a plain text file (no markdown structure).
 * Splits on blank lines as paragraph boundaries.
 */
export function parseTxt(filePath: string): ParsedDocument {
	const raw = readFileSync(filePath, "utf-8");
	const paragraphs = raw.split(/\n\n+/).filter((p) => p.trim().length > 0);

	const sections: ParsedSection[] = paragraphs.map((para, i) => ({
		heading: null,
		depth: 0,
		content: para.trim(),
		contentType: "text" as const,
		lineStart: undefined,
		lineEnd: undefined,
	}));

	return {
		format: "txt",
		title: basename(filePath),
		sections,
		metadata: {},
		totalChars: raw.length,
	};
}

/**
 * Parse a code file — treat the whole file as one code section
 * with the filename as the heading.
 */
export function parseCode(filePath: string): ParsedDocument {
	const raw = readFileSync(filePath, "utf-8");
	const ext = filePath.split(".").pop() || "";

	// Map file extensions to language names
	const langMap: Record<string, string> = {
		ts: "typescript", tsx: "typescript",
		js: "javascript", jsx: "javascript",
		py: "python", rs: "rust", go: "go",
		java: "java", rb: "ruby", php: "php",
		swift: "swift", kt: "kotlin", scala: "scala",
		c: "c", cpp: "cpp", h: "c", hpp: "cpp",
		sh: "bash", bash: "bash", zsh: "zsh",
		sql: "sql", yaml: "yaml", yml: "yaml",
		toml: "toml", json: "json",
	};

	const sections: ParsedSection[] = [{
		heading: basename(filePath),
		depth: 1,
		content: raw,
		contentType: "code",
		language: langMap[ext] || ext,
		lineStart: 1,
		lineEnd: raw.split("\n").length,
	}];

	return {
		format: "code",
		title: basename(filePath),
		sections,
		metadata: { language: langMap[ext] || ext },
		totalChars: raw.length,
	};
}
