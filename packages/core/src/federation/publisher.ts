/**
 * @module federation/publisher
 * @description Selective memory publishing — the privacy layer.
 *
 * Users define publish rules that control exactly which memories get shared
 * with which peers. This is the gatekeeper between local memory and the network.
 *
 * Rules match on: search query, tags, memory types, minimum importance.
 * Rules target: specific peers (peerIds) or all trusted peers (null).
 */

import { randomBytes } from "node:crypto";
import type {
	FederationDb,
	PublishRule,
	SyncMemory,
} from "./types";
import { getTrustedPeers, getPeerById } from "./peer-manager";

// ---------------------------------------------------------------------------
// Generate IDs
// ---------------------------------------------------------------------------

function generateId(): string {
	return `rule_${Date.now()}_${randomBytes(4).toString("hex")}`;
}

// ---------------------------------------------------------------------------
// Row → PublishRule conversion
// ---------------------------------------------------------------------------

function rowToRule(row: Record<string, unknown>): PublishRule {
	return {
		id: row.id as string,
		name: row.name as string,
		query: (row.query as string) || undefined,
		tags: row.tags ? JSON.parse(row.tags as string) : undefined,
		types: row.types ? JSON.parse(row.types as string) : undefined,
		minImportance: (row.min_importance as number) ?? 0.5,
		peerIds: row.peer_ids ? JSON.parse(row.peer_ids as string) : undefined,
		autoPublish: !!(row.auto_publish as number),
		createdAt: row.created_at as string,
	};
}

// ---------------------------------------------------------------------------
// CRUD for publish rules
// ---------------------------------------------------------------------------

/**
 * Create a new publish rule.
 *
 * @param db - Database instance
 * @param rule - Rule definition (id auto-generated if not provided)
 * @returns The created PublishRule
 */
