/**
 * Document Ingestion Engine — "Pour your brain in"
 *
 * Main entry point: `ingestPath(path, options)` detects file type,
 * parses documents, chunks intelligently, extracts knowledge via LLM,
 * and stores as signed memories.
 *
 * Usage:
 *   import { ingestPath } from "@signet/core/ingest";
 *   const result = await ingestPath("~/Documents/notes/", { db, verbose: true });
 */

import { existsSync, statSync, readdirSync } from "fs";
import { join, extname, resolve, basename } from "path";
import type {
	IngestOptions,
	IngestResult,
	FileIngestResult,
	ParsedDocument,
	ChunkResult,
	ExtractionResult,
	ProgressCallback,
} from "./types";
import { parseMarkdown, parseTxt, parseCode } from "./markdown-parser";
import { parsePdf } from "./pdf-parser";
import { chunkDocument, DEFAULT_CHUNKER_CONFIG } from "./chunker";
import { extractFromChunks, DEFAULT_EXTRACTOR_CONFIG } from "./extractor";
import type { ExtractorConfig } from "./extractor";
import {
	computeFileHash,
	createIngestionJob,
	updateIngestionJob,
	buildProvenance,
} from "./provenance";

// Re-export all types
export type {
	IngestOptions,
	IngestResult,
	FileIngestResult,
	ParsedDocument,
	ParsedSection,
	ChunkResult,
	ExtractionResult,
	ExtractedItem,
	ExtractedRelation,
	ProvenanceRecord,
	ProgressCallback,
	ProgressEvent,
} from "./types";
export { chunkDocument, DEFAULT_CHUNKER_CONFIG } from "./chunker";
export type { ChunkerConfig } from "./chunker";
export { extractFromChunk, extractFromChunks, DEFAULT_EXTRACTOR_CONFIG } from "./extractor";
export type { ExtractorConfig } from "./extractor";
export { parseMarkdown, parseMarkdownContent, parseTxt, parseCode } from "./markdown-parser";
export { parsePdf } from "./pdf-parser";
export { computeFileHash, buildProvenance } from "./provenance";

// ---------------------------------------------------------------------------
// File type detection
// ---------------------------------------------------------------------------

const MARKDOWN_EXTS = new Set([".md", ".mdx", ".markdown"]);
const TXT_EXTS = new Set([".txt", ".text", ".log", ".rst"]);
const PDF_EXTS = new Set([".pdf"]);
const CODE_EXTS = new Set([
	".ts", ".tsx", ".js", ".jsx", ".py", ".rs", ".go", ".java",
	".rb", ".php", ".swift", ".kt", ".scala", ".c", ".cpp", ".h",
	".hpp", ".sh", ".bash", ".zsh", ".sql", ".yaml", ".yml",
	".toml", ".json", ".xml", ".css", ".scss", ".html", ".htm",
]);
const SKIP_FILES = new Set([
	".DS_Store", "Thumbs.db", ".gitkeep", "node_modules",
	".git", ".env", ".env.local",
]);

function detectFileType(filePath: string): "markdown" | "pdf" | "txt" | "code" | "skip" {
	const name = basename(filePath);
	const ext = extname(filePath).toLowerCase();

	if (SKIP_FILES.has(name)) return "skip";
	if (name.startsWith(".")) return "skip";

	if (MARKDOWN_EXTS.has(ext)) return "markdown";
	if (PDF_EXTS.has(ext)) return "pdf";
	if (TXT_EXTS.has(ext)) return "txt";
	if (CODE_EXTS.has(ext)) return "code";

	// Special filenames
	if (name.toLowerCase() === "makefile" || name.toLowerCase() === "dockerfile") {
		return "code";
	}

	// Default: try as text
	return "txt";
}

// ---------------------------------------------------------------------------
// Collect files from path (file or directory)
// ---------------------------------------------------------------------------

function collectFiles(
	inputPath: string,
	forcedType?: string,
): Array<{ path: string; type: "markdown" | "pdf" | "txt" | "code" }> {
	const absPath = resolve(inputPath);

	if (!existsSync(absPath)) {
		throw new Error(`Path does not exist: ${absPath}`);
	}

	const stat = statSync(absPath);

	if (stat.isFile()) {
		const type = (forcedType as "markdown" | "pdf" | "txt" | "code") || detectFileType(absPath);
		if (type === "skip") return [];
		return [{ path: absPath, type }];
	}

	if (stat.isDirectory()) {
		return collectDirectory(absPath, forcedType);
	}

	return [];
}

