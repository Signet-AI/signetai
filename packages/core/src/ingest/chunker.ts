/**
 * Structure-aware intelligent chunking for the ingestion engine.
 *
 * Unlike naive fixed-size chunking, this respects document structure:
 * - Headers define chunk boundaries
 * - Code blocks stay together
 * - Lists stay together
 * - Tables stay together
 * - Overlap is applied at natural boundaries (sentences/paragraphs)
 *
 * Config: max ~2000 tokens (~8000 chars), min ~100 tokens, overlap ~200 tokens
 */

import type { ParsedDocument, ParsedSection, ChunkResult } from "./types";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface ChunkerConfig {
	/** Maximum tokens per chunk (estimated as chars / 4) */
	readonly maxTokens: number;
	/** Minimum tokens per chunk — avoid tiny fragments */
	readonly minTokens: number;
	/** Overlap tokens between consecutive chunks */
	readonly overlapTokens: number;
}

export const DEFAULT_CHUNKER_CONFIG: ChunkerConfig = {
	maxTokens: 2000,
	minTokens: 100,
	overlapTokens: 200,
};

// ---------------------------------------------------------------------------
// Token estimation
// ---------------------------------------------------------------------------

function estimateTokens(text: string): number {
	// Rough estimate: 1 token ≈ 4 characters for English text
	return Math.ceil(text.length / 4);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Chunk a parsed document into overlapping, structure-aware chunks.
 */
export function chunkDocument(
	doc: ParsedDocument,
	config: ChunkerConfig = DEFAULT_CHUNKER_CONFIG,
): ChunkResult[] {
	if (doc.sections.length === 0) return [];

	const chunks: ChunkResult[] = [];
	let chunkIndex = 0;

	// Group sections by heading hierarchy — try to keep related content together
	let currentText = "";
	let currentSection: string | null = null;
	let currentPage: number | null = null;
	let currentLineStart: number | null = null;
	let currentLineEnd: number | null = null;
	let currentType: ChunkResult["chunkType"] = "text";

	function flush(): void {
		const trimmed = currentText.trim();
		if (trimmed.length > 0 && estimateTokens(trimmed) >= config.minTokens) {
			chunks.push({
				index: chunkIndex++,
				text: trimmed,
				chunkType: currentType,
				tokenCount: estimateTokens(trimmed),
				sourceSection: currentSection,
				sourcePage: currentPage,
				sourceLineStart: currentLineStart,
				sourceLineEnd: currentLineEnd,
			});
		}
	}

	for (const section of doc.sections) {
		const sectionTokens = estimateTokens(section.content);
		const sectionType = mapContentType(section.contentType);

		// Update provenance tracking
		if (section.heading) {
			currentSection = section.heading;
		}
		if (section.page !== undefined) {
			currentPage = section.page;
		}

		// If adding this section would exceed max, flush
		if (
			currentText.length > 0 &&
			estimateTokens(currentText) + sectionTokens > config.maxTokens
		) {
			flush();

			// Carry overlap text forward
			const overlapText = getOverlapText(currentText, config.overlapTokens);
			currentText = overlapText;
			currentLineStart = section.lineStart ?? null;
			currentType = sectionType;
		}

		// If this single section is too large, split it
		if (sectionTokens > config.maxTokens) {
			// Flush any accumulated text first
			if (currentText.trim().length > 0) {
				flush();
				currentText = "";
			}

			const subChunks = splitLargeSection(
				section,
				config,
				chunkIndex,
			);
			for (const sub of subChunks) {
				chunks.push(sub);
				chunkIndex = sub.index + 1;
			}

			currentText = "";
			currentLineStart = null;
			currentType = "text";
			continue;
		}

		// Accumulate
		if (currentLineStart === null) {
			currentLineStart = section.lineStart ?? null;
		}
		currentLineEnd = section.lineEnd ?? null;

		// Add heading context
		if (section.heading) {
			currentText += `\n## ${section.heading}\n\n`;
		}
		currentText += section.content + "\n\n";

		// Update chunk type (code takes precedence)
		if (sectionType === "code") {
			currentType = "code";
		}
	}

	// Flush remaining
	flush();

	return chunks;
}

// ---------------------------------------------------------------------------
// Split oversized sections
// ---------------------------------------------------------------------------

function splitLargeSection(
	section: ParsedSection,
	config: ChunkerConfig,
	startIndex: number,
): ChunkResult[] {
	const chunks: ChunkResult[] = [];
	const maxChars = config.maxTokens * 4;
	const overlapChars = config.overlapTokens * 4;
	const sectionType = mapContentType(section.contentType);

	// For code, try to split on blank lines / function boundaries
	if (section.contentType === "code") {
		const codeChunks = splitCode(section.content, maxChars, overlapChars);
		for (let i = 0; i < codeChunks.length; i++) {
			const text = codeChunks[i].trim();
			if (estimateTokens(text) >= config.minTokens) {
				chunks.push({
					index: startIndex + i,
					text: section.heading
						? `## ${section.heading} (part ${i + 1})\n\n${text}`
						: text,
					chunkType: "code",
					tokenCount: estimateTokens(text),
					sourceSection: section.heading ?? null,
					sourcePage: section.page ?? null,
					sourceLineStart: section.lineStart ?? null,
					sourceLineEnd: section.lineEnd ?? null,
				});
			}
		}
		return chunks;
	}

	// For text, split on paragraph boundaries first, then sentences
	const textChunks = splitText(section.content, maxChars, overlapChars);
	for (let i = 0; i < textChunks.length; i++) {
		const text = textChunks[i].trim();
		if (estimateTokens(text) >= config.minTokens) {
			chunks.push({
				index: startIndex + i,
				text: section.heading
					? `## ${section.heading} (part ${i + 1})\n\n${text}`
					: text,
				chunkType: sectionType,
				tokenCount: estimateTokens(text),
				sourceSection: section.heading ?? null,
				sourcePage: section.page ?? null,
				sourceLineStart: section.lineStart ?? null,
				sourceLineEnd: section.lineEnd ?? null,
			});
		}
	}

	return chunks;
}

// ---------------------------------------------------------------------------
// Text splitting utilities
// ---------------------------------------------------------------------------

/**
 * Split text on paragraph boundaries with overlap.
 */
function splitText(text: string, maxChars: number, overlapChars: number): string[] {
	const paragraphs = text.split(/\n\n+/);
	const chunks: string[] = [];
	let current = "";

	for (const para of paragraphs) {
		if (current.length + para.length + 2 > maxChars && current.length > 0) {
			chunks.push(current.trim());
			// Start next chunk with overlap from end of current
			current = getOverlapText(current, Math.ceil(overlapChars / 4)) + "\n\n";
		}
		current += para + "\n\n";
	}

	if (current.trim().length > 0) {
		chunks.push(current.trim());
	}

	// If any chunk is still too large, do sentence-level splitting
	const result: string[] = [];
	for (const chunk of chunks) {
		if (chunk.length <= maxChars) {
			result.push(chunk);
		} else {
			result.push(...splitOnSentences(chunk, maxChars, overlapChars));
		}
	}

	return result;
}

/**
 * Split code on blank lines / function boundaries.
 */
function splitCode(code: string, maxChars: number, overlapChars: number): string[] {
	// Try to split on double newlines (between functions/classes)
	const blocks = code.split(/\n\n+/);
	const chunks: string[] = [];
	let current = "";

	for (const block of blocks) {
		if (current.length + block.length + 2 > maxChars && current.length > 0) {
			chunks.push(current.trim());
			current = "";
		}
		current += block + "\n\n";
	}

	if (current.trim().length > 0) {
		chunks.push(current.trim());
	}

	// Hard split if still too large
	const result: string[] = [];
	for (const chunk of chunks) {
		if (chunk.length <= maxChars) {
			result.push(chunk);
		} else {
			// Split on individual newlines as last resort
			const lines = chunk.split("\n");
			let cur = "";
			for (const line of lines) {
				if (cur.length + line.length + 1 > maxChars && cur.length > 0) {
					result.push(cur.trim());
					cur = "";
				}
				cur += line + "\n";
			}
			if (cur.trim().length > 0) {
				result.push(cur.trim());
			}
		}
	}

	return result;
}

/**
 * Split on sentence boundaries as a last resort.
 */
function splitOnSentences(text: string, maxChars: number, overlapChars: number): string[] {
	const sentences = text.match(/[^.!?\n]+[.!?\n]+\s*/g) ?? [text];
	const chunks: string[] = [];
	let current = "";

	for (const sentence of sentences) {
		if (current.length + sentence.length > maxChars && current.length > 0) {
			chunks.push(current.trim());
			current = current.slice(Math.max(0, current.length - overlapChars));
		}
		current += sentence;
	}

	if (current.trim().length > 0) {
		chunks.push(current.trim());
	}

	return chunks;
}

/**
 * Get the last N tokens of text for overlap, breaking at a natural boundary.
 */
function getOverlapText(text: string, overlapTokens: number): string {
	const overlapChars = overlapTokens * 4;
	if (text.length <= overlapChars) return text;

	const start = text.length - overlapChars;
	const slice = text.slice(start);

	// Try to find a sentence or paragraph boundary
	const sentenceStart = slice.search(/(?<=\.\s+|\n\n)[A-Z]/);
	if (sentenceStart > 0 && sentenceStart < overlapChars / 2) {
		return slice.slice(sentenceStart);
	}

	// Fall back to newline boundary
	const newlineIdx = slice.indexOf("\n");
	if (newlineIdx > 0 && newlineIdx < overlapChars / 3) {
		return slice.slice(newlineIdx + 1);
	}

	return slice;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mapContentType(
	contentType: ParsedSection["contentType"],
): ChunkResult["chunkType"] {
	switch (contentType) {
		case "code":
			return "code";
		case "table":
			return "table";
		default:
			return "text";
	}
}