export function createPublishRule(
	db: FederationDb,
	rule: {
		id?: string;
		name: string;
		query?: string;
		tags?: string[];
		types?: string[];
		minImportance?: number;
		peerIds?: string[];
		autoPublish?: boolean;
	},
): PublishRule {
	const id = rule.id ?? generateId();

	db.prepare(
		`INSERT INTO federation_publish_rules
		 (id, name, query, tags, types, min_importance, peer_ids, auto_publish)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		id,
		rule.name,
		rule.query ?? null,
		rule.tags ? JSON.stringify(rule.tags) : null,
		rule.types ? JSON.stringify(rule.types) : null,
		rule.minImportance ?? 0.5,
		rule.peerIds ? JSON.stringify(rule.peerIds) : null,
		rule.autoPublish ? 1 : 0,
	);

	const row = db.prepare("SELECT * FROM federation_publish_rules WHERE id = ?").get(id);
	return rowToRule(row!);
}

/**
 * Get all publish rules.
 */
export function getPublishRules(db: FederationDb): PublishRule[] {
	return db
		.prepare("SELECT * FROM federation_publish_rules ORDER BY created_at DESC")
		.all()
		.map(rowToRule);
}

/**
 * Get a single publish rule by ID.
 */
export function getPublishRuleById(db: FederationDb, ruleId: string): PublishRule | null {
	const row = db.prepare("SELECT * FROM federation_publish_rules WHERE id = ?").get(ruleId);
	return row ? rowToRule(row) : null;
}

/**
 * Update a publish rule.
 *
 * @param db - Database instance
 * @param ruleId - Rule ID to update
 * @param updates - Fields to update
 * @throws If rule not found
 */
export function updatePublishRule(
	db: FederationDb,
	ruleId: string,
	updates: Partial<{
		name: string;
		query: string;
		tags: string[];
		types: string[];
		minImportance: number;
		peerIds: string[];
		autoPublish: boolean;
	}>,
): void {
	const fields: string[] = [];
	const values: unknown[] = [];

	if (updates.name !== undefined) { fields.push("name = ?"); values.push(updates.name); }
	if (updates.query !== undefined) { fields.push("query = ?"); values.push(updates.query); }
	if (updates.tags !== undefined) { fields.push("tags = ?"); values.push(JSON.stringify(updates.tags)); }
	if (updates.types !== undefined) { fields.push("types = ?"); values.push(JSON.stringify(updates.types)); }
	if (updates.minImportance !== undefined) { fields.push("min_importance = ?"); values.push(updates.minImportance); }
	if (updates.peerIds !== undefined) { fields.push("peer_ids = ?"); values.push(JSON.stringify(updates.peerIds)); }
	if (updates.autoPublish !== undefined) { fields.push("auto_publish = ?"); values.push(updates.autoPublish ? 1 : 0); }

	if (fields.length === 0) return;

	values.push(ruleId);
	const result = db
		.prepare(`UPDATE federation_publish_rules SET ${fields.join(", ")} WHERE id = ?`)
		.run(...values);

	if (result.changes === 0) {
		throw new Error(`Publish rule not found: ${ruleId}`);
	}
}

/**
 * Delete a publish rule.
 */
export function deletePublishRule(db: FederationDb, ruleId: string): void {
	const result = db
		.prepare("DELETE FROM federation_publish_rules WHERE id = ?")
		.run(ruleId);
	if (result.changes === 0) {
		throw new Error(`Publish rule not found: ${ruleId}`);
	}
}

// ---------------------------------------------------------------------------
// Get publishable memories
// ---------------------------------------------------------------------------

/**
 * Get all memories that match publish rules for a specific peer.
 *
 * Evaluates all rules, filters memories accordingly, deduplicates,
 * and excludes memories already shared with this peer.
 *
 * @param db - Database instance
 * @param peerId - Target peer ID (or null for all-peer rules)
 * @returns Array of SyncMemory objects ready for sharing
 */
export function getPublishableMemories(db: FederationDb, peerId: string): SyncMemory[] {
	const rules = getPublishRules(db);
	if (rules.length === 0) return [];

	// Filter rules that apply to this peer
	const applicableRules = rules.filter((rule) => {
		if (!rule.peerIds) return true; // null peerIds = applies to all trusted
		return rule.peerIds.includes(peerId);
	});

	if (applicableRules.length === 0) return [];

	// Get already-shared memory IDs
	const sharedRows = db
		.prepare("SELECT memory_id FROM federation_shared WHERE peer_id = ?")
		.all(peerId) as Array<{ memory_id: string }>;
	const alreadyShared = new Set(sharedRows.map((r) => r.memory_id));

	// Collect matching memories from all applicable rules
	const matchedIds = new Set<string>();
	const results: SyncMemory[] = [];

	for (const rule of applicableRules) {
		const memories = queryMemoriesForRule(db, rule);
		for (const mem of memories) {
			if (matchedIds.has(mem.id) || alreadyShared.has(mem.id)) continue;
			matchedIds.add(mem.id);
			results.push(mem);
		}
	}

	return results;
}

/**
 * Query local memories that match a specific publish rule.
 */
function queryMemoriesForRule(db: FederationDb, rule: PublishRule): SyncMemory[] {
	let sql = `
		SELECT id, content, type, tags, importance, who, content_hash, signature, signer_did, created_at
		FROM memories
		WHERE is_deleted = 0
	`;
	const params: unknown[] = [];

	// Min importance filter
	sql += " AND COALESCE(importance, 0.5) >= ?";
	params.push(rule.minImportance);

	// Type filter
	if (rule.types && rule.types.length > 0) {
		const placeholders = rule.types.map(() => "?").join(", ");
		sql += ` AND type IN (${placeholders})`;
		params.push(...rule.types);
	}

	// Tag filter (tags stored as comma-separated in DB)
	if (rule.tags && rule.tags.length > 0) {
		const tagClauses = rule.tags.map(() => "tags LIKE ?");
		sql += ` AND (${tagClauses.join(" OR ")})`;
		params.push(...rule.tags.map((t) => `%${t}%`));
	}

	// Query filter (simple content search)
	if (rule.query) {
		sql += " AND content LIKE ?";
		params.push(`%${rule.query}%`);
	}

	sql += " ORDER BY created_at DESC LIMIT 500";

	const rows = db.prepare(sql).all(...params);

	return rows.map((row) => ({
		id: row.id as string,
		content: row.content as string,
		type: row.type as string,
		tags: row.tags ? (row.tags as string).split(",").map((t: string) => t.trim()).filter(Boolean) : undefined,
		importance: (row.importance as number) ?? undefined,
		who: (row.who as string) || undefined,
		contentHash: (row.content_hash as string) || undefined,
		signature: (row.signature as string) || undefined,
		signerDid: (row.signer_did as string) || undefined,
		createdAt: row.created_at as string,
	}));
}

/**
 * Automatically publish memories matching auto-publish rules to a peer.
 * Only runs rules where autoPublish is true.
 *
 * @param db - Database instance
 * @param peerId - Target peer ID
 * @returns Array of memories to push
 */
export function autoPublish(db: FederationDb, peerId: string): SyncMemory[] {
	const rules = getPublishRules(db);
	const autoRules = rules.filter((r) => r.autoPublish);
	if (autoRules.length === 0) return [];

	// Filter to rules applicable to this peer
	const applicable = autoRules.filter((rule) => {
		if (!rule.peerIds) return true;
		return rule.peerIds.includes(peerId);
	});

	if (applicable.length === 0) return [];

	// Get already-shared memory IDs
	const sharedRows = db
		.prepare("SELECT memory_id FROM federation_shared WHERE peer_id = ?")
		.all(peerId) as Array<{ memory_id: string }>;
	const alreadyShared = new Set(sharedRows.map((r) => r.memory_id));

	const matchedIds = new Set<string>();
	const results: SyncMemory[] = [];

	for (const rule of applicable) {
		const memories = queryMemoriesForRule(db, rule);
		for (const mem of memories) {
			if (matchedIds.has(mem.id) || alreadyShared.has(mem.id)) continue;
			matchedIds.add(mem.id);
			results.push(mem);
		}
	}

	return results;
}
