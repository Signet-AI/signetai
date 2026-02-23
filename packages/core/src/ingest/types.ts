/**
 * Types for the document ingestion engine.
 *
 * The ingestion pipeline: detect → parse → chunk → extract → store
 */

import type { MemoryType } from "../types";

// ---------------------------------------------------------------------------
// Ingestion options & results
// ---------------------------------------------------------------------------

export interface IngestOptions {
	/** Force file type detection */
	readonly type?: "markdown" | "pdf" | "txt" | "code" | "slack" | "discord" | "repo";
	/** Show what would be extracted without saving */
	readonly dryRun?: boolean;
	/** Show each extracted fact */
	readonly verbose?: boolean;
	/** LLM model for extraction (default: from agent.yaml) */
	readonly model?: string;
	/** Ollama base URL (default: http://localhost:11434) */
	readonly ollamaUrl?: string;
	/** Skip LLM extraction (store raw chunks only) */
	readonly skipExtraction?: boolean;
	/** Maximum chunks to process (for testing) */
	readonly maxChunks?: number;
	/** Database instance (required unless dryRun) */
	readonly db?: unknown;
	/** Agent DID for signing */
	readonly signerDid?: string;
	/** Workspace name for memory attribution */
	readonly workspace?: string;
}

export interface IngestResult {
	/** Total files processed */
	readonly filesProcessed: number;
	/** Total files that errored */
	readonly filesErrored: number;
	/** Total chunks generated */
	readonly totalChunks: number;
	/** Total memories created */
	readonly memoriesCreated: number;
	/** Breakdown by memory type */
	readonly byType: Record<string, number>;
	/** Per-file results */
	readonly files: readonly FileIngestResult[];
	/** Ingestion job ID (if tracking enabled) */
	readonly jobId?: string;
}

export interface FileIngestResult {
	readonly filePath: string;
	readonly status: "success" | "error" | "skipped";
	readonly error?: string;
	readonly chunks: number;
	readonly memoriesCreated: number;
	readonly byType: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Parsed document (output of parsers)
// ---------------------------------------------------------------------------

export interface ParsedSection {
	/** Heading text, or null for top-level content */
	readonly heading: string | null;
	/** Nesting depth (1 = H1, 2 = H2, etc.) */
	readonly depth: number;
	/** Raw text content of this section */
	readonly content: string;
	/** Content type hint */
	readonly contentType: "text" | "code" | "table" | "list" | "blockquote";
	/** Language hint for code blocks */
	readonly language?: string;
	/** Page number (for PDFs) */
	readonly page?: number;
	/** Line range in original file */
	readonly lineStart?: number;
	readonly lineEnd?: number;
}

export interface ParsedDocument {
	/** Source format */
	readonly format: string;
	/** Document title (if available) */
	readonly title: string | null;
	/** Sections */
	readonly sections: readonly ParsedSection[];
	/** Raw metadata from the original file */
	readonly metadata: Record<string, unknown>;
	/** Total character count of extracted text */
	readonly totalChars: number;
}

// ---------------------------------------------------------------------------
// Chunks (output of chunker)
// ---------------------------------------------------------------------------

export interface ChunkResult {
	/** Unique chunk index within the source */
	readonly index: number;
	/** The text content of this chunk */
	readonly text: string;
	/** Content type */
	readonly chunkType: "text" | "code" | "table" | "heading" | "conversation";
	/** Estimated token count (chars / 4 rough estimate) */
	readonly tokenCount: number;
	/** Provenance: which section heading this came from */
	readonly sourceSection: string | null;
	/** Provenance: page number (PDF) */
	readonly sourcePage: number | null;
	/** Provenance: line range */
	readonly sourceLineStart: number | null;
	readonly sourceLineEnd: number | null;
	/** Provenance: speaker (chat/email) */
	readonly speaker?: string | null;
	/** Provenance: thread ID (chat/email) */
	readonly threadId?: string | null;
}

// ---------------------------------------------------------------------------
// Extraction results (output of LLM extractor)
// ---------------------------------------------------------------------------

export interface ExtractedItem {
	readonly content: string;
	readonly type: string;
	readonly confidence: number;
	readonly metadata?: Record<string, unknown>;
}

export interface ExtractedRelation {
	readonly source: string;
	readonly relationship: string;
	readonly target: string;
	readonly confidence: number;
}

export interface ExtractionResult {
	readonly chunkIndex: number;
	readonly items: readonly ExtractedItem[];
	readonly relations: readonly ExtractedRelation[];
	readonly warnings: readonly string[];
}

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

export interface ProvenanceRecord {
	readonly sourcePath: string;
	readonly sourceType: string;
	readonly sourceSection: string | null;
	readonly sourcePage: number | null;
	readonly sourceLineStart: number | null;
	readonly sourceLineEnd: number | null;
	readonly fileHash: string;
	readonly ingestedAt: string;
	readonly chunkIndex: number;
}

// ---------------------------------------------------------------------------
// Progress callback (for CLI spinners)
// ---------------------------------------------------------------------------

export type ProgressCallback = (event: ProgressEvent) => void;

export type ProgressEvent =
	| { type: "file-start"; filePath: string; fileIndex: number; totalFiles: number }
	| { type: "file-done"; filePath: string; chunks: number; memories: number }
	| { type: "file-error"; filePath: string; error: string }
	| { type: "chunk-start"; chunkIndex: number; totalChunks: number }
	| { type: "chunk-done"; chunkIndex: number; items: number }
	| { type: "complete"; result: IngestResult };
