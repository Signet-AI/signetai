/**
 * Manual helper methods for SignetClient
 *
 * These provide conveniences beyond the auto-generated API coverage:
 * - Polling utilities
 * - Composite operations
 * - Progress callbacks
 * - Error shortcuts
 */

import { applyNativeRecallScoreThreshold, buildNativeRecallRequestBody } from "./native-contract.js";
import { SignetApiError } from "./errors.js";
import type { SignetTransport } from "./transport.js";
import type { DocumentRecord, JobStatus, MemoryRecord, RecallResponse, SdkRecallOptions } from "./types.js";

export interface WaitForJobOptions {
	readonly timeout?: number;
	readonly interval?: number;
}

export interface BatchModifyProgress {
	readonly done: number;
	readonly total: number;
}

export function applyRecallMinScore(result: RecallResponse, minScore?: number): RecallResponse {
	return applyNativeRecallScoreThreshold(result, minScore);
}

export class SignetClientHelpers {
	protected readonly transport: SignetTransport;

	constructor(transport: SignetTransport) {
		this.transport = transport;
	}
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
		if (result.jobId) {
			await this.waitForJob(result.jobId);
		}
		return this.waitForDocument(result.id);
	}
	async recallOrThrow(query: string, opts?: SdkRecallOptions): Promise<RecallResponse> {
		const { minScore, ...requestOptions } = opts ?? {};
		const result = applyRecallMinScore(
			await this.transport.post<RecallResponse>(
				"/api/memory/recall",
				buildNativeRecallRequestBody(query, { ...requestOptions, minScore }),
			),
			minScore,
		);

		if (!result.results || result.results.length === 0) {
			throw new Error(`No memories found for query: "${query}"`);
		}

		return result;
	}
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
		onProgress?.({ done: 0, total: patches.length });
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
