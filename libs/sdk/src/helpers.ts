import { requestSignal, sleep, type RequestControl } from "./transport.js";
import { applyRecallScoreThreshold, buildRecallRequestBody } from "@signet/core/recall";
import { SignetApiError, SignetNetworkError, SignetTimeoutError } from "./errors.js";
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
	return applyRecallScoreThreshold(result, minScore) as RecallResponse;
}

export class SignetClientHelpers {
	protected readonly transport: SignetTransport;

	constructor(transport: SignetTransport) {
		this.transport = transport;
	}
	async waitForJob(jobId: string, opts?: WaitForJobOptions, control?: RequestControl): Promise<JobStatus> {
		return poll(
			(request) => this.transport.get<JobStatus>(`/api/memory/jobs/${jobId}`, undefined, request),
			(job) => isTerminalJobStatus(job.status),
			`Job ${jobId}`,
			opts,
			control,
		);
	}
	async waitForDocument(
		documentId: string,
		opts?: WaitForJobOptions,
		control?: RequestControl,
	): Promise<DocumentRecord> {
		return poll(
			(request) => this.transport.get<DocumentRecord>(`/api/documents/${documentId}`, undefined, request),
			(doc) => isTerminalDocumentStatus(doc.status),
			`Document ${documentId}`,
			opts,
			control,
		);
	}
	async createAndIngestDocument(
		opts: {
			readonly source_type: "text" | "url" | "file";
			readonly content?: string;
			readonly url?: string;
			readonly title?: string;
			readonly content_type?: string;
			readonly connector_id?: string;
			readonly metadata?: Record<string, unknown>;
		},
		control?: RequestControl,
	): Promise<DocumentRecord> {
		const scope = requestSignal(control ?? {}, 30_000);
		const request = { ...control, signal: scope.signal, deadline: Date.now() + scope.timeoutMs };
		try {
			const result = await this.transport.post<{ id: string; jobId?: string }>("/api/documents", opts, request);
			if (result.jobId) await this.waitForJob(result.jobId, undefined, request);
			return await this.waitForDocument(result.id, undefined, request);
		} finally {
			scope.cleanup();
		}
	}
	async recallOrThrow(query: string, opts?: SdkRecallOptions, control?: RequestControl): Promise<RecallResponse> {
		const { minScore, ...requestOptions } = opts ?? {};
		const result = applyRecallMinScore(
			await this.transport.post<RecallResponse>(
				"/api/memory/recall",
				buildRecallRequestBody(query, { ...requestOptions, minScore }),
				control,
			),
			minScore,
		);

		if (!result.results || result.results.length === 0) {
			throw new Error(`No memories found for query: "${query}"`);
		}

		return result;
	}
	async getMemoryOrThrow(id: string, control?: RequestControl): Promise<MemoryRecord> {
		try {
			return await this.transport.get<MemoryRecord>(`/api/memory/${id}`, undefined, control);
		} catch (error) {
			if (error instanceof SignetApiError && error.status === 404) {
				throw new Error(`Memory not found: ${id}`);
			}
			throw error;
		}
	}
	async getDocumentOrThrow(id: string, control?: RequestControl): Promise<DocumentRecord> {
		try {
			return await this.transport.get<DocumentRecord>(`/api/documents/${id}`, undefined, control);
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
		control?: RequestControl,
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
		}>(
			"/api/memory/modify",
			{
				patches: mapped,
				...opts,
			},
			control,
		);
		onProgress?.({ done: patches.length, total: patches.length });

		return response;
	}
}

async function poll<T>(
	read: (control: RequestControl) => Promise<T>,
	terminal: (value: T) => boolean,
	label: string,
	opts?: WaitForJobOptions,
	control: RequestControl = {},
): Promise<T> {
	const timeout = opts?.timeout ?? 30_000;
	const scope = requestSignal({ ...control, timeoutMs: Math.min(timeout, control.timeoutMs ?? timeout) }, timeout);
	const deadline = Date.now() + scope.timeoutMs;
	try {
		for (;;) {
			const value = await read({ ...control, signal: scope.signal, deadline });
			if (terminal(value)) return value;
			await sleep(opts?.interval ?? 500, scope.signal);
		}
	} catch (error) {
		if (scope.signal.aborted && !control.signal?.aborted) {
			if (control.deadline !== undefined || control.timeoutMs !== undefined)
				throw new SignetTimeoutError(scope.timeoutMs);
			throw new Error(`${label} did not complete within ${timeout}ms`);
		}
		if (scope.signal.aborted) throw new SignetNetworkError("Request cancelled", new Error("cancelled"));
		throw error;
	} finally {
		scope.cleanup();
	}
}

function isTerminalJobStatus(status: JobStatus["status"]): boolean {
	return status === "completed" || status === "failed" || status === "done" || status === "dead";
}

function isTerminalDocumentStatus(status: string): boolean {
	return status === "done" || status === "failed" || status === "deleted" || status === "ready";
}
