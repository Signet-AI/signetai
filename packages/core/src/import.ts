/**
 * Memory import functionality for Signet
 *
 * Handles importing existing memory logs (markdown files) into SQLite
 * for search and sync capabilities.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "./database";

/**
 * Result of a chunk operation
 */
export interface ChunkResult {
	/** The chunked text content */
	text: string;
	/** Estimated token count for this chunk */
	tokenCount: number;
}

/**
 * Hierarchical chunk that preserves markdown section structure.
 * Each chunk knows its section header and whether it's a full section
 * or a paragraph within a section.
 */
export interface HierarchicalChunk {
	/** The chunked text content (includes header for context) */
	text: string;
	/** Estimated token count for this chunk */
	tokenCount: number;
	/** The section heading (e.g., "## Signet npm Package Publishing") */
	header: string;
	/** Whether this is a full section or a paragraph within a section */
	level: "section" | "paragraph";
	/** Index of this chunk within the document */
	chunkIndex: number;
}

/**
 * Result of an import operation
 */
export interface ImportResult {
	/** Number of memories successfully imported */
	imported: number;
	/** Number of files skipped (e.g., already imported, invalid) */
	skipped: number;
	/** Error messages encountered during import */
	errors: string[];
}

/**
 * Options for chunking content
 */
export interface ChunkOptions {
	/** Maximum tokens per chunk */
	maxTokens: number;
}

/**
 * Date pattern for memory log filenames (YYYY-MM-DD.md)
 */
const DATE_FILENAME_PATTERN = /^(\d{4}-\d{2}-\d{2})\.md$/;

/**
 * Estimate token count for a given text.
 * Uses a simple heuristic: ~4 characters per token on average.
 * This is a rough approximation but works well for chunking purposes.
 */
function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

/**
 * Split content into chunks of approximately the specified token size.
 * Attempts to split on paragraph boundaries when possible.
 */
export function chunkContent(
	content: string,
	options: ChunkOptions,
): ChunkResult[] {
	const { maxTokens } = options;
	const results: ChunkResult[] = [];

	// Split into paragraphs (double newline)
	const paragraphs = content.split(/\n\n+/);

	let currentChunk: string[] = [];
	let currentTokens = 0;

	for (const paragraph of paragraphs) {
		const paragraphTokens = estimateTokens(paragraph);

		// If a single paragraph exceeds max tokens, split it further
		if (paragraphTokens > maxTokens) {
			// Flush current chunk first
			if (currentChunk.length > 0) {
				const text = currentChunk.join("\n\n").trim();
				if (text) {
					results.push({ text, tokenCount: currentTokens });
				}
				currentChunk = [];
				currentTokens = 0;
			}

			// Split large paragraph by sentences
			const sentences = paragraph.split(/(?<=[.!?])\s+/);

			for (const sentence of sentences) {
				const sentenceTokens = estimateTokens(sentence);

				if (sentenceTokens > maxTokens) {
					// Extremely long sentence - split by character limit
					const charLimit = maxTokens * 4;
					for (let i = 0; i < sentence.length; i += charLimit) {
						const chunk = sentence.slice(i, i + charLimit).trim();
						if (chunk) {
							results.push({ text: chunk, tokenCount: estimateTokens(chunk) });
						}
					}
				} else if (currentTokens + sentenceTokens > maxTokens) {
					// Start new chunk
					const text = currentChunk.join(" ").trim();
					if (text) {
						results.push({ text, tokenCount: currentTokens });
					}
					currentChunk = [sentence];
					currentTokens = sentenceTokens;
				} else {
					currentChunk.push(sentence);
					currentTokens += sentenceTokens;
				}
			}
		} else if (currentTokens + paragraphTokens > maxTokens) {
			// Start new chunk with this paragraph
			const text = currentChunk.join("\n\n").trim();
			if (text) {
				results.push({ text, tokenCount: currentTokens });
			}
			currentChunk = [paragraph];
			currentTokens = paragraphTokens;
		} else {
			// Add to current chunk
			currentChunk.push(paragraph);
			currentTokens += paragraphTokens;
		}
	}

	// Don't forget the last chunk
	if (currentChunk.length > 0) {
		const text = currentChunk.join("\n\n").trim();
		if (text) {
			results.push({ text, tokenCount: currentTokens });
		}
	}

	return results;
}

/**
 * Split markdown content into hierarchical chunks that preserve section structure.
 *
 * This uses a two-level approach:
 * 1. Section chunks: Embed each section's heading + full content when it fits
 * 2. Paragraph chunks: Split long sections into smaller pieces with header context
 *
 * Benefits:
 * - Context preservation: Retrieved chunks include their section header
 * - Better retrieval: Search matches fine-grained paragraphs with section context
 * - Deduplication: Track by document + section + chunk index
 *
 * @param content - The markdown content to chunk
 * @param options - Chunking options (maxTokens defaults to 512)
 * @returns Array of hierarchical chunks with header and level information
 */
