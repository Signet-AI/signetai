import type { UnifiedSession } from "./unified"
import type { ProviderPrompts } from "./prompts"
import type { ConcurrencyConfig } from "./concurrency"

export interface ProviderConfig {
  apiKey: string
  baseUrl?: string
  [key: string]: unknown
}

export interface IngestOptions {
  containerTag: string
  metadata?: Record<string, unknown>
}

export interface SearchOptions {
  containerTag: string
  agentId?: string
  limit?: number
  threshold?: number
  questionDate?: string
}

export interface IngestResult {
  documentIds: string[]
  taskIds?: string[]
  /** Scoped transcript-capture ownership for providers that ingest multiple agent scopes. */
  taskAgentIds?: Record<string, string>
}

export interface IndexingProgress {
  completedIds: string[]
  failedIds: string[]
  total: number
}

/** Optional provider-owned barrier after the whole benchmark ingest phase. */
export interface FinalizeIngestOptions {
  runId: string
  dataSourceRunId: string
}

export type IndexingProgressCallback = (progress: IndexingProgress) => void

export interface Provider {
  name: string
  prompts?: ProviderPrompts
  concurrency?: ConcurrencyConfig
  initialize(config: ProviderConfig): Promise<void>
  ingest(sessions: UnifiedSession[], options: IngestOptions): Promise<IngestResult>
  /** Run a bounded provider-owned derivation only after all source sessions exist. */
  finalizeIngest?(options: FinalizeIngestOptions): Promise<void>
  awaitIndexing(
    result: IngestResult,
    containerTag: string,
    onProgress?: IndexingProgressCallback
  ): Promise<void>
  search(query: string, options: SearchOptions): Promise<unknown[]>
  clear(containerTag: string): Promise<void>
}

export type ProviderName =
  | "supermemory"
  | "mem0"
  | "zep"
  | "filesystem"
  | "rag"
  | "signet"
  | "signet-dreaming"
  | "signet-supermemory-parity"
