/**
 * Connector runtime contract for document ingestion sources.
 *
 * Connectors bridge external data sources (filesystem, GitHub, Google
 * Drive, etc.) into the Signet document ingest pipeline.
 */

export const CONNECTOR_PROVIDERS = [
	"filesystem",
	"github-docs",
	"gdrive",
] as const;
export type ConnectorProvider = (typeof CONNECTOR_PROVIDERS)[number];

export const CONNECTOR_STATUSES = [
	"idle",
	"syncing",
	"error",
] as const;
export type ConnectorStatus = (typeof CONNECTOR_STATUSES)[number];

export const DOCUMENT_STATUSES = [
	"queued",
	"extracting",
	"chunking",
	"embedding",
	"indexing",
	"done",
	"failed",
	"deleted",
] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

export const DOCUMENT_SOURCE_TYPES = [
	"text",
	"url",
	"file",
] as const;
export type DocumentSourceType = (typeof DOCUMENT_SOURCE_TYPES)[number];

export interface ConnectorConfig {
	readonly id: string;
	readonly provider: ConnectorProvider;
	readonly displayName: string;
	readonly credentials?: Readonly<Record<string, string>>;
	readonly settings: Readonly<Record<string, unknown>>;
	readonly enabled: boolean;
}

export interface SyncCursor {
	readonly lastSyncAt: string;
	readonly checkpoint?: string;
	readonly version?: number;
}

export interface SyncResult {
	readonly documentsAdded: number;
	readonly documentsUpdated: number;
	readonly documentsRemoved: number;
	readonly errors: readonly SyncError[];
	readonly cursor: SyncCursor;
}

export interface SyncError {
	readonly resourceId: string;
	readonly message: string;
	readonly retryable: boolean;
}

export interface ConnectorResource {
	readonly id: string;
	readonly name: string;
	readonly updatedAt: string;
}

export interface ConnectorRuntime {
	readonly id: string;
	readonly provider: ConnectorProvider;

	authorize(): Promise<{ readonly ok: boolean; readonly error?: string }>;

	listResources(cursor?: string): Promise<{
		readonly resources: readonly ConnectorResource[];
		readonly nextCursor?: string;
	}>;

	syncIncremental(cursor: SyncCursor): Promise<SyncResult>;
	syncFull(): Promise<SyncResult>;
	replay(resourceId: string): Promise<SyncResult>;
}

export interface DocumentRow {
	readonly id: string;
	readonly source_url: string | null;
	readonly source_type: DocumentSourceType;
	readonly content_type: string | null;
	readonly content_hash: string | null;
	readonly title: string | null;
	readonly raw_content: string | null;
	readonly status: DocumentStatus;
	readonly error: string | null;
	readonly connector_id: string | null;
	readonly chunk_count: number;
	readonly memory_count: number;
	readonly metadata_json: string | null;
	readonly created_at: string;
	readonly updated_at: string;
	readonly completed_at: string | null;
}

export interface ConnectorRow {
	readonly id: string;
	readonly provider: ConnectorProvider;
	readonly display_name: string | null;
	readonly config_json: string;
	readonly cursor_json: string | null;
	readonly status: ConnectorStatus;
	readonly last_sync_at: string | null;
	readonly last_error: string | null;
	readonly created_at: string;
	readonly updated_at: string;
}
