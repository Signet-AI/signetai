/**
 * Transaction wrappers for atomic memory operations.
 *
 * Each function is a pure DB closure — it receives a WriteDb handle and
 * performs all mutations inside the caller's transaction. No async, no
 * external provider calls.
 */

import type { WriteDb } from "./db-accessor";
import { vectorToBlob, syncVecInsert, syncVecDeleteBySourceId, syncVecDeleteBySourceExceptHash } from "./db-helpers";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface IngestEnvelope {
	id: string;
	content: string;
	normalizedContent?: string | null;
	contentHash: string;
	who: string;
	why: string | null;
	project: string | null;
	importance: number;
	type: string;
	tags: string | null;
	pinned: number;
	isDeleted?: number;
	extractionStatus?: string;
	embeddingModel?: string | null;
	extractionModel?: string | null;
	updatedBy?: string;
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

export interface ModifyMemoryPatch {
	content?: string;
	normalizedContent?: string;
	contentHash?: string;
	type?: string;
	tags?: string | null;
	importance?: number;
	pinned?: number;
}

export interface MutationContext {
	actorType?: string;
	sessionId?: string;
	requestId?: string;
}

export interface ModifyMemoryTxInput {
	memoryId: string;
	patch: ModifyMemoryPatch;
	reason: string;
	changedBy: string;
	changedAt: string;
	ifVersion?: number;
	extractionStatusOnContentChange?: string;
	extractionModelOnContentChange?: string | null;
	embeddingModelOnContentChange?: string | null;
	embeddingVector?: readonly number[] | null;
	ctx?: MutationContext;
}

export type ModifyMemoryTxStatus =
	| "updated"
	| "not_found"
	| "deleted"
	| "version_conflict"
	| "duplicate_content_hash"
	| "no_changes";

export interface ModifyMemoryTxResult {
	status: ModifyMemoryTxStatus;
	memoryId: string;
	currentVersion?: number;
	newVersion?: number;
	duplicateMemoryId?: string;
	contentChanged?: boolean;
}

export interface ForgetMemoryTxInput {
	memoryId: string;
	reason: string;
	changedBy: string;
	changedAt: string;
	force: boolean;
	ifVersion?: number;
	ctx?: MutationContext;
}

export type ForgetMemoryTxStatus =
	| "deleted"
	| "not_found"
	| "already_deleted"
	| "version_conflict"
	| "pinned_requires_force"
	| "autonomous_force_denied";

export interface ForgetMemoryTxResult {
	status: ForgetMemoryTxStatus;
	memoryId: string;
	currentVersion?: number;
	newVersion?: number;
}

export interface RecoverMemoryTxInput {
	memoryId: string;
	reason: string;
	changedBy: string;
	changedAt: string;
	retentionWindowMs: number;
	ifVersion?: number;
	ctx?: MutationContext;
}

export type RecoverMemoryTxStatus =
	| "recovered"
	| "not_found"
	| "not_deleted"
	| "retention_expired"
	| "version_conflict";

export interface RecoverMemoryTxResult {
	status: RecoverMemoryTxStatus;
	memoryId: string;
	currentVersion?: number;
	newVersion?: number;
}

interface MutableMemoryRow {
	id: string;
	content: string;
	type: string;
	tags: string | null;
	importance: number;
	pinned: number;
	version: number;
	is_deleted: number;
}

export function insertHistoryEvent(
	db: WriteDb,
	args: {
		readonly memoryId: string;
		readonly event: string;
		readonly oldContent: string | null;
		readonly newContent: string | null;
		readonly changedBy: string;
		readonly reason: string;
		readonly metadata: string | null;
		readonly createdAt: string;
		readonly actorType?: string;
		readonly sessionId?: string;
		readonly requestId?: string;
	},
): void {
	const id = crypto.randomUUID();
	db.prepare(
		`INSERT INTO memory_history
		 (id, memory_id, event, old_content, new_content, changed_by, reason,
		  metadata, created_at, actor_type, session_id, request_id)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		id,
		args.memoryId,
		args.event,
		args.oldContent,
		args.newContent,
		args.changedBy,
		args.reason,
		args.metadata,
		args.createdAt,
		args.actorType ?? null,
		args.sessionId ?? null,
		args.requestId ?? null,
	);
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
		 (id, content, normalized_content, content_hash, who, why, project,
		  importance, type, tags, pinned, is_deleted, extraction_status,
		  embedding_model, extraction_model, created_at, updated_at, updated_by,
		  source_type, source_id)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		mem.id,
		mem.content,
		mem.normalizedContent ?? mem.content,
		mem.contentHash,
		mem.who,
		mem.why,
		mem.project,
		mem.importance,
		mem.type,
		mem.tags,
		mem.pinned,
		mem.isDeleted ?? 0,
		mem.extractionStatus ?? "none",
		mem.embeddingModel ?? null,
		mem.extractionModel ?? null,
		mem.createdAt,
		mem.createdAt,
		mem.updatedBy ?? mem.who,
		mem.sourceType,
		mem.sourceId,
	);

	// FTS sync handled by memories_ai AFTER INSERT trigger (migration 001)

	return mem.id;
}

/**
 * Modify an existing memory row with optional optimistic concurrency guard.
 * Writes UPDATE history in the same transaction when a mutation is applied.
 */
export function txModifyMemory(
	db: WriteDb,
	input: ModifyMemoryTxInput,
): ModifyMemoryTxResult {
	const existing = db
		.prepare(
			`SELECT id, content, type, tags, importance, pinned, version, is_deleted
			 FROM memories
			 WHERE id = ?`,
		)
		.get(input.memoryId) as MutableMemoryRow | undefined;

	if (!existing) {
		return { status: "not_found", memoryId: input.memoryId };
	}
	if (existing.is_deleted === 1) {
		return {
			status: "deleted",
			memoryId: input.memoryId,
			currentVersion: existing.version,
		};
	}
	if (
		input.ifVersion !== undefined &&
		Number.isFinite(input.ifVersion) &&
		existing.version !== input.ifVersion
	) {
		return {
			status: "version_conflict",
			memoryId: input.memoryId,
			currentVersion: existing.version,
		};
	}

	const updates: string[] = [];
	const args: unknown[] = [];
	const changedFields: string[] = [];

	let contentChanged = false;
	let finalContent = existing.content;

	if (
		input.patch.content !== undefined &&
		input.patch.content !== existing.content
	) {
		contentChanged = true;
		finalContent = input.patch.content;

		if (
			input.patch.contentHash !== undefined &&
			input.patch.contentHash !== null
		) {
			const duplicate = db
				.prepare(
					`SELECT id FROM memories
					 WHERE id <> ? AND content_hash = ? AND is_deleted = 0
					 LIMIT 1`,
				)
				.get(input.memoryId, input.patch.contentHash) as
				| { id: string }
				| undefined;
			if (duplicate) {
				return {
					status: "duplicate_content_hash",
					memoryId: input.memoryId,
					currentVersion: existing.version,
					duplicateMemoryId: duplicate.id,
				};
			}
		}

		updates.push("content = ?");
		args.push(input.patch.content);
		updates.push("normalized_content = ?");
		args.push(input.patch.normalizedContent ?? input.patch.content);
		updates.push("content_hash = ?");
		args.push(input.patch.contentHash ?? null);
		updates.push("extraction_status = ?");
		args.push(input.extractionStatusOnContentChange ?? "none");
		updates.push("extraction_model = ?");
		args.push(input.extractionModelOnContentChange ?? null);
		updates.push("embedding_model = ?");
		args.push(
			input.embeddingVector && input.embeddingVector.length > 0
				? (input.embeddingModelOnContentChange ?? null)
				: null,
		);
		changedFields.push("content");
	}

	if (input.patch.type !== undefined && input.patch.type !== existing.type) {
		updates.push("type = ?");
		args.push(input.patch.type);
		changedFields.push("type");
	}

	if (
		input.patch.tags !== undefined &&
		input.patch.tags !== (existing.tags ?? null)
	) {
		updates.push("tags = ?");
		args.push(input.patch.tags);
		changedFields.push("tags");
	}

	if (
		input.patch.importance !== undefined &&
		input.patch.importance !== existing.importance
	) {
		updates.push("importance = ?");
		args.push(input.patch.importance);
		changedFields.push("importance");
	}

	if (
		input.patch.pinned !== undefined &&
		input.patch.pinned !== existing.pinned
	) {
		updates.push("pinned = ?");
		args.push(input.patch.pinned);
		changedFields.push("pinned");
	}

	if (updates.length === 0) {
		return {
			status: "no_changes",
			memoryId: input.memoryId,
			currentVersion: existing.version,
		};
	}

	updates.push("updated_at = ?");
	args.push(input.changedAt);
	updates.push("updated_by = ?");
	args.push(input.changedBy);
	updates.push("version = version + 1");
	updates.push("update_count = COALESCE(update_count, 0) + 1");
	args.push(input.memoryId);

	db.prepare(`UPDATE memories SET ${updates.join(", ")} WHERE id = ?`).run(
		...args,
	);

	if (contentChanged) {
		const newHash = input.patch.contentHash ?? null;
		if (newHash) {
			syncVecDeleteBySourceExceptHash(db, "memory", input.memoryId, newHash);
			db.prepare(
				`DELETE FROM embeddings
				 WHERE source_type = 'memory' AND source_id = ? AND content_hash <> ?`,
			).run(input.memoryId, newHash);
		} else {
			syncVecDeleteBySourceId(db, "memory", input.memoryId);
			db.prepare(
				`DELETE FROM embeddings
				 WHERE source_type = 'memory' AND source_id = ?`,
			).run(input.memoryId);
		}

		if (newHash && input.embeddingVector && input.embeddingVector.length > 0) {
			const embId = crypto.randomUUID();
			const blob = vectorToBlob(input.embeddingVector);
			db.prepare(
				`INSERT INTO embeddings
				 (id, content_hash, vector, dimensions, source_type, source_id, chunk_text, created_at)
				 VALUES (?, ?, ?, ?, 'memory', ?, ?, ?)
				 ON CONFLICT(content_hash) DO UPDATE SET
				   vector = excluded.vector,
				   dimensions = excluded.dimensions,
				   source_type = excluded.source_type,
				   source_id = excluded.source_id,
				   chunk_text = excluded.chunk_text,
				   created_at = excluded.created_at`,
			).run(
				embId,
				newHash,
				blob,
				input.embeddingVector.length,
				input.memoryId,
				input.patch.content,
				input.changedAt,
			);
			syncVecInsert(db, embId, input.embeddingVector);
		}

		// FTS sync handled by memories_au AFTER UPDATE trigger (migration 004)
	}

	insertHistoryEvent(db, {
		memoryId: input.memoryId,
		event: "updated",
		oldContent: existing.content,
		newContent: finalContent,
		changedBy: input.changedBy,
		reason: input.reason,
		metadata: JSON.stringify({
			changedFields,
			ifVersion: input.ifVersion ?? null,
			contentChanged,
		}),
		createdAt: input.changedAt,
		actorType: input.ctx?.actorType,
		sessionId: input.ctx?.sessionId,
		requestId: input.ctx?.requestId,
	});

	return {
		status: "updated",
		memoryId: input.memoryId,
		currentVersion: existing.version,
		newVersion: existing.version + 1,
		contentChanged,
	};
}

/**
 * Soft-delete a memory row with optional optimistic concurrency guard.
 * Writes DELETE history in the same transaction.
 */
export function txForgetMemory(
	db: WriteDb,
	input: ForgetMemoryTxInput,
): ForgetMemoryTxResult {
	const existing = db
		.prepare(
			`SELECT id, content, pinned, version, is_deleted
			 FROM memories
			 WHERE id = ?`,
		)
		.get(input.memoryId) as
		| {
				id: string;
				content: string;
				pinned: number;
				version: number;
				is_deleted: number;
		  }
		| undefined;

	if (!existing) {
		return { status: "not_found", memoryId: input.memoryId };
	}
	if (existing.is_deleted === 1) {
		return {
			status: "already_deleted",
			memoryId: input.memoryId,
			currentVersion: existing.version,
		};
	}
	if (
		input.ifVersion !== undefined &&
		Number.isFinite(input.ifVersion) &&
		existing.version !== input.ifVersion
	) {
		return {
			status: "version_conflict",
			memoryId: input.memoryId,
			currentVersion: existing.version,
		};
	}
	if (existing.pinned === 1 && !input.force) {
		return {
			status: "pinned_requires_force",
			memoryId: input.memoryId,
			currentVersion: existing.version,
		};
	}
	// Spec 27.2: autonomous agents cannot force-delete pinned memories
	if (
		existing.pinned === 1 &&
		input.force &&
		input.ctx?.actorType === "pipeline"
	) {
		return {
			status: "autonomous_force_denied",
			memoryId: input.memoryId,
			currentVersion: existing.version,
		};
	}

	db.prepare(
		`UPDATE memories
		 SET is_deleted = 1,
		     deleted_at = ?,
		     updated_at = ?,
		     updated_by = ?,
		     version = version + 1
		 WHERE id = ?`,
	).run(input.changedAt, input.changedAt, input.changedBy, input.memoryId);

	insertHistoryEvent(db, {
		memoryId: input.memoryId,
		event: "deleted",
		oldContent: existing.content,
		newContent: null,
		changedBy: input.changedBy,
		reason: input.reason,
		metadata: JSON.stringify({
			force: input.force,
			ifVersion: input.ifVersion ?? null,
		}),
		createdAt: input.changedAt,
		actorType: input.ctx?.actorType,
		sessionId: input.ctx?.sessionId,
		requestId: input.ctx?.requestId,
	});

	return {
		status: "deleted",
		memoryId: input.memoryId,
		currentVersion: existing.version,
		newVersion: existing.version + 1,
	};
}

/**
 * Recover a soft-deleted memory row if still within the retention window.
 * Writes RECOVER history in the same transaction.
 */
export function txRecoverMemory(
	db: WriteDb,
	input: RecoverMemoryTxInput,
): RecoverMemoryTxResult {
	const existing = db
		.prepare(
			`SELECT id, content, version, is_deleted, deleted_at
			 FROM memories
			 WHERE id = ?`,
		)
		.get(input.memoryId) as
		| {
				id: string;
				content: string;
				version: number;
				is_deleted: number;
				deleted_at: string | null;
		  }
		| undefined;

	if (!existing) {
		return { status: "not_found", memoryId: input.memoryId };
	}
	if (existing.is_deleted !== 1) {
		return {
			status: "not_deleted",
			memoryId: input.memoryId,
			currentVersion: existing.version,
		};
	}
	if (
		input.ifVersion !== undefined &&
		Number.isFinite(input.ifVersion) &&
		existing.version !== input.ifVersion
	) {
		return {
			status: "version_conflict",
			memoryId: input.memoryId,
			currentVersion: existing.version,
		};
	}
	if (!existing.deleted_at) {
		return {
			status: "retention_expired",
			memoryId: input.memoryId,
			currentVersion: existing.version,
		};
	}

	const deletedAtMs = Date.parse(existing.deleted_at);
	const changedAtMs = Date.parse(input.changedAt);
	if (
		!Number.isFinite(deletedAtMs) ||
		!Number.isFinite(changedAtMs) ||
		changedAtMs - deletedAtMs > input.retentionWindowMs
	) {
		return {
			status: "retention_expired",
			memoryId: input.memoryId,
			currentVersion: existing.version,
		};
	}

	db.prepare(
		`UPDATE memories
		 SET is_deleted = 0,
		     deleted_at = NULL,
		     updated_at = ?,
		     updated_by = ?,
		     version = version + 1
		 WHERE id = ?`,
	).run(input.changedAt, input.changedBy, input.memoryId);

	insertHistoryEvent(db, {
		memoryId: input.memoryId,
		event: "recovered",
		oldContent: null,
		newContent: existing.content,
		changedBy: input.changedBy,
		reason: input.reason,
		metadata: JSON.stringify({
			ifVersion: input.ifVersion ?? null,
			retentionWindowMs: input.retentionWindowMs,
		}),
		createdAt: input.changedAt,
		actorType: input.ctx?.actorType,
		sessionId: input.ctx?.sessionId,
		requestId: input.ctx?.requestId,
	});

	return {
		status: "recovered",
		memoryId: input.memoryId,
		currentVersion: existing.version,
		newVersion: existing.version + 1,
	};
}

/**
 * Apply a semantic decision (update, delete, or merge) atomically.
 * Uses soft-delete for all destructive operations — no hard row removal.
 */
export function txApplyDecision(db: WriteDb, decision: SemanticDecision): void {
	switch (decision.action) {
		case "delete": {
			const existing = db
				.prepare(
					`SELECT id, content, pinned, version, is_deleted
					 FROM memories WHERE id = ?`,
				)
				.get(decision.memoryId) as
				| {
						id: string;
						content: string;
						pinned: number;
						version: number;
						is_deleted: number;
				  }
				| undefined;

			if (!existing || existing.is_deleted === 1) break;
			// Pipeline never force-deletes pinned memories (spec 27.2)
			if (existing.pinned === 1) break;

			db.prepare(
				`UPDATE memories
				 SET is_deleted = 1, deleted_at = ?, updated_at = ?,
				     updated_by = ?, version = version + 1
				 WHERE id = ?`,
			).run(
				decision.updatedAt,
				decision.updatedAt,
				decision.updatedBy,
				decision.memoryId,
			);

			insertHistoryEvent(db, {
				memoryId: decision.memoryId,
				event: "deleted",
				oldContent: existing.content,
				newContent: null,
				changedBy: decision.updatedBy,
				reason: "pipeline-semantic-decision",
				metadata: JSON.stringify({
					actorType: "pipeline",
					action: "delete",
				}),
				createdAt: decision.updatedAt,
			});
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

			parts.push("version = version + 1");
			args.push(decision.memoryId);
			db.prepare(`UPDATE memories SET ${parts.join(", ")} WHERE id = ?`).run(
				...args,
			);

			insertHistoryEvent(db, {
				memoryId: decision.memoryId,
				event: "updated",
				oldContent: null,
				newContent: decision.content ?? null,
				changedBy: decision.updatedBy,
				reason: "pipeline-semantic-decision",
				metadata: JSON.stringify({
					actorType: "pipeline",
					action: "update",
				}),
				createdAt: decision.updatedAt,
			});
			break;
		}
		case "merge": {
			if (
				decision.mergeTargetId === undefined ||
				decision.content === undefined
			) {
				break;
			}

			const source = db
				.prepare(
					`SELECT id, content, pinned, is_deleted
					 FROM memories WHERE id = ?`,
				)
				.get(decision.memoryId) as
				| { id: string; content: string; pinned: number; is_deleted: number }
				| undefined;

			if (!source || source.is_deleted === 1) break;
			// Pipeline never force-deletes pinned memories (spec 27.2)
			if (source.pinned === 1) break;

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

			insertHistoryEvent(db, {
				memoryId: decision.mergeTargetId,
				event: "merged",
				oldContent: null,
				newContent: decision.content,
				changedBy: decision.updatedBy,
				reason: "pipeline-semantic-decision",
				metadata: JSON.stringify({
					actorType: "pipeline",
					action: "merge",
					sourceMemoryId: decision.memoryId,
				}),
				createdAt: decision.updatedAt,
			});

			// Soft-delete source memory
			db.prepare(
				`UPDATE memories
				 SET is_deleted = 1, deleted_at = ?, updated_at = ?,
				     updated_by = ?, version = version + 1
				 WHERE id = ?`,
			).run(
				decision.updatedAt,
				decision.updatedAt,
				decision.updatedBy,
				decision.memoryId,
			);

			insertHistoryEvent(db, {
				memoryId: decision.memoryId,
				event: "deleted",
				oldContent: source.content,
				newContent: null,
				changedBy: decision.updatedBy,
				reason: "pipeline-merge-source-retired",
				metadata: JSON.stringify({
					actorType: "pipeline",
					action: "merge",
					mergeTargetId: decision.mergeTargetId,
				}),
				createdAt: decision.updatedAt,
			});
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