function collectDirectory(
	dirPath: string,
	forcedType?: string,
): Array<{ path: string; type: "markdown" | "pdf" | "txt" | "code" }> {
	const files: Array<{ path: string; type: "markdown" | "pdf" | "txt" | "code" }> = [];

	const entries = readdirSync(dirPath, { withFileTypes: true });
	for (const entry of entries) {
		const fullPath = join(dirPath, entry.name);

		// Skip hidden dirs and common non-content dirs
		if (entry.name.startsWith(".") || SKIP_FILES.has(entry.name)) continue;

		if (entry.isDirectory()) {
			// Recurse but skip node_modules, .git, etc.
			if (!["node_modules", "dist", "build", "__pycache__", ".git", ".svn"].includes(entry.name)) {
				files.push(...collectDirectory(fullPath, forcedType));
			}
		} else if (entry.isFile()) {
			const type = (forcedType as "markdown" | "pdf" | "txt" | "code") || detectFileType(fullPath);
			if (type !== "skip") {
				files.push({ path: fullPath, type });
			}
		}
	}

	return files;
}

// ---------------------------------------------------------------------------
// Parse a file based on its detected type
// ---------------------------------------------------------------------------

async function parseFile(
	filePath: string,
	fileType: "markdown" | "pdf" | "txt" | "code",
): Promise<ParsedDocument> {
	switch (fileType) {
		case "markdown":
			return parseMarkdown(filePath);
		case "pdf":
			return await parsePdf(filePath);
		case "txt":
			return parseTxt(filePath);
		case "code":
			return parseCode(filePath);
		default:
			return parseTxt(filePath);
	}
}

// ---------------------------------------------------------------------------
// Store extracted memories in the database
// ---------------------------------------------------------------------------