export function chunkMarkdownHierarchically(
	content: string,
	options: ChunkOptions = { maxTokens: 512 },
): HierarchicalChunk[] {
	const results: HierarchicalChunk[] = [];
	const lines = content.split("\n");

	let currentHeader = "";
	let currentContent: string[] = [];
	let chunkIndex = 0;

	// Regex for markdown headers (h1-h3)
	const headerPattern = /^(#{1,3})\s+(.+)$/;

	const flushSection = () => {
		if (currentContent.length === 0) return;

		const sectionText = currentContent.join("\n").trim();
		if (!sectionText) return;

		const sectionTokens = estimateTokens(sectionText);

		if (sectionTokens <= options.maxTokens) {
			// Section fits in one chunk - include header for context
			const textWithHeader = currentHeader
				? `${currentHeader}\n\n${sectionText}`
				: sectionText;
			results.push({
				text: textWithHeader,
				tokenCount: estimateTokens(textWithHeader),
				header: currentHeader,
				level: "section",
				chunkIndex: chunkIndex++,
			});
		} else {
			// Split section into paragraph chunks with header context
			const paragraphs = sectionText.split(/\n\n+/);
			let chunkParas: string[] = [];
			let chunkTokens = currentHeader ? estimateTokens(currentHeader) : 0;

			for (const para of paragraphs) {
				const paraTokens = estimateTokens(para);

				// If single paragraph exceeds max, it needs to stand alone
				if (paraTokens > options.maxTokens) {
					// Flush current chunk first
					if (chunkParas.length > 0) {
						const text = currentHeader
							? `${currentHeader}\n\n${chunkParas.join("\n\n")}`
							: chunkParas.join("\n\n");
						results.push({
							text,
							tokenCount: chunkTokens,
							header: currentHeader,
							level: "paragraph",
							chunkIndex: chunkIndex++,
						});
						chunkParas = [];
						chunkTokens = currentHeader ? estimateTokens(currentHeader) : 0;
					}

					// Add large paragraph as its own chunk (with header context)
					const text = currentHeader ? `${currentHeader}\n\n${para}` : para;
					results.push({
						text,
						tokenCount: estimateTokens(text),
						header: currentHeader,
						level: "paragraph",
						chunkIndex: chunkIndex++,
					});
					continue;
				}

				if (
					chunkTokens + paraTokens + 2 > options.maxTokens &&
					chunkParas.length > 0
				) {
					// Flush current chunk
					const text = currentHeader
						? `${currentHeader}\n\n${chunkParas.join("\n\n")}`
						: chunkParas.join("\n\n");
					results.push({
						text,
						tokenCount: chunkTokens,
						header: currentHeader,
						level: "paragraph",
						chunkIndex: chunkIndex++,
					});
					chunkParas = [];
					chunkTokens = currentHeader ? estimateTokens(currentHeader) : 0;
				}

				chunkParas.push(para);
				chunkTokens += paraTokens + 2; // +2 for paragraph break
			}

			// Final chunk for this section
			if (chunkParas.length > 0) {
				const text = currentHeader
					? `${currentHeader}\n\n${chunkParas.join("\n\n")}`
					: chunkParas.join("\n\n");
				results.push({
					text,
					tokenCount: chunkTokens,
					header: currentHeader,
					level: "paragraph",
					chunkIndex: chunkIndex++,
				});
			}
		}

		currentContent = [];
	};

	for (const line of lines) {
		const match = line.match(headerPattern);
		if (match) {
			flushSection();
			currentHeader = line; // Keep full header with # marks
		} else {
			currentContent.push(line);
		}
	}

	flushSection(); // Final section

	// Handle content with no headers at all
	if (results.length === 0 && content.trim()) {
		const text = content.trim();
		results.push({
			text,
			tokenCount: estimateTokens(text),
			header: "",
			level: "section",
			chunkIndex: 0,
		});
	}

	return results;
}

/**
 * Extract date from a memory log filename.
 * Returns null if the filename doesn't match the expected pattern.
 */
function extractDateFromFilename(filename: string): string | null {
	const match = filename.match(DATE_FILENAME_PATTERN);
	return match ? match[1] : null;
}

/**
 * Import memory logs from a base path into the database.
 *
 * Reads all .md files from the `memory/` subdirectory (excluding files
 * starting with TEMPLATE), extracts dates from filenames, chunks content,
 * and inserts into the memories table.
 *
 * @param basePath - The base directory containing the `memory/` subdirectory
 * @param db - The initialized Database instance
 * @returns ImportResult with counts of imported, skipped, and any errors
 */
export function importMemoryLogs(basePath: string, db: Database): ImportResult {
	const result: ImportResult = {
		imported: 0,
		skipped: 0,
		errors: [],
	};

	const memoryDir = join(basePath, "memory");

	// Check if memory directory exists
	if (!existsSync(memoryDir)) {
		result.errors.push(`Memory directory not found: ${memoryDir}`);
		return result;
	}

	// Get all markdown files, excluding TEMPLATE files
	let files: string[];
	try {
		files = readdirSync(memoryDir).filter(
			(f) => f.endsWith(".md") && !f.startsWith("TEMPLATE"),
		);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		result.errors.push(`Failed to read memory directory: ${message}`);
		return result;
	}

	// Process each file
	for (const file of files) {
		const filePath = join(memoryDir, file);
		const date = extractDateFromFilename(file);

		if (!date) {
			result.skipped++;
			result.errors.push(
				`Invalid filename format (expected YYYY-MM-DD.md): ${file}`,
			);
			continue;
		}

		// Read file content
		let content: string;
		try {
			content = readFileSync(filePath, "utf-8");
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			result.errors.push(`Failed to read file ${file}: ${message}`);
			result.skipped++;
			continue;
		}

		// Skip empty files
		if (!content.trim()) {
			result.skipped++;
			continue;
		}

		// Chunk content into ~512 token pieces
		const chunks = chunkContent(content, { maxTokens: 512 });

		// Insert each chunk as a memory
		for (const chunk of chunks) {
			try {
				db.addMemory({
					type: "daily-log",
					category: date,
					content: chunk.text,
					confidence: 1.0,
					sourceType: "import",
					sourceId: file,
					tags: ["imported", "daily-log"],
					updatedBy: "signet-import",
					vectorClock: {},
					manualOverride: false,
				});
				result.imported++;
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				result.errors.push(`Failed to import chunk from ${file}: ${message}`);
			}
		}
	}

	return result;
}
