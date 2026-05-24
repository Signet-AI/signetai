export const SOURCE_CHUNK_SOURCE_TYPE = "source_chunk";
export const LEGACY_OBSIDIAN_CHUNK_SOURCE_TYPE = "source_obsidian_chunk";

export type SourceProviderKind = "obsidian" | (string & {});
export type SourceRecordKind = "artifact" | "container" | "relation" | "checkpoint" | "failure";
export type SourceSyncStatus = "complete" | "partial" | "failed" | "canceled";

export interface SourceArtifactRecord {
	readonly sourceId: string;
	readonly providerKind: SourceProviderKind;
	readonly externalId: string;
	readonly path: string;
	readonly parentPath?: string;
	readonly title?: string;
	readonly content: string;
	readonly contentType: string;
	readonly capturedAt: string;
	readonly updatedAt?: string;
	readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface SourceContainerRecord {
	readonly sourceId: string;
	readonly providerKind: SourceProviderKind;
	readonly externalId: string;
	readonly path: string;
	readonly parentPath?: string;
	readonly title: string;
	readonly containerType: string;
	readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface SourceRelationRecord {
	readonly sourceId: string;
	readonly providerKind: SourceProviderKind;
	readonly fromExternalId: string;
	readonly toExternalId: string;
	readonly relationType: string;
	readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface SourceCheckpointRecord {
	readonly sourceId: string;
	readonly providerKind: SourceProviderKind;
	readonly checkpointKey: string;
	readonly cursor: string;
	readonly updatedAt: string;
	readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface SourceFailureState {
	readonly sourceId: string;
	readonly providerKind: SourceProviderKind;
	readonly failedAt: string;
	readonly recoverable: boolean;
	readonly message: string;
	readonly externalId?: string;
	readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface SourceSyncResult {
	readonly sourceId: string;
	readonly providerKind: SourceProviderKind;
	readonly status: SourceSyncStatus;
	readonly scanned: number;
	readonly indexed: number;
	readonly skipped: number;
	readonly failures: readonly SourceFailureState[];
}
