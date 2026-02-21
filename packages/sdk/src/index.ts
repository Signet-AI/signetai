/**
 * @signet/sdk — HTTP client for the Signet daemon API.
 * No native dependencies (no SQLite, no @signet/core).
 */

import { SignetTransport } from "./transport.js";
import type {
  BatchModifyItemResult,
  BatchModifyResponse,
  DeleteResult,
  DocumentChunksResponse,
  DocumentCreateResult,
  DocumentDeleteResult,
  DocumentListResponse,
  DocumentRecord,
  ForgetResponse,
  HealthResponse,
  HistoryResponse,
  JobStatus,
  MemoryListResponse,
  MemoryRecord,
  ModifyResult,
  RecallResponse,
  RecoverResult,
  RememberResult,
  StatusResponse,
} from "./types.js";

export interface SignetClientConfig {
  readonly daemonUrl?: string;
  readonly timeoutMs?: number;
  readonly retries?: number;
  readonly actor?: string;
  readonly actorType?: string;
}

export class SignetClient {
  private readonly transport: SignetTransport;

  constructor(config?: SignetClientConfig) {
    const headers: Record<string, string> = {};
    if (config?.actor) {
      headers["x-signet-actor"] = config.actor;
    }
    if (config?.actorType) {
      headers["x-signet-actor-type"] = config.actorType;
    }

    this.transport = new SignetTransport({
      baseUrl: config?.daemonUrl ?? "http://localhost:3850",
      timeoutMs: config?.timeoutMs ?? 10_000,
      retries: config?.retries ?? 2,
      headers: Object.keys(headers).length > 0 ? headers : undefined,
    });
  }

  // --- Memory lifecycle ---

  async remember(
    content: string,
    opts?: {
      readonly type?: string;
      readonly importance?: number;
      readonly tags?: string;
      readonly who?: string;
      readonly pinned?: boolean;
      readonly sourceType?: string;
      readonly sourceId?: string;
      readonly mode?: "auto" | "sync" | "async";
      readonly idempotencyKey?: string;
      readonly runtimePath?: string;
    },
  ): Promise<RememberResult> {
    return this.transport.post<RememberResult>("/api/memory/remember", {
      content,
      ...opts,
    });
  }

  async recall(
    query: string,
    opts?: {
      readonly limit?: number;
      readonly type?: string;
      readonly tags?: string;
      readonly who?: string;
      readonly pinned?: boolean;
      readonly importance_min?: number;
      readonly since?: string;
      readonly minScore?: number;
    },
  ): Promise<RecallResponse> {
    return this.transport.post<RecallResponse>("/api/memory/recall", {
      query,
      ...opts,
    });
  }

  async getMemory(id: string): Promise<MemoryRecord> {
    return this.transport.get<MemoryRecord>(`/api/memory/${id}`);
  }

  async listMemories(opts?: {
    readonly limit?: number;
    readonly offset?: number;
    readonly type?: string;
  }): Promise<MemoryListResponse> {
    return this.transport.get<MemoryListResponse>("/api/memories", {
      limit: opts?.limit,
      offset: opts?.offset,
      type: opts?.type,
    });
  }

  async modifyMemory(
    id: string,
    patch: {
      readonly content?: string;
      readonly type?: string;
      readonly importance?: number;
      readonly tags?: string;
      readonly pinned?: boolean;
      readonly project?: string;
      readonly reason: string;
      readonly ifVersion?: number;
    },
  ): Promise<ModifyResult> {
    const { ifVersion, ...rest } = patch;
    return this.transport.patch<ModifyResult>(`/api/memory/${id}`, {
      ...rest,
      if_version: ifVersion,
    });
  }

  async forgetMemory(
    id: string,
    opts: {
      readonly reason: string;
      readonly force?: boolean;
      readonly ifVersion?: number;
    },
  ): Promise<DeleteResult> {
    return this.transport.del<DeleteResult>(`/api/memory/${id}`, {
      reason: opts.reason,
      force: opts.force,
      if_version: opts.ifVersion,
    });
  }