function storeMemories(
	db: unknown,
	items: ExtractionResult["items"],
	chunk: ChunkResult,
	filePath: string,
	fileHash: string,
	options: IngestOptions,
): number {
	if (!db || items.length === 0) return 0;

	const dbAny = db as {
		prepare(sql: string): {
			run(...args: unknown[]): void;
		};
	};

	let created = 0;

	for (const item of items) {
		try {
			const id = crypto.randomUUID();
			const now = new Date().toISOString();

			dbAny
				.prepare(
					`INSERT INTO memories
					 (id, type, content, confidence, source_id, source_type, tags,
					  created_at, updated_at, updated_by, vector_clock, manual_override,
					  who, source_path, source_section)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.run(
					id,
					item.type,
					item.content,
					item.confidence,
					fileHash,
					"ingestion",
					JSON.stringify([`ingest:${basename(filePath)}`]),
					now,
					now,
					options.workspace || "ingestion-engine",
					JSON.stringify({}),
					0,
					options.workspace || "ingestion-engine",
					filePath,
					chunk.sourceSection,
				);

			// Enqueue embedding job
			try {
				const jobId = crypto.randomUUID();
				dbAny
					.prepare(
						`INSERT INTO memory_jobs
						 (id, memory_id, job_type, status, max_attempts, created_at, updated_at)
						 VALUES (?, ?, 'embed', 'pending', 3, ?, ?)`,
					)
					.run(jobId, id, now, now);
			} catch {
				// Embedding job queue might fail — not fatal
			}

			created++;
		} catch (err) {
			// Individual memory insert failure shouldn't crash ingestion
			// (e.g., unique constraint violation on content_hash)
		}
	}

	return created;
}

// ---------------------------------------------------------------------------
// Main public API
// ---------------------------------------------------------------------------

/**
 * Ingest a file or directory of documents.
 *
 * This is the "pour your brain in" function. Point it at a path
 * and it will:
 * 1. Detect all supported files
 * 2. Parse each file into sections
 * 3. Chunk sections intelligently
 * 4. Extract knowledge using an LLM
 * 5. Store as memories with provenance tracking
 *
 * @param inputPath - File or directory to ingest
 * @param options - Configuration options
 * @param onProgress - Optional progress callback
 * @returns Ingestion results summary
 */
export async function ingestPath(
	inputPath: string,
	options: IngestOptions = {},
	onProgress?: ProgressCallback,
): Promise<IngestResult> {
	// Collect files
	const files = collectFiles(inputPath, options.type);
	if (files.length === 0) {
		return {
			filesProcessed: 0,
			filesErrored: 0,
			totalChunks: 0,
			memoriesCreated: 0,
			byType: {},
			files: [],
		};
	}

	// Configure extractor
	const extractorConfig: ExtractorConfig = {
		ollamaUrl: options.ollamaUrl || DEFAULT_EXTRACTOR_CONFIG.ollamaUrl,
		model: options.model || DEFAULT_EXTRACTOR_CONFIG.model,
		timeoutMs: DEFAULT_EXTRACTOR_CONFIG.timeoutMs,
		minConfidence: DEFAULT_EXTRACTOR_CONFIG.minConfidence,
	};

	const fileResults: FileIngestResult[] = [];
	let totalChunks = 0;
	let totalMemories = 0;
	const totalByType: Record<string, number> = {};

	for (let fileIdx = 0; fileIdx < files.length; fileIdx++) {
		const file = files[fileIdx];

		onProgress?.({
			type: "file-start",
			filePath: file.path,
			fileIndex: fileIdx,
			totalFiles: files.length,
		});

		try {
			const result = await ingestSingleFile(
				file.path,
				file.type,
				extractorConfig,
				options,
				onProgress,
			);

			fileResults.push(result);
			totalChunks += result.chunks;
			totalMemories += result.memoriesCreated;

			for (const [type, count] of Object.entries(result.byType)) {
				totalByType[type] = (totalByType[type] || 0) + count;
			}

			onProgress?.({
				type: "file-done",
				filePath: file.path,
				chunks: result.chunks,
				memories: result.memoriesCreated,
			});
		} catch (err) {
			const errorMsg = err instanceof Error ? err.message : String(err);
			fileResults.push({
				filePath: file.path,
				status: "error",
				error: errorMsg,
				chunks: 0,
				memoriesCreated: 0,
				byType: {},
			});

			onProgress?.({
				type: "file-error",
				filePath: file.path,
				error: errorMsg,
			});
		}
	}

	const result: IngestResult = {
		filesProcessed: fileResults.filter((f) => f.status === "success").length,
		filesErrored: fileResults.filter((f) => f.status === "error").length,
		totalChunks,
		memoriesCreated: totalMemories,
		byType: totalByType,
		files: fileResults,
	};

	onProgress?.({ type: "complete", result });

	return result;
}

// ---------------------------------------------------------------------------
// Single file ingestion
// ---------------------------------------------------------------------------

async function ingestSingleFile(
	filePath: string,
	fileType: "markdown" | "pdf" | "txt" | "code",
	extractorConfig: ExtractorConfig,
	options: IngestOptions,
	onProgress?: ProgressCallback,
): Promise<FileIngestResult> {
	// 1. Parse
	const doc = await parseFile(filePath, fileType);

	if (doc.sections.length === 0 || doc.totalChars < 50) {
		return {
			filePath,
			status: "skipped",
			chunks: 0,
			memoriesCreated: 0,
			byType: {},
		};
	}

	// 2. Chunk
	let chunks = chunkDocument(doc, DEFAULT_CHUNKER_CONFIG);
	if (options.maxChunks && chunks.length > options.maxChunks) {
		chunks = chunks.slice(0, options.maxChunks);
	}

	if (chunks.length === 0) {
		return {
			filePath,
			status: "skipped",
			chunks: 0,
			memoriesCreated: 0,
			byType: {},
		};
	}

	// 3. Track provenance
	const fileHash = computeFileHash(filePath);

	// Create ingestion job if DB is available
	const jobId = crypto.randomUUID();
	if (options.db && !options.dryRun) {
		createIngestionJob(options.db, jobId, filePath, fileType, fileHash);
		updateIngestionJob(options.db, jobId, { chunksTotal: chunks.length });
	}

	// 4. Extract (unless skipExtraction or dryRun with no model)
	let memoriesCreated = 0;
	const byType: Record<string, number> = {};

	if (options.skipExtraction) {
		// Store raw chunks as memories directly
		if (!options.dryRun && options.db) {
			for (const chunk of chunks) {
				const stored = storeMemories(
					options.db,
					[{ content: chunk.text, type: "fact", confidence: 0.5 }],
					chunk,
					filePath,
					fileHash,
					options,
				);
				memoriesCreated += stored;
				byType["fact"] = (byType["fact"] || 0) + stored;
			}
		}
	} else {
		// LLM extraction
		const extractions = await extractFromChunks(
			chunks,
			doc.title,
			extractorConfig,
			(chunkIdx, itemCount) => {
				onProgress?.({
					type: "chunk-done",
					chunkIndex: chunkIdx,
					items: itemCount,
				});

				// Update job progress
				if (options.db && !options.dryRun) {
					updateIngestionJob(options.db, jobId, {
						chunksProcessed: chunkIdx + 1,
					});
				}
			},
		);

		// Store extracted items
		for (let i = 0; i < extractions.length; i++) {
			const extraction = extractions[i];
			const chunk = chunks[i];

			if (!options.dryRun && options.db) {
				const stored = storeMemories(
					options.db,
					extraction.items,
					chunk,
					filePath,
					fileHash,
					options,
				);
				memoriesCreated += stored;
			} else {
				// Dry run: just count
				memoriesCreated += extraction.items.length;
			}

			for (const item of extraction.items) {
				byType[item.type] = (byType[item.type] || 0) + 1;
			}
		}
	}

	// Update job as completed
	if (options.db && !options.dryRun) {
		updateIngestionJob(options.db, jobId, {
			status: "completed",
			chunksProcessed: chunks.length,
			memoriesCreated,
		});
	}

	return {
		filePath,
		status: "success",
		chunks: chunks.length,
		memoriesCreated,
		byType,
	};
}
