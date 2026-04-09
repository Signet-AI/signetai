/**
 * Manual helper methods for SignetClient
 *
 * These provide conveniences beyond the auto-generated API coverage:
 * - Polling utilities
 * - Composite operations
 * - Progress callbacks
 * - Error shortcuts
 */

import { SignetApiError } from "./errors.js";
import type { SignetTransport } from "./transport.js";
import type { DocumentRecord, JobStatus, MemoryRecord, RecallResponse } from "./types.js";

export interface WaitForJobOptions {
	/** Maximum time to wait in milliseconds (default: 30_000) */
	readonly timeout?: number;
	/** Polling interval in milliseconds (default: 500) */
	readonly interval?: number;
}

export interface BatchModifyProgress {
	/** Number of patches completed */
	readonly done: number;
	/** Total patches to process */
	readonly total: number;
}

export function applyRecallMinScore(result: RecallResponse, minScore?: number): RecallResponse {
	if (typeof minScore !== "number") {
		return result;
	}

	const filtered = result.results.filter((row) => row.score >= minScore);
	return {
		...result,
		results: filtered,
		meta: {
			totalReturned: filtered.length,
			hasSupplementary: filtered.some((row) => row.supplementary === true),
			noHits: filtered.length === 0,
		},
	};
}

export class SignetClientHelpers {
	protected readonly transport: SignetTransport;

	constructor(transport: SignetTransport) {
		this.transport = transport;
	}

	/**
	 * Poll a job until it completes, fails, or times out.
	 *
	 * @example
	 * ```typescript
	 * const job = await client.createDocument({ source_type: "url", url: "https://..." });
	 * const result = await client.waitForJob(job.jobId, { timeout: 60_000 });
	 * console.log(result.status); // "completed" | "failed" | "done" | "dead"
	 * ```
	 */
	async waitForJob(jobId: string, opts?: WaitForJobOptions): Promise<JobStatus> {
		const timeout = opts?.timeout ?? 30_000;
		const interval = opts?.interval ?? 500;
		const startTime = Date.now();

		while (Date.now() - startTime < timeout) {
			const job = await this.transport.get<JobStatus>(`/api/memory/jobs/${jobId}`);

			if (isTerminalJobStatus(job.status)) {
				return job;
			}

			await new Promise((resolve) => setTimeout(resolve, interval));
		}

		throw new Error(`Job ${jobId} did not complete within ${timeout}ms`);
	}

	/**
	 * Poll a document until ingestion reaches a terminal state.
	 */
	async waitForDocument(documentId: string, opts?: WaitForJobOptions): Promise<DocumentRecord> {
		const timeout = opts?.timeout ?? 30_000;
		const interval = opts?.interval ?? 500;
		const startTime = Date.now();

		while (Date.now() - startTime < timeout) {
			const doc = await this.transport.get<DocumentRecord>(`/api/documents/${documentId}`);
			if (isTerminalDocumentStatus(doc.status)) {
				return doc;
			}
			await new Promise((resolve) => setTimeout(resolve, interval));
		}

		throw new Error(`Document ${documentId} did not complete within ${timeout}ms`);
	}

	/**
	 * Create a document and wait for ingestion to complete.
	 *
	 * @example
	 * ```typescript
	 * const doc = await client.createAndIngestDocument({
	 *   source_type: "url",
	 *   url: "https://example.com/article",
	 *   title: "Example Article"
	 * });
	 * console.log(doc.status); // "done"
	 * ```
	 */
	async createAndIngestDocument(opts: {
		readonly source_type: "text" | "url" | "file";
		readonly content?: string;
		readonly url?: string;
		readonly title?: string;
		readonly content_type?: string;
		readonly connector_id?: string;
		readonly metadata?: Record<string, unknown>;
	}): Promise<DocumentRecord> {
		const result = await this.transport.post<{ id: string; jobId?: string }>("/api/documents", opts);

		// If the daemon returns a job id (legacy/optional), wait for it first.
		if (result.jobId) {
			await this.waitForJob(result.jobId);
		}

		// Poll document status until ingest reaches a terminal state.
		return this.waitForDocument(result.id);
	}

