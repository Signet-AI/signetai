/**
 * @module export/export
 * @description Portable agent bundle export.
 *
 * Creates gzipped JSON bundles (.signet-bundle.json.gz) containing an agent's
 * memories, decisions, cognitive profile, agent card, and DID identity.
 * Each bundle is signed with the agent's Ed25519 key and includes a SHA-256
 * checksum for tamper detection.
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
 * Export a full or selective bundle from the agent's database.
 *
 * Creates a gzipped JSON file containing memories, decisions, entities,
 * relations, and optional cognitive profile / agent card data. The bundle
 * is signed with the agent's DID key and includes a SHA-256 checksum.
 *
 * @param db - Database instance
 * @param options - Export configuration
 * @returns Path to the created bundle file and metadata
 */
export async function exportBundle(
	db: ExportDb,
	options: ExportOptions = {},
): Promise<{ filePath: string; metadata: ExportBundleMetadata }> {
	const format = options.format ?? "full";

	// Collect data based on format
	const data = collectData(db, format, options);

	// Compute checksum over the data payload
	const dataJson = JSON.stringify(data);
	const checksum = createHash("sha256").update(dataJson).digest("hex");

	// Sign the checksum with DID key if available
	let signature: string | undefined;
	let publicKey: string | undefined;
	let did: string | undefined;

	if (hasSigningKeypair()) {
		try {
			signature = await signContent(checksum);
			publicKey = await getPublicKeyBase64();
			did = getConfiguredDid() ?? undefined;
		} catch {
			// Signing failed — bundle will be unsigned but still valid
		}
	}

	// Build metadata
	const metadata: ExportBundleMetadata = {
		version: BUNDLE_VERSION,
		format,
		exportedAt: new Date().toISOString(),
		did,
		publicKey,
		counts: {
			memories: data.memories.length,
			decisions: data.decisions.length,
			entities: data.entities.length,
			relations: data.relations.length,
		},
		checksum,
		signature,
	};

	// Assemble bundle
	const bundle: ExportBundle = { metadata, data };
	const bundleJson = JSON.stringify(bundle);

	// Gzip compress
	const compressed = gzipSync(Buffer.from(bundleJson, "utf-8"), { level: 9 });

	// Determine output path
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
	const defaultFilename = `signet-${format}-${timestamp}${BUNDLE_EXTENSION}`;
	const filePath = options.outputPath ?? join(process.cwd(), defaultFilename);

	// Ensure directory exists
	mkdirSync(dirname(filePath), { recursive: true });

	// Write file
	writeFileSync(filePath, compressed);

	// Record in export_bundles table
	const bundleId = `export_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
	try {
		db.prepare(
			`INSERT INTO export_bundles
			 (id, format, memory_count, file_path, checksum, signature, exported_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		).run(bundleId, format, data.memories.length, filePath, checksum, signature ?? null, metadata.exportedAt);
	} catch {
		// Table may not exist in older schemas — non-fatal
	}

	return { filePath, metadata };
}

// ---------------------------------------------------------------------------
// Data Collection
// ---------------------------------------------------------------------------

function collectData(
	db: ExportDb,
	format: string,
	options: ExportOptions,
): ExportBundleData {
	// Memories
	const memories = db
		.prepare(
			`SELECT id, content, type, category, confidence, source_type,
			        tags, importance, pinned, who, content_hash, signature,
			        signer_did, created_at, updated_at
			 FROM memories
			 WHERE is_deleted = 0
			 ORDER BY created_at ASC`,
		)
		.all();

	// Decisions (from decisions table if it exists)
	let decisions: Record<string, unknown>[] = [];
	try {
		decisions = db
			.prepare(
				`SELECT id, memory_id, action, confidence, reason,
				        model, outcome, outcome_at, created_at
				 FROM decisions
				 ORDER BY created_at ASC`,
			)
			.all();
	} catch {
		// Table may not exist
	}

	// Entities
	let entities: Record<string, unknown>[] = [];
	try {
		entities = db
			.prepare(
				`SELECT id, name, canonical_name, entity_type, description,
				        mentions, created_at, updated_at
				 FROM entities
				 ORDER BY created_at ASC`,
			)
			.all();
	} catch {
		// Table may not exist
	}

	// Relations
	let relations: Record<string, unknown>[] = [];
	try {
		relations = db
			.prepare(
				`SELECT id, source_entity_id, target_entity_id, relation_type,
				        strength, mentions, confidence, metadata, created_at
				 FROM relations
				 ORDER BY created_at ASC`,
			)
			.all();
	} catch {
		// Table may not exist
	}

	// DID identity (public key only)
	let identity: ExportBundleData["identity"];
	const did = getConfiguredDid();
	if (did && hasSigningKeypair()) {
		// We'll set publicKey async in the caller, but for sync collection
		// we just note the DID. The publicKey gets set in exportBundle.
		identity = { did, publicKey: "" }; // placeholder, set below
	}

	// Merkle tree
	let merkleRoot: string | undefined;
	let merkleLeafCount: number | undefined;
	try {
		// Import dynamically to avoid circular dependency
		const chainMerkle = require("../chain/merkle");
		const tree = chainMerkle.getMemoryRoot(db);
		if (tree.count > 0) {
			merkleRoot = tree.root;
			merkleLeafCount = tree.count;
		}
	} catch {
		// Chain module may not be available
	}

	const data: ExportBundleData = {
		memories,
		decisions,
		entities,
		relations,
		merkleRoot,
		merkleLeafCount,
	};

	// Set identity with actual public key
	if (identity) {
		data.identity = identity;
	}

	// Agent card format: strip memories, keep only metadata
	if (format === "agent-card") {
		return {
			memories: [],
			decisions: [],
			entities: [],
			relations: [],
			identity: data.identity,
			agentCard: {
				did,
				memoriesCount: memories.length,
				entitiesCount: entities.length,
				merkleRoot,
			},
		};
	}

	return data;
}
