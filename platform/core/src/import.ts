/**
 * Memory import functionality for Signet
 *
 * Handles importing existing memory logs (markdown files) into SQLite
 * for search and sync capabilities.
 */

import { createHash } from "node:crypto";
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
	/** Number of files or chunks skipped (e.g., already imported, invalid) */
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

function isValidCalendarDate(value: string): boolean {
	const year = Number(value.slice(0, 4));
	const month = Number(value.slice(5, 7));
	const day = Number(value.slice(8, 10));
	if (month < 1 || month > 12 || day < 1) return false;

	const daysInMonth = [
		31,
		28 + (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 1 : 0),
		31,
		30,
		31,
		30,
		31,
		31,
		30,
		31,
		30,
		31,
	];
	return day <= daysInMonth[month - 1];
}

function validateMaxTokens(maxTokens: number): void {
	if (!Number.isSafeInteger(maxTokens) || maxTokens <= 0) {
		throw new RangeError("maxTokens must be a positive safe integer");
	}
}

function importChunkKey(file: string, chunkIndex: number, text: string): string {
	const hash = createHash("sha256").update(text).digest("hex");
	return `signet-import:${file}:${chunkIndex}:${hash}`;
}

/**
 * Split content into chunks of approximately the specified token size.
 * Attempts to split on paragraph boundaries when possible.
 */
export function chunkContent(content: string, options: ChunkOptions): ChunkResult[] {
	validateMaxTokens(options.maxTokens);
	const { maxTokens } = options;
	if (!content.trim()) return [];
	const results: ChunkResult[] = [];

	// Keep paragraph separators attached to the preceding paragraph.
	const paragraphs = content.match(/[\s\S]+?(?:\n\n+|$)/g) ?? [];
	let currentChunk: string[] = [];

	const flush = (): void => {
		const text = currentChunk.join("");
		if (text) results.push({ text, tokenCount: estimateTokens(text) });
		currentChunk = [];
	};

	for (const paragraph of paragraphs) {
		// If a single paragraph exceeds max tokens, split it further
		if (estimateTokens(paragraph) > maxTokens) {
			flush();

			// Keep sentence separators in the following sentence.
			const sentences = paragraph.split(/(?<=[.!?])(?=\s+)/);
			for (const sentence of sentences) {
				if (estimateTokens(sentence) > maxTokens) {
					// Flush earlier sentences so direct chunks stay in document order.
					flush();

					// Extremely long sentence - split by character limit
					const charLimit = maxTokens * 4;
					for (let i = 0; i < sentence.length; i += charLimit) {
						const text = sentence.slice(i, i + charLimit);
						if (text) results.push({ text, tokenCount: estimateTokens(text) });
					}
					continue;
				}

				const candidate = `${currentChunk.join("")}${sentence}`;
				if (currentChunk.length > 0 && estimateTokens(candidate) > maxTokens) flush();
				currentChunk.push(sentence);
			}
			continue;
		}

		const candidate = `${currentChunk.join("")}${paragraph}`;
		if (currentChunk.length > 0 && estimateTokens(candidate) > maxTokens) flush();
		currentChunk.push(paragraph);
	}

	flush();
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
	validateMaxTokens(options.maxTokens);
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

		const textWithHeader = currentHeader ? `${currentHeader}\n\n${sectionText}` : sectionText;
		const sectionTokens = estimateTokens(textWithHeader);

		if (sectionTokens <= options.maxTokens) {
			// Section fits in one chunk - include header for context
			results.push({
				text: textWithHeader,
				tokenCount: estimateTokens(textWithHeader),
				header: currentHeader,
				level: "section",
				chunkIndex: chunkIndex++,
			});
		} else {
			// Split section into paragraph chunks with header context.
			const paragraphs = sectionText.split(/\n\n+/);
			const fullPrefix = currentHeader ? `${currentHeader}\n\n` : "";
			const headerTokens = estimateTokens(fullPrefix);
			const includeHeader = currentHeader !== "" && headerTokens < options.maxTokens;
			const prefix = includeHeader ? fullPrefix : "";
			const bodyMaxTokens = includeHeader ? options.maxTokens - headerTokens : options.maxTokens;
			const push = (body: string): void => {
				const text = prefix ? `${prefix}${body}` : body;
				results.push({
					text,
					tokenCount: estimateTokens(text),
					header: currentHeader,
					level: "paragraph",
					chunkIndex: chunkIndex++,
				});
			};
			const split = (body: string): void => {
				for (const chunk of chunkContent(body, { maxTokens: bodyMaxTokens })) {
					push(chunk.text);
				}
			};
			let chunkParas: string[] = [];
			const flush = (): void => {
				if (chunkParas.length === 0) return;
				push(chunkParas.join("\n\n"));
				chunkParas = [];
			};

			for (const para of paragraphs) {
				const singleText = prefix ? `${prefix}${para}` : para;
				if (estimateTokens(singleText) > options.maxTokens) {
					flush();
					split(para);
					continue;
				}

				const combinedBody = chunkParas.length > 0 ? `${chunkParas.join("\n\n")}\n\n${para}` : para;
				const combinedText = prefix ? `${prefix}${combinedBody}` : combinedBody;
				if (chunkParas.length > 0 && estimateTokens(combinedText) > options.maxTokens) {
					flush();
				}
				chunkParas.push(para);
			}

			flush();
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
		for (const chunk of chunkContent(content, options)) {
			results.push({
				text: chunk.text,
				tokenCount: chunk.tokenCount,
				header: "",
				level: "section",
				chunkIndex: chunkIndex++,
			});
		}
	}

	return results;
}

/**
 * Extract date from a memory log filename.
 * Returns null if the filename doesn't match the expected pattern.
 */
function extractDateFromFilename(filename: string): string | null {
	const match = filename.match(DATE_FILENAME_PATTERN);
	return match && isValidCalendarDate(match[1]) ? match[1] : null;
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
		files = readdirSync(memoryDir).filter((f) => f.endsWith(".md") && !f.startsWith("TEMPLATE"));
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
			result.errors.push(`Invalid filename format (expected YYYY-MM-DD.md): ${file}`);
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

		// Insert each chunk as a memory. The database applies the scoped unique
		// index atomically, so concurrent imports report duplicates as skipped.
		for (const [chunkIndex, chunk] of chunks.entries()) {
			try {
				const idempotencyKey = importChunkKey(file, chunkIndex, chunk.text);
				const id = db.addMemoryIfAbsent({
					type: "daily-log",
					category: date,
					content: chunk.text,
					confidence: 1.0,
					sourceType: "import",
					sourceId: file,
					idempotencyKey,
					tags: ["imported", "daily-log"],
					updatedBy: "signet-import",
					vectorClock: {},
					manualOverride: false,
				});
				if (id === null) {
					result.skipped++;
					continue;
				}
				result.imported++;
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				result.errors.push(`Failed to import chunk from ${file}: ${message}`);
			}
		}
	}

	return result;
}