  async batchForget(opts: {
    readonly mode: "preview" | "execute";
    readonly query?: string;
    readonly ids?: readonly string[];
    readonly type?: string;
    readonly tags?: string;
    readonly who?: string;
    readonly source_type?: string;
    readonly since?: string;
    readonly until?: string;
    readonly limit?: number;
    readonly reason?: string;
    readonly force?: boolean;
    readonly confirm_token?: string;
  }): Promise<ForgetResponse> {
    return this.transport.post<ForgetResponse>("/api/memory/forget", opts);
  }

  async batchModify(
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
    opts?: {
      readonly reason?: string;
      readonly changed_by?: string;
    },
  ): Promise<BatchModifyResponse> {
    const mapped = patches.map(({ ifVersion, ...rest }) => ({
      ...rest,
      if_version: ifVersion,
    }));
    return this.transport.post<BatchModifyResponse>("/api/memory/modify", {
      patches: mapped,
      ...opts,
    });
  }

  async getHistory(
    memoryId: string,
    opts?: { readonly limit?: number },
  ): Promise<HistoryResponse> {
    return this.transport.get<HistoryResponse>(
      `/api/memory/${memoryId}/history`,
      { limit: opts?.limit },
    );
  }

  async recoverMemory(
    id: string,
    opts?: {
      readonly reason?: string;
      readonly ifVersion?: number;
    },
  ): Promise<RecoverResult> {
    return this.transport.post<RecoverResult>(`/api/memory/${id}/recover`, {
      reason: opts?.reason,
      if_version: opts?.ifVersion,
    });
  }

  // --- Jobs ---

  async getJob(jobId: string): Promise<JobStatus> {
    return this.transport.get<JobStatus>(`/api/memory/jobs/${jobId}`);
  }

  // --- Documents ---

  async createDocument(opts: {
    readonly source_type: "text" | "url" | "file";
    readonly content?: string;
    readonly url?: string;
    readonly title?: string;
    readonly content_type?: string;
    readonly connector_id?: string;
    readonly metadata?: Record<string, unknown>;
  }): Promise<DocumentCreateResult> {
    return this.transport.post<DocumentCreateResult>("/api/documents", opts);
  }

  async getDocument(id: string): Promise<DocumentRecord> {
    return this.transport.get<DocumentRecord>(`/api/documents/${id}`);
  }

  async listDocuments(opts?: {
    readonly status?: string;
    readonly limit?: number;
    readonly offset?: number;
  }): Promise<DocumentListResponse> {
    return this.transport.get<DocumentListResponse>("/api/documents", {
      status: opts?.status,
      limit: opts?.limit,
      offset: opts?.offset,
    });
  }

  async getDocumentChunks(id: string): Promise<DocumentChunksResponse> {
    return this.transport.get<DocumentChunksResponse>(
      `/api/documents/${id}/chunks`,
    );
  }

  async deleteDocument(
    id: string,
    reason: string,
  ): Promise<DocumentDeleteResult> {
    return this.transport.del<DocumentDeleteResult>(
      `/api/documents/${id}`,
      { reason },
    );
  }

  // --- Health / status ---

  async health(): Promise<HealthResponse> {
    return this.transport.get<HealthResponse>("/health");
  }

  async status(): Promise<StatusResponse> {
    return this.transport.get<StatusResponse>("/api/status");
  }

  async diagnostics(domain?: string): Promise<unknown> {
    const path = domain
      ? `/api/diagnostics/${domain}`
      : "/api/diagnostics";
    return this.transport.get<unknown>(path);
  }
}

/** @deprecated Use SignetClient instead */
export const SignetSDK = SignetClient;

/** @deprecated Use SignetClient instead */
export const Signet = SignetClient;

// Re-export everything consumers need
export type { SignetTransport } from "./transport.js";
export {
  SignetApiError,
  SignetError,
  SignetNetworkError,
  SignetTimeoutError,
} from "./errors.js";
export type {
  BatchModifyItemResult,
  BatchModifyResponse,
  DeleteResult,
  DocumentChunksResponse,
  DocumentCreateResult,
  DocumentDeleteResult,
  DocumentListResponse,
  DocumentRecord,
  ForgetExecuteResponse,
  ForgetPreviewResponse,
  ForgetResponse,
  HealthResponse,
  HistoryEvent,
  HistoryResponse,
  JobStatus,
  MemoryListResponse,
  MemoryRecord,
  ModifyResult,
  RecallResponse,
  RecallResult,
  RecoverResult,
  RememberResult,
  StatusResponse,
} from "./types.js";
