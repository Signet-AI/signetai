/**
 * @module export/import
 * @description Import agent bundles from .signet-bundle.json.gz files.
 *
 * Verifies the bundle's SHA-256 checksum and Ed25519 signature before
 * importing. Supports three merge strategies:
 * - replace: overwrite existing memories with bundle data
 * - merge: import new memories, skip duplicates
 * - skip-existing: only import memories that don't exist locally
 */

import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { verifySignature } from "../crypto";
import { didToPublicKey } from "../did";
import type {
	ExportBundle,
	ExportBundleMetadata,
	ExportDb,
	ImportOptions,
	ImportResult,
	MergeStrategy,
} from "./types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SUPPORTED_VERSIONS = ["1.0.0"];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Import an agent bundle from a .signet-bundle.json.gz file.
 *
 * Verifies checksum and signature, then imports memories, decisions,
 * entities, and relations according to the merge strategy.
 *
 * @param db - Database instance
 * @param bundlePath - Path to the .signet-bundle.json.gz file
 * @param options - Import configuration
 * @returns Import result with counts and warnings
 */
export async function importBundle(
	db: ExportDb,
	bundlePath: string,
	options: ImportOptions = {},
): Promise<ImportResult> {
	const mergeStrategy = options.mergeStrategy ?? "merge";
	const dryRun = options.dryRun ?? false;
	const warnings: string[] = [];

	// Read and decompress bundle
	if (!existsSync(bundlePath)) {
		throw new Error(`Bundle file not found: ${bundlePath}`);
	}

	let bundle: ExportBundle;
	try {
		const compressed = readFileSync(bundlePath);
		const decompressed = gunzipSync(compressed);
		bundle = JSON.parse(decompressed.toString("utf-8")) as ExportBundle;
	} catch (err) {
		throw new Error(
			`Failed to read bundle: ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	// Validate structure
	if (!bundle.metadata || !bundle.data) {
		throw new Error("Invalid bundle format: missing metadata or data");
	}

	// Version compatibility check
	const version = bundle.metadata.version;
	if (!SUPPORTED_VERSIONS.includes(version)) {
		warnings.push(
			`Bundle version ${version} may not be fully compatible (supported: ${SUPPORTED_VERSIONS.join(", ")})`,
		);
	}

	// Verify checksum
	const dataJson = JSON.stringify(bundle.data);
	const computedChecksum = createHash("sha256").update(dataJson).digest("hex");

	if (computedChecksum !== bundle.metadata.checksum) {
		throw new Error(
			"Checksum verification failed: bundle data has been modified. " +
			`Expected ${bundle.metadata.checksum}, computed ${computedChecksum}`,
		);
	}

	// Verify signature (if present and not skipped)
	if (!options.skipVerification && bundle.metadata.signature && bundle.metadata.did) {
		try {
			const publicKeyBytes = didToPublicKey(bundle.metadata.did);
			const valid = await verifySignature(
				bundle.metadata.checksum,
				bundle.metadata.signature,
				publicKeyBytes,
			);
			if (!valid) {
				throw new Error("Signature verification failed: bundle may be tampered");
			}
		} catch (err) {
			if (err instanceof Error && err.message.includes("Signature verification failed")) {
				throw err;
			}
			warnings.push(
				`Could not verify signature: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	} else if (!bundle.metadata.signature) {
		warnings.push("Bundle is unsigned — cannot verify authorship");
	}

	// Dry run stops here
	if (dryRun) {
		return {
			success: true,
			mergeStrategy,
			dryRun: true,
			imported: { memories: 0, decisions: 0, entities: 0, relations: 0 },
			skipped: {
				memories: bundle.data.memories.length,
				decisions: bundle.data.decisions.length,
				entities: bundle.data.entities.length,
				relations: bundle.data.relations.length,
			},
			warnings,
			bundleMetadata: bundle.metadata,
		};
	}

	// Import data
	const imported = { memories: 0, decisions: 0, entities: 0, relations: 0 };
	const skipped = { memories: 0, decisions: 0, entities: 0, relations: 0 };

	// Import memories
	for (const mem of bundle.data.memories) {
		if (!mem || typeof mem !== "object" || typeof (mem as Record<string, unknown>).id !== "string" || typeof (mem as Record<string, unknown>).content !== "string") {
			warnings.push("Skipping invalid memory record (missing id or content)");
			skipped.memories++;
			continue;
		}
		const result = importMemory(db, mem, mergeStrategy);
		if (result === "imported") imported.memories++;
		else skipped.memories++;
	}

	// Import decisions
	for (const dec of bundle.data.decisions) {
		if (!dec || typeof dec !== "object" || typeof (dec as Record<string, unknown>).id !== "string") {
			warnings.push("Skipping invalid decision record (missing id)");
			skipped.decisions++;
			continue;
		}
		const result = importDecision(db, dec, mergeStrategy);
		if (result === "imported") imported.decisions++;
		else skipped.decisions++;
	}

	// Import entities
	for (const ent of bundle.data.entities) {
		const result = importEntity(db, ent, mergeStrategy);
		if (result === "imported") imported.entities++;
		else skipped.entities++;
	}

	// Import relations
	for (const rel of bundle.data.relations) {
		const result = importRelation(db, rel, mergeStrategy);
		if (result === "imported") imported.relations++;
		else skipped.relations++;
	}

	return {
		success: true,
		mergeStrategy,
		dryRun: false,
		imported,
		skipped,
		warnings,
		bundleMetadata: bundle.metadata,
	};
}

// ---------------------------------------------------------------------------
// Per-record import helpers
// ---------------------------------------------------------------------------

function importMemory(
	db: ExportDb,
	mem: Record<string, unknown>,
	strategy: MergeStrategy,
): "imported" | "skipped" {
	const id = mem.id as string;
	const contentHash = mem.content_hash as string | undefined;

	// Check for duplicates — by content hash first, then by ID
	let existing: Record<string, unknown> | undefined;
	if (contentHash) {
		existing = db
			.prepare("SELECT id FROM memories WHERE content_hash = ?")
			.get(contentHash);
	}
	if (!existing) {
		existing = db.prepare("SELECT id FROM memories WHERE id = ?").get(id);
	}

	if (existing) {
		if (strategy === "skip-existing") {
			return "skipped";
		}
		if (strategy === "merge") {
			// Skip duplicates in merge mode
			return "skipped";
		}
		if (strategy === "replace") {
			db.prepare(
				`UPDATE memories
				 SET content = ?, type = ?, category = ?, confidence = ?,
				     source_type = ?, tags = ?, importance = ?, pinned = ?,
				     who = ?, content_hash = ?, signature = ?, signer_did = ?,
				     updated_at = ?
				 WHERE id = ?`,
			).run(
				mem.content, mem.type, mem.category ?? null, mem.confidence ?? 0.8,
				mem.source_type ?? "import", mem.tags ?? null, mem.importance ?? 0.3,
				mem.pinned ?? 0, mem.who ?? null, contentHash ?? null,
				mem.signature ?? null, mem.signer_did ?? null,
				new Date().toISOString(), existing.id as string,
			);
			return "imported";
		}
	}

	// Insert new memory
	db.prepare(
		`INSERT OR IGNORE INTO memories
		 (id, content, type, category, confidence, source_type,
		  tags, importance, pinned, who, content_hash, signature,
		  signer_did, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		id, mem.content, mem.type ?? "fact", mem.category ?? null,
		mem.confidence ?? 0.8, mem.source_type ?? "import",
		mem.tags ?? null, mem.importance ?? 0.3, mem.pinned ?? 0,
		mem.who ?? null, contentHash ?? null,
		mem.signature ?? null, mem.signer_did ?? null,
		mem.created_at ?? new Date().toISOString(),
		mem.updated_at ?? new Date().toISOString(),
	);
	return "imported";
}

function importDecision(
	db: ExportDb,
	dec: Record<string, unknown>,
	strategy: MergeStrategy,
): "imported" | "skipped" {
	const id = dec.id as string;

	if (!id || typeof id !== "string") return "skipped";

	try {
		const existing = db.prepare("SELECT id FROM decisions WHERE id = ?").get(id);
		if (existing && strategy !== "replace") {
			return "skipped";
		}

		if (existing && strategy === "replace") {
			db.prepare(
				`UPDATE decisions
				 SET memory_id = ?, conclusion = ?, reasoning = ?, alternatives = ?,
				     context_session = ?, confidence = ?, revisitable = ?,
				     outcome = ?, outcome_notes = ?, outcome_at = ?, reviewed_at = ?
				 WHERE id = ?`,
			).run(
				dec.memory_id, dec.conclusion, dec.reasoning ?? "[]",
				dec.alternatives ?? "[]", dec.context_session ?? null,
				dec.confidence ?? 0.8, dec.revisitable ?? 0,
				dec.outcome ?? null, dec.outcome_notes ?? null,
				dec.outcome_at ?? null, dec.reviewed_at ?? null, id,
			);
			return "imported";
		}

		db.prepare(
			`INSERT OR IGNORE INTO decisions
			 (id, memory_id, conclusion, reasoning, alternatives,
			  context_session, confidence, revisitable, outcome,
			  outcome_notes, outcome_at, created_at, reviewed_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			id, dec.memory_id, dec.conclusion ?? "",
			dec.reasoning ?? "[]", dec.alternatives ?? "[]",
			dec.context_session ?? null, dec.confidence ?? 0.8,
			dec.revisitable ?? 0, dec.outcome ?? null,
			dec.outcome_notes ?? null, dec.outcome_at ?? null,
			dec.created_at ?? new Date().toISOString(),
			dec.reviewed_at ?? null,
		);
		return "imported";
	} catch {
		// Decisions table may not exist
		return "skipped";
	}
}

function importEntity(
	db: ExportDb,
	ent: Record<string, unknown>,
	strategy: MergeStrategy,
): "imported" | "skipped" {
	const id = ent.id as string;

	try {
		const existing = db.prepare("SELECT id FROM entities WHERE id = ?").get(id);
		if (existing && strategy !== "replace") {
			return "skipped";
		}

		if (existing && strategy === "replace") {
			db.prepare(
				`UPDATE entities
				 SET name = ?, canonical_name = ?, entity_type = ?,
				     description = ?, mentions = ?, updated_at = ?
				 WHERE id = ?`,
			).run(
				ent.name, ent.canonical_name ?? null, ent.entity_type ?? "unknown",
				ent.description ?? null, ent.mentions ?? 1,
				new Date().toISOString(), id,
			);
			return "imported";
		}

		db.prepare(
			`INSERT OR IGNORE INTO entities
			 (id, name, canonical_name, entity_type, description, mentions, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			id, ent.name, ent.canonical_name ?? null,
			ent.entity_type ?? "unknown", ent.description ?? null,
			ent.mentions ?? 1, ent.created_at ?? new Date().toISOString(),
			ent.updated_at ?? new Date().toISOString(),
		);
		return "imported";
	} catch {
		return "skipped";
	}
}

function importRelation(
	db: ExportDb,
	rel: Record<string, unknown>,
	strategy: MergeStrategy,
): "imported" | "skipped" {
	const id = rel.id as string;

	try {
		const existing = db.prepare("SELECT id FROM relations WHERE id = ?").get(id);
		if (existing && strategy !== "replace") {
			return "skipped";
		}

		if (existing && strategy === "replace") {
			db.prepare(
				`UPDATE relations
				 SET source_entity_id = ?, target_entity_id = ?, relation_type = ?,
				     strength = ?, mentions = ?, confidence = ?, metadata = ?
				 WHERE id = ?`,
			).run(
				rel.source_entity_id, rel.target_entity_id,
				rel.relation_type ?? "related", rel.strength ?? 1,
				rel.mentions ?? 1, rel.confidence ?? 0.8,
				rel.metadata ?? null, id,
			);
			return "imported";
		}

		db.prepare(
			`INSERT OR IGNORE INTO relations
			 (id, source_entity_id, target_entity_id, relation_type,
			  strength, mentions, confidence, metadata, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			id, rel.source_entity_id, rel.target_entity_id,
			rel.relation_type ?? "related", rel.strength ?? 1,
			rel.mentions ?? 1, rel.confidence ?? 0.8,
			rel.metadata ?? null, rel.created_at ?? new Date().toISOString(),
		);
		return "imported";
	} catch {
		return "skipped";
	}
}
