/**
 * Provenance tracking for ingested documents.
 *
 * Records where each piece of knowledge came from:
 * source file, section, page, line range, and ingestion timestamp.
 */

import { createHash } from "crypto";
import { readFileSync, statSync } from "fs";
import type { ChunkResult, DatabaseLike, ProvenanceRecord } from "./types";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compute a SHA-256 hash of a file for deduplication.
 */
export function computeFileHash(filePath: string): string {
	try {
		const content = readFileSync(filePath);
		return createHash("sha256").update(content).digest("hex");
	} catch {
		// Fall back to path-based hash if file can't be read
		return createHash("sha256").update(filePath).digest("hex");
	}
}

/**
 * Check if a file has already been ingested (by hash).
 * Returns the existing job ID if found, null otherwise.
 */
export function checkAlreadyIngested(
	db: DatabaseLike,
	fileHash: string,
): string | null {
	try {
		const row = db
			.prepare(
				"SELECT id FROM ingestion_jobs WHERE file_hash = ? AND status = 'completed'",
			)
			.get(fileHash);

		return row ? (row.id as string) : null;
	} catch {
		// Table might not exist yet — that's fine
		return null;
	}
}

/**
 * Build a provenance record for a chunk.
 */
export function buildProvenance(
	chunk: ChunkResult,
	filePath: string,
	sourceType: string,
	fileHash: string,
): ProvenanceRecord {
	return {
		sourcePath: filePath,
		sourceType,
		sourceSection: chunk.sourceSection,
		sourcePage: chunk.sourcePage,
		sourceLineStart: chunk.sourceLineStart,
		sourceLineEnd: chunk.sourceLineEnd,
		fileHash,
		ingestedAt: new Date().toISOString(),
		chunkIndex: chunk.index,
	};
}

/**
 * Get file metadata for tracking.
 */
export function getFileMetadata(filePath: string): {
	size: number;
	modified: string;
} {
	try {
		const stat = statSync(filePath);
		return {
			size: stat.size,
			modified: stat.mtime.toISOString(),
		};
	} catch {
		return { size: 0, modified: new Date().toISOString() };
	}
}

// ---------------------------------------------------------------------------
// Ingestion job tracking (database operations)
// ---------------------------------------------------------------------------

export interface IngestionJobRow {
	id: string;
	source_path: string;
	source_type: string;
	file_hash: string;
	status: string;
	chunks_total: number;
	chunks_processed: number;
	memories_created: number;
	started_at: string;
	completed_at: string | null;
	error: string | null;
}

/**
 * Create an ingestion job record in the database.
 */
export function createIngestionJob(
	db: DatabaseLike,
	jobId: string,
	sourcePath: string,
	sourceType: string,
	fileHash: string,
): void {
	try {
		db
			.prepare(
				`INSERT INTO ingestion_jobs
				 (id, source_path, source_type, file_hash, status, chunks_total, chunks_processed, memories_created, started_at)
				 VALUES (?, ?, ?, ?, 'processing', 0, 0, 0, ?)`,
			)
			.run(jobId, sourcePath, sourceType, fileHash, new Date().toISOString());
	} catch {
		// Migration may not have run yet — not a fatal error
	}
}

/**
 * Update an ingestion job's progress.
 */
export function updateIngestionJob(
	db: DatabaseLike,
	jobId: string,
	updates: {
		status?: string;
		chunksTotal?: number;
		chunksProcessed?: number;
		memoriesCreated?: number;
		error?: string;
	},
): void {
	try {
		const sets: string[] = [];
		const values: unknown[] = [];

		if (updates.status !== undefined) {
			sets.push("status = ?");
			values.push(updates.status);
		}
		if (updates.chunksTotal !== undefined) {
			sets.push("chunks_total = ?");
			values.push(updates.chunksTotal);
		}
		if (updates.chunksProcessed !== undefined) {
			sets.push("chunks_processed = ?");
			values.push(updates.chunksProcessed);
		}
		if (updates.memoriesCreated !== undefined) {
			sets.push("memories_created = ?");
			values.push(updates.memoriesCreated);
		}
		if (updates.error !== undefined) {
			sets.push("error = ?");
			values.push(updates.error);
		}

		if (updates.status === "completed" || updates.status === "failed") {
			sets.push("completed_at = ?");
			values.push(new Date().toISOString());
		}

		if (sets.length === 0) return;

		values.push(jobId);
		db
			.prepare(`UPDATE ingestion_jobs SET ${sets.join(", ")} WHERE id = ?`)
			.run(...values);
	} catch {
		// Not fatal
	}
}