	/**
	 * Recall memories and throw if no results found.
	 *
	 * @example
	 * ```typescript
	 * // Throws if no preferences found
	 * const memories = await client.recallOrThrow("user preferences", {
	 *   type: "preference",
	 *   limit: 5
	 * });
	 * ```
	 */
	async recallOrThrow(
		query: string,
		opts?: {
			readonly keywordQuery?: string;
			readonly limit?: number;
			readonly project?: string;
			readonly type?: string;
			readonly tags?: string;
			readonly who?: string;
			readonly pinned?: boolean;
			readonly importance_min?: number;
			readonly since?: string;
			readonly until?: string;
			readonly expand?: boolean;
			readonly minScore?: number;
			readonly agentId?: string;
		},
	): Promise<RecallResponse> {
		const result = applyRecallMinScore(
			await this.transport.post<RecallResponse>("/api/memory/recall", {
				query,
				...opts,
			}),
			opts?.minScore,
		);

		if (!result.results || result.results.length === 0) {
			throw new Error(`No memories found for query: "${query}"`);
		}

		return result;
	}

	/**
	 * Get a memory by ID and throw if not found.
	 *
	 * @example
	 * ```typescript
	 * const memory = await client.getMemoryOrThrow("mem-abc-123");
	 * ```
	 */
	async getMemoryOrThrow(id: string): Promise<MemoryRecord> {
		try {
			return await this.transport.get<MemoryRecord>(`/api/memory/${id}`);
		} catch (error) {
			if (error instanceof SignetApiError && error.status === 404) {
				throw new Error(`Memory not found: ${id}`);
			}
			throw error;
		}
	}

	/**
	 * Get a document by ID and throw if not found.
	 *
	 * @example
	 * ```typescript
	 * const doc = await client.getDocumentOrThrow("doc-456");
	 * ```
	 */
	async getDocumentOrThrow(id: string): Promise<DocumentRecord> {
		try {
			return await this.transport.get<DocumentRecord>(`/api/documents/${id}`);
		} catch (error) {
			if (error instanceof SignetApiError && error.status === 404) {
				throw new Error(`Document not found: ${id}`);
			}
			throw error;
		}
	}

	/**
	 * Batch modify memories with progress callback.
	 *
	 * @example
	 * ```typescript
	 * await client.batchModifyWithProgress(
	 *   [
	 *     { id: "m1", reason: "fix", content: "updated" },
	 *     { id: "m2", reason: "fix", content: "updated" },
	 *   ],
	 *   (done, total) => console.log(`${done}/${total} complete`)
	 * );
	 * ```
	 */
	async batchModifyWithProgress(
		patches: readonly {
			readonly id: string;
			readonly content?: string;
			readonly type?: string;
			readonly importance?: number;
			readonly tags?: string;
			readonly pinned?: boolean;
			readonly project?: string;
			readonly reason: string;
			readonly ifVersion?: number;
		}[],
		onProgress?: (progress: BatchModifyProgress) => void,
		opts?: {
			readonly reason?: string;
			readonly changed_by?: string;
		},
	): Promise<{ success: number; failed: number; results: unknown[] }> {
		// Notify start
		onProgress?.({ done: 0, total: patches.length });

		// Send batch request
		const mapped = patches.map(({ ifVersion, ...rest }) => ({
			...rest,
			if_version: ifVersion,
		}));

		const response = await this.transport.post<{
			success: number;
			failed: number;
			results: unknown[];
		}>("/api/memory/modify", {
			patches: mapped,
			...opts,
		});

		// Notify completion
		onProgress?.({ done: patches.length, total: patches.length });

		return response;
	}
}

function isTerminalJobStatus(status: JobStatus["status"]): boolean {
	return status === "completed" || status === "failed" || status === "done" || status === "dead";
}

function isTerminalDocumentStatus(status: string): boolean {
	return status === "done" || status === "failed" || status === "deleted" || status === "ready";
}
