/**
 * Job worker for the document ingest pipeline.
 *
 * Polls memory_jobs for document_ingest jobs, processes documents
 * through extracting → chunking → embedding → indexing → done states.
 * Each chunk becomes a memory linked via document_memories.
 *
 * Same transaction discipline as the extraction worker: no provider
 * calls inside write locks.
 */

import type { DbAccessor, WriteDb } from "../db-accessor";
import type { EmbeddingConfig, PipelineV2Config } from "../memory-config";
import { normalizeAndHashContent } from "../content-normalization";
import { vectorToBlob, syncVecInsert } from "../db-helpers";
import { txIngestEnvelope } from "../transactions";
import { fetchUrlContent } from "./url-fetcher";
import { logger } from "../logger";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DocumentWorkerHandle {
	stop(): Promise<void>;
	readonly running: boolean;
}

export interface DocumentWorkerDeps {
	readonly accessor: DbAccessor;
	readonly embeddingCfg: EmbeddingConfig;
	readonly fetchEmbedding: (
		text: string,
		cfg: EmbeddingConfig,
	) => Promise<number[] | null>;
	readonly pipelineCfg: PipelineV2Config;
}

interface DocumentJobRow {
	readonly id: string;
	readonly memory_id: string | null;
	readonly document_id: string | null;
	readonly job_type: string;
	readonly payload: string | null;
	readonly attempts: number;
	readonly max_attempts: number;
}

interface DocumentRow {
	readonly id: string;
	readonly source_url: string | null;
	readonly source_type: string;
	readonly content_type: string | null;
	readonly title: string | null;
	readonly raw_content: string | null;
	readonly status: string;
	readonly error: string | null;
}

// ---------------------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------------------

function chunkText(
	text: string,
	chunkSize: number,
	overlap: number,
): readonly string[] {
	if (text.length <= chunkSize) return [text];

	const chunks: string[] = [];
	let start = 0;

	while (start < text.length) {
		const end = Math.min(start + chunkSize, text.length);
		chunks.push(text.slice(start, end));
		const next = end - overlap;
		// Avoid infinite loop if overlap >= chunkSize
		if (next <= start) break;
		start = next;
	}

	return chunks;
}

// ---------------------------------------------------------------------------
// Job leasing (document_ingest specific)
// ---------------------------------------------------------------------------

function leaseDocumentJob(
	db: WriteDb,
	maxAttempts: number,
): DocumentJobRow | null {
	const now = new Date().toISOString();

	const row = db
		.prepare(
			`SELECT id, memory_id, document_id, job_type, payload,
			        attempts, max_attempts
			 FROM memory_jobs
			 WHERE job_type = 'document_ingest'
			   AND status = 'pending'
			   AND attempts < ?
			 ORDER BY created_at ASC
			 LIMIT 1`,
		)
		.get(maxAttempts) as DocumentJobRow | undefined;

	if (!row) return null;

	db.prepare(
		`UPDATE memory_jobs
		 SET status = 'leased', leased_at = ?,
		     attempts = attempts + 1, updated_at = ?
		 WHERE id = ?`,
	).run(now, now, row.id);

	return { ...row, attempts: row.attempts + 1 };
}

function completeJob(db: WriteDb, jobId: string): void {
	const now = new Date().toISOString();
	db.prepare(
		`UPDATE memory_jobs
		 SET status = 'completed', completed_at = ?, updated_at = ?
		 WHERE id = ?`,
	).run(now, now, jobId);
}

function failJob(
	db: WriteDb,
	jobId: string,
	error: string,
	attempts: number,
	maxAttempts: number,
): void {
	const now = new Date().toISOString();
	const nextStatus = attempts >= maxAttempts ? "dead" : "pending";
	db.prepare(
		`UPDATE memory_jobs
		 SET status = ?, error = ?, failed_at = ?, updated_at = ?
		 WHERE id = ?`,
	).run(nextStatus, error, now, now, jobId);
}

// ---------------------------------------------------------------------------
// Document status updates
// ---------------------------------------------------------------------------

function updateDocumentStatus(
	db: WriteDb,
	docId: string,
	status: string,
	error?: string,
): void {
	const now = new Date().toISOString();
	if (error !== undefined) {
		db.prepare(
			`UPDATE documents
			 SET status = ?, error = ?, updated_at = ?
			 WHERE id = ?`,
		).run(status, error, now, docId);
	} else {
		db.prepare(
			`UPDATE documents
			 SET status = ?, updated_at = ?
			 WHERE id = ?`,
		).run(status, now, docId);
	}
}

