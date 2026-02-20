/**
 * Transaction wrappers for atomic memory operations.
 *
 * Each function is a pure DB closure — it receives a WriteDb handle and
 * performs all mutations inside the caller's transaction. No async, no
 * external provider calls.
 */

import type { WriteDb } from "./db-accessor";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface IngestEnvelope {
	id: string;
	content: string;
	contentHash: string;
	who: string;
	why: string | null;
	project: string | null;
	importance: number;
	type: string;
	tags: string | null;
	pinned: number;
	sourceType: string;
	sourceId: string | null;
	createdAt: string;
}

export type DecisionAction = "update" | "delete" | "merge";

export interface SemanticDecision {
	action: DecisionAction;
	memoryId: string;
	/** New content for update/merge actions */
	content?: string;
	/** ID of the memory to merge into (for merge actions) */
	mergeTargetId?: string;
	importance?: number;
	tags?: string | null;
	updatedBy: string;
	updatedAt: string;
}

export interface AccessUpdate {
	id: string;
	lastAccessed: string;
}

// ---------------------------------------------------------------------------
// Transaction closures
// ---------------------------------------------------------------------------

/**
 * Insert a new memory row. Returns the id passed in.
 *
 * Call inside `accessor.withWriteTx(db => txIngestEnvelope(db, envelope))`.
 */
export function txIngestEnvelope(db: WriteDb, mem: IngestEnvelope): string {
	db.prepare(
		`INSERT INTO memories
		 (id, content, content_hash, who, why, project, importance, type,
		  tags, pinned, created_at, updated_at, updated_by,
		  source_type, source_id)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		mem.id,
		mem.content,
		mem.contentHash,
		mem.who,
		mem.why,
		mem.project,
		mem.importance,
		mem.type,
		mem.tags,
		mem.pinned,
		mem.createdAt,
		mem.createdAt,
		mem.who,
		mem.sourceType,
		mem.sourceId,
	);

	// Keep FTS in sync (content= tables need manual population)
	try {
		db.prepare(
			`INSERT INTO memories_fts(rowid, content)
			 SELECT rowid, content FROM memories WHERE id = ?`,
		).run(mem.id);
	} catch {
		// FTS trigger may handle this already
	}

	return mem.id;
}

/**
 * Apply a semantic decision (update, delete, or merge) atomically.
 */
export function txApplyDecision(db: WriteDb, decision: SemanticDecision): void {
	switch (decision.action) {
		case "delete": {
			db.prepare("DELETE FROM memories WHERE id = ?").run(decision.memoryId);
			break;
		}
		case "update": {
			const parts: string[] = ["updated_at = ?", "updated_by = ?"];
			const args: unknown[] = [decision.updatedAt, decision.updatedBy];

			if (decision.content !== undefined) {
				parts.push("content = ?");
				args.push(decision.content);
			}
			if (decision.importance !== undefined) {
				parts.push("importance = ?");
				args.push(decision.importance);
			}
			if (decision.tags !== undefined) {
				parts.push("tags = ?");
				args.push(decision.tags);
			}

			args.push(decision.memoryId);
			db.prepare(`UPDATE memories SET ${parts.join(", ")} WHERE id = ?`).run(
				...args,
			);
			break;
		}
		case "merge": {
			if (
				decision.mergeTargetId === undefined ||
				decision.content === undefined
			) {
				break;
			}
			// Update target with merged content
			db.prepare(
				`UPDATE memories
				 SET content = ?, updated_at = ?, updated_by = ?,
				     version = version + 1
				 WHERE id = ?`,
			).run(
				decision.content,
				decision.updatedAt,
				decision.updatedBy,
				decision.mergeTargetId,
			);
			// Remove the source memory
			db.prepare("DELETE FROM memories WHERE id = ?").run(decision.memoryId);
			break;
		}
	}
}

/**
 * Batch-update access metadata for a list of memory ids.
 */
export function txFinalizeAccessAndHistory(
	db: WriteDb,
	updates: ReadonlyArray<AccessUpdate>,
): void {
	if (updates.length === 0) return;

	const stmt = db.prepare(
		`UPDATE memories
		 SET access_count = access_count + 1, last_accessed = ?
		 WHERE id = ?`,
	);

	for (const update of updates) {
		stmt.run(update.lastAccessed, update.id);
	}
}
