/**
 * @module export/selective
 * @description Selective export — export only memories matching a search query.
 *
 * Uses SQL LIKE matching against memory content and tags to filter
 * which memories are included in the export bundle. Useful for
 * sharing specific knowledge domains without exposing the full memory store.
 */

import { createHash } from "node:crypto";
import { writeFileSync, mkdirSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { dirname, join } from "node:path";
import {
	signContent,
	getPublicKeyBase64,
	hasSigningKeypair,
} from "../crypto";
import { getConfiguredDid } from "../did-setup";
import type {
	ExportBundle,
	ExportBundleData,
	ExportBundleMetadata,
	ExportDb,
	ExportOptions,
} from "./types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BUNDLE_VERSION = "1.0.0";
const BUNDLE_EXTENSION = ".signet-bundle.json.gz";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Export memories matching a search query into a portable bundle.
 *
 * Filters memories by content or tags matching the query string using
 * SQL LIKE patterns. Also includes related entities and relations.
 *
 * @param db - Database instance
 * @param query - Search query to filter memories
 * @param options - Export configuration
 * @returns Path to the created bundle file and metadata
 */
export async function exportSelective(
	db: ExportDb,
	query: string,
	options: ExportOptions = {},
): Promise<{ filePath: string; metadata: ExportBundleMetadata }> {
	if (!query || query.trim().length === 0) {
		throw new Error("Search query is required for selective export");
	}

	const escaped = query.replace(/[%_\\]/g, (c) => `\\${c}`);
	const likePattern = `%${escaped}%`;

	// Find matching memories
	const memories = db
		.prepare(
			`SELECT id, content, type, category, confidence, source_type,
			        tags, importance, pinned, who, content_hash, signature,
			        signer_did, created_at, updated_at
			 FROM memories
			 WHERE is_deleted = 0
			   AND (content LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\' OR type LIKE ? ESCAPE '\\' OR category LIKE ? ESCAPE '\\')
			 ORDER BY created_at ASC`,
		)
		.all(likePattern, likePattern, likePattern, likePattern);

	// Find entities related to these memories
	const memoryIds = memories.map((m) => m.id as string);
	let entities: Record<string, unknown>[] = [];
	let relations: Record<string, unknown>[] = [];

	if (memoryIds.length > 0) {
		try {
			// Find entity mentions for these memories
			const placeholders = memoryIds.map(() => "?").join(", ");
			const entityIds = db
				.prepare(
					`SELECT DISTINCT entity_id FROM memory_entity_mentions
					 WHERE memory_id IN (${placeholders})`,
				)
				.all(...memoryIds)
				.map((r) => r.entity_id as string);

			if (entityIds.length > 0) {
				const entPlaceholders = entityIds.map(() => "?").join(", ");
				entities = db
					.prepare(
						`SELECT id, name, canonical_name, entity_type, description,
						        mentions, created_at, updated_at
						 FROM entities WHERE id IN (${entPlaceholders})`,
					)
					.all(...entityIds);

				relations = db
					.prepare(
						`SELECT id, source_entity_id, target_entity_id, relation_type,
						        strength, mentions, confidence, metadata, created_at
						 FROM relations
						 WHERE source_entity_id IN (${entPlaceholders})
						    OR target_entity_id IN (${entPlaceholders})`,
					)
					.all(...entityIds, ...entityIds);
			}
		} catch {
			// Tables may not exist
		}
	}

	const data: ExportBundleData = {
		memories,
		decisions: [],
		entities,
		relations,
	};

	// Compute checksum
	const dataJson = JSON.stringify(data);
	const checksum = createHash("sha256").update(dataJson).digest("hex");

	// Sign
	let signature: string | undefined;
	let publicKey: string | undefined;
	let did: string | undefined;

	if (hasSigningKeypair()) {
		try {
			signature = await signContent(checksum);
			publicKey = await getPublicKeyBase64();
			did = getConfiguredDid() ?? undefined;
		} catch {
			// Non-fatal
		}
	}

	const metadata: ExportBundleMetadata = {
		version: BUNDLE_VERSION,
		format: "selective",
		exportedAt: new Date().toISOString(),
		did,
		publicKey,
		counts: {
			memories: memories.length,
			decisions: 0,
			entities: entities.length,
			relations: relations.length,
		},
		checksum,
		signature,
	};

	const bundle: ExportBundle = { metadata, data };
	const bundleJson = JSON.stringify(bundle);
	const compressed = gzipSync(Buffer.from(bundleJson, "utf-8"), { level: 9 });

	const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
	const safeQuery = query.replace(/[^a-zA-Z0-9-_]/g, "").slice(0, 30);
	const defaultFilename = `signet-selective-${safeQuery}-${timestamp}${BUNDLE_EXTENSION}`;
	const filePath = options.outputPath ?? join(process.cwd(), defaultFilename);

	mkdirSync(dirname(filePath), { recursive: true });
	writeFileSync(filePath, compressed);

	// Record in export_bundles table
	try {
		const bundleId = `export_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
		db.prepare(
			`INSERT INTO export_bundles
			 (id, format, memory_count, file_path, checksum, signature, exported_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		).run(bundleId, "selective", memories.length, filePath, checksum, signature ?? null, metadata.exportedAt);
	} catch {
		// Non-fatal
	}

	return { filePath, metadata };
}