function completeDocument(
	db: WriteDb,
	docId: string,
	chunkCount: number,
	memoryCount: number,
): void {
	const now = new Date().toISOString();
	db.prepare(
		`UPDATE documents
		 SET status = 'done', chunk_count = ?, memory_count = ?,
		     completed_at = ?, updated_at = ?
		 WHERE id = ?`,
	).run(chunkCount, memoryCount, now, now, docId);
}

// ---------------------------------------------------------------------------
// Enqueue helper (called by document API endpoints)
// ---------------------------------------------------------------------------

export function enqueueDocumentIngestJob(
	accessor: DbAccessor,
	documentId: string,
): void {
	accessor.withWriteTx((db) => {
		const existing = db
			.prepare(
				`SELECT 1 FROM memory_jobs
				 WHERE document_id = ? AND job_type = 'document_ingest'
				   AND status IN ('pending', 'leased')
				 LIMIT 1`,
			)
			.get(documentId);
		if (existing) return;

		const id = crypto.randomUUID();
		const now = new Date().toISOString();
		db.prepare(
			`INSERT INTO memory_jobs
			 (id, memory_id, document_id, job_type, status,
			  attempts, max_attempts, created_at, updated_at)
			 VALUES (?, NULL, ?, 'document_ingest', 'pending', 0, ?, ?, ?)`,
		).run(id, documentId, 3, now, now);
	});
}

// ---------------------------------------------------------------------------
// Core processing logic
// ---------------------------------------------------------------------------

