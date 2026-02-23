/**
 * @module export/types
 * @description Type definitions for portable agent export/import bundles.
 *
 * Export bundles are gzipped JSON files (.signet-bundle.json.gz) that contain
 * a self-verifying snapshot of an agent's memories, decisions, identity,
 * and cognitive profile. Each bundle includes a SHA-256 checksum and
 * Ed25519 (DID) signature for tamper detection.
 */

// ---------------------------------------------------------------------------
// Export Options
// ---------------------------------------------------------------------------

export interface ExportOptions {
	/** Output file path (default: auto-generated in cwd) */
	outputPath?: string;
	/** Export format: full, selective, or agent-card */
	format?: "full" | "selective" | "agent-card";
	/** Search query for selective export */
	query?: string;
	/** Include embeddings in the export */
	includeEmbeddings?: boolean;
	/** Include the cognitive profile */
	includeCognitiveProfile?: boolean;
	/** Include the agent card */
	includeAgentCard?: boolean;
}

// ---------------------------------------------------------------------------
// Export Bundle
// ---------------------------------------------------------------------------

export interface ExportBundleMetadata {
	/** Bundle format version */
	version: string;
	/** Export format used */
	format: "full" | "selective" | "agent-card";
	/** ISO-8601 export timestamp */
	exportedAt: string;
	/** Agent's DID (if configured) */
	did?: string;
	/** Agent's public key (base64) */
	publicKey?: string;
	/** Counts for each data type */
	counts: {
		memories: number;
		decisions: number;
		entities: number;
		relations: number;
	};
	/** SHA-256 checksum of the data payload (hex) */
	checksum: string;
	/** Ed25519 signature over the checksum (base64) */
	signature?: string;
}

export interface ExportBundleData {
	/** Exported memories */
	memories: ReadonlyArray<Record<string, unknown>>;
	/** Exported decisions */
	decisions: ReadonlyArray<Record<string, unknown>>;
	/** Exported entities */
	entities: ReadonlyArray<Record<string, unknown>>;
	/** Exported relations */
	relations: ReadonlyArray<Record<string, unknown>>;
	/** Cognitive profile data (optional) */
	cognitiveProfile?: Record<string, unknown>;
	/** Agent card data (optional) */
	agentCard?: Record<string, unknown>;
	/** DID identity (public key only) */
	identity?: {
		did: string;
		publicKey: string;
	};
	/** Merkle tree for verification */
	merkleRoot?: string;
	merkleLeafCount?: number;
}

export interface ExportBundle {
	/** Bundle metadata with checksum + signature */
	metadata: ExportBundleMetadata;
	/** Bundle data payload */
	data: ExportBundleData;
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

export type MergeStrategy = "replace" | "merge" | "skip-existing";

export interface ImportOptions {
	/** How to handle existing data */
	mergeStrategy?: MergeStrategy;
	/** Perform a dry run without writing */
	dryRun?: boolean;
	/** Skip signature verification */
	skipVerification?: boolean;
}

export interface ImportResult {
	/** Whether the import succeeded */
	success: boolean;
	/** Merge strategy used */
	mergeStrategy: MergeStrategy;
	/** Was this a dry run? */
	dryRun: boolean;
	/** Counts of imported items */
	imported: {
		memories: number;
		decisions: number;
		entities: number;
		relations: number;
	};
	/** Counts of skipped items (duplicates) */
	skipped: {
		memories: number;
		decisions: number;
		entities: number;
		relations: number;
	};
	/** Any warnings or errors encountered */
	warnings: string[];
	/** Bundle metadata from the imported bundle */
	bundleMetadata: ExportBundleMetadata;
}

// ---------------------------------------------------------------------------
// DB Interface
// ---------------------------------------------------------------------------

export interface ExportDb {
	prepare(sql: string): {
		run(...args: unknown[]): { changes: number; lastInsertRowid: number | bigint };
		get(...args: unknown[]): Record<string, unknown> | undefined;
		all(...args: unknown[]): Record<string, unknown>[];
	};
	exec(sql: string): void;
}