async function processDocument(
	deps: DocumentWorkerDeps,
	job: DocumentJobRow,
): Promise<void> {
	const { accessor, embeddingCfg, fetchEmbedding, pipelineCfg } = deps;
	const docId = job.document_id;
	if (!docId) {
		throw new Error("document_ingest job missing document_id");
	}

	const doc = accessor.withReadDb((db) => {
		return db
			.prepare("SELECT * FROM documents WHERE id = ?")
			.get(docId) as DocumentRow | undefined;
	});

	if (!doc) {
		throw new Error(`Document ${docId} not found`);
	}

	if (doc.status === "done") {
		accessor.withWriteTx((db) => completeJob(db, job.id));
		return;
	}

	// -- Step 1: Extract content --
	accessor.withWriteTx((db) =>
		updateDocumentStatus(db, docId, "extracting"),
	);

	let content: string;
	let title = doc.title;

	if (doc.source_type === "url" && doc.source_url) {
		const result = await fetchUrlContent(doc.source_url, {
			maxBytes: pipelineCfg.documentMaxContentBytes,
		});
		content = result.content;
		if (result.title && !title) title = result.title;
	} else {
		content = doc.raw_content ?? "";
	}

	if (content.length === 0) {
		accessor.withWriteTx((db) => {
			updateDocumentStatus(db, docId, "failed", "Empty content");
			failJob(db, job.id, "Empty content", job.attempts, job.max_attempts);
		});
		return;
	}

	// Update title if discovered
	if (title && title !== doc.title) {
		accessor.withWriteTx((db) => {
			db.prepare(
				"UPDATE documents SET title = ?, updated_at = ? WHERE id = ?",
			).run(title, new Date().toISOString(), docId);
		});
	}

	// -- Step 2: Chunk --
	accessor.withWriteTx((db) =>
		updateDocumentStatus(db, docId, "chunking"),
	);

	const chunks = chunkText(
		content,
		pipelineCfg.documentChunkSize,
		pipelineCfg.documentChunkOverlap,
	);

	accessor.withWriteTx((db) => {
		db.prepare(
			"UPDATE documents SET chunk_count = ?, updated_at = ? WHERE id = ?",
		).run(chunks.length, new Date().toISOString(), docId);
	});

	// -- Step 3: Embed + index each chunk --
	accessor.withWriteTx((db) =>
		updateDocumentStatus(db, docId, "embedding"),
	);

	let memoriesCreated = 0;

	for (let i = 0; i < chunks.length; i++) {
		const chunkText = chunks[i];
		if (!chunkText || chunkText.trim().length === 0) continue;

		// Embedding call is outside write lock
		const vector = await fetchEmbedding(chunkText, embeddingCfg);

		// Each chunk's memory creation in its own transaction
		accessor.withWriteTx((db) => {
			const normalized = normalizeAndHashContent(chunkText);

			// Dedup: skip if exact content already linked to this document
			const existingLink = db
				.prepare(
					`SELECT dm.memory_id FROM document_memories dm
					 JOIN memories m ON m.id = dm.memory_id
					 WHERE dm.document_id = ? AND m.content_hash = ?
					   AND m.is_deleted = 0
					 LIMIT 1`,
				)
				.get(docId, normalized.contentHash);
			if (existingLink) return;

			const memId = crypto.randomUUID();
			const now = new Date().toISOString();

			txIngestEnvelope(db, {
				id: memId,
				content: normalized.storageContent,
				normalizedContent: normalized.normalizedContent,
				contentHash: normalized.contentHash,
				who: docId,
				why: "document_ingest",
				project: null,
				importance: 0.3,
				type: "document_chunk",
				tags: title ? `document:${title}` : null,
				pinned: 0,
				isDeleted: 0,
				extractionStatus: "none",
				embeddingModel: vector ? embeddingCfg.model : null,
				extractionModel: null,
				updatedBy: "document-worker",
				sourceType: "document",
				sourceId: docId,
				createdAt: now,
			});

			// Link via document_memories
			db.prepare(
				`INSERT OR IGNORE INTO document_memories
				 (document_id, memory_id, chunk_index)
				 VALUES (?, ?, ?)`,
			).run(docId, memId, i);

			// Store embedding if we got one
			if (vector) {
				const embId = crypto.randomUUID();
				const blob = vectorToBlob(vector);
				db.prepare(
					`INSERT INTO embeddings
					 (id, content_hash, vector, dimensions, source_type,
					  source_id, chunk_text, created_at)
					 VALUES (?, ?, ?, ?, 'memory', ?, ?, ?)
					 ON CONFLICT(content_hash) DO UPDATE SET
					   vector = excluded.vector,
					   dimensions = excluded.dimensions`,
				).run(
					embId,
					normalized.contentHash,
					blob,
					vector.length,
					memId,
					chunkText,
					now,
				);
				syncVecInsert(db, embId, vector);
			}

			memoriesCreated++;
		});
	}

	// -- Step 4: Finalize --
	accessor.withWriteTx((db) => {
		updateDocumentStatus(db, docId, "indexing");
	});

	accessor.withWriteTx((db) => {
		completeDocument(db, docId, chunks.length, memoriesCreated);
		completeJob(db, job.id);
	});

	logger.info("document-worker", "Document processed", {
		documentId: docId,
		chunks: chunks.length,
		memories: memoriesCreated,
		title: title ?? "(untitled)",
	});
}

// ---------------------------------------------------------------------------
// Worker loop
// ---------------------------------------------------------------------------

export function startDocumentWorker(
	deps: DocumentWorkerDeps,
): DocumentWorkerHandle {
	let running = true;
	let timer: ReturnType<typeof setInterval> | null = null;

	async function tick(): Promise<void> {
		if (!running) return;

		const job = deps.accessor.withWriteTx((db) =>
			leaseDocumentJob(db, deps.pipelineCfg.workerMaxRetries),
		);

		if (!job) return;

		try {
			await processDocument(deps, job);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			logger.warn("document-worker", "Job failed", {
				jobId: job.id,
				documentId: job.document_id,
				error: msg,
			});

			deps.accessor.withWriteTx((db) => {
				failJob(db, job.id, msg, job.attempts, job.max_attempts);
				if (job.document_id) {
					updateDocumentStatus(db, job.document_id, "failed", msg);
				}
			});
		}
	}

	timer = setInterval(() => {
		if (!running) return;
		tick().catch((e) => {
			logger.warn("document-worker", "Tick error", {
				error: String(e),
			});
		});
	}, deps.pipelineCfg.documentWorkerIntervalMs);

	logger.info("document-worker", "Worker started", {
		intervalMs: deps.pipelineCfg.documentWorkerIntervalMs,
		chunkSize: deps.pipelineCfg.documentChunkSize,
	});

	return {
		async stop() {
			running = false;
			if (timer) clearInterval(timer);
			logger.info("document-worker", "Worker stopped");
		},
		get running() {
			return running;
		},
	};
}
