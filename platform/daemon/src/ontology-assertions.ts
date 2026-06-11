import type { EpistemicAssertion, EpistemicAssertionPredicate, EpistemicAssertionStatus } from "@signetai/core";
import type { DbAccessor, ReadDb, WriteDb } from "./db-accessor";
import { resolveNamedEntity } from "./knowledge-graph";

export class OntologyAssertionError extends Error {
	constructor(
		message: string,
		readonly status: 400 | 404 | 409,
	) {
		super(message);
		this.name = "OntologyAssertionError";
	}
}

export interface CreateEpistemicAssertionInput {
	readonly agentId: string;
	readonly entity?: string;
	readonly entityId?: string;
	readonly predicate: string;
	readonly content: string;
	readonly speaker?: string | null;
	readonly assertedAt?: string | null;
	readonly confidence?: number;
	readonly evidence?: readonly unknown[];
	readonly sourceKind?: string | null;
	readonly sourceId?: string | null;
	readonly sourcePath?: string | null;
	readonly sourceRoot?: string | null;
	readonly claimAttributeId?: string | null;
	readonly supersedesAssertionId?: string | null;
	readonly createdBy?: string | null;
}

export interface ListEpistemicAssertionsParams {
	readonly agentId: string;
	readonly entity?: string;
	readonly entityId?: string;
	readonly predicate?: EpistemicAssertionPredicate;
	readonly status?: EpistemicAssertionStatus | "all";
	readonly speaker?: string;
	readonly sourceKind?: string;
	readonly sourceId?: string;
	readonly query?: string;
	readonly limit?: number;
	readonly offset?: number;
}

export interface ListEpistemicAssertionsResult {
	readonly items: readonly EpistemicAssertion[];
	readonly count: number;
}

const assertionPredicates = ["claims", "believes", "observed", "decided", "prefers", "denies", "questions"] as const;
const assertionStatuses = ["active", "archived", "superseded"] as const;
const predicates = new Set<string>(assertionPredicates);
const statuses = new Set<string>(assertionStatuses);

function trim(value: string | null | undefined): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function normalizeContent(value: string): string {
	return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function clamp01(value: number | undefined): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return 0.7;
	return Math.min(Math.max(value, 0), 1);
}

function parseJsonArray(value: unknown): readonly unknown[] {
	if (typeof value !== "string") return [];
	try {
		const parsed: unknown = JSON.parse(value);
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

function rowToAssertion(row: Record<string, unknown>): EpistemicAssertion {
	return {
		id: row.id as string,
		agentId: row.agent_id as string,
		subjectEntityId: row.subject_entity_id as string,
		subjectEntityName: typeof row.subject_entity_name === "string" ? row.subject_entity_name : null,
		claimAttributeId: typeof row.claim_attribute_id === "string" ? row.claim_attribute_id : null,
		predicate: row.predicate as EpistemicAssertionPredicate,
		content: row.content as string,
		normalizedContent: row.normalized_content as string,
		speaker: typeof row.speaker === "string" ? row.speaker : null,
		assertedAt: row.asserted_at as string,
		confidence: typeof row.confidence === "number" ? row.confidence : 0,
		evidence: parseJsonArray(row.evidence),
		sourceKind: typeof row.source_kind === "string" ? row.source_kind : null,
		sourceId: typeof row.source_id === "string" ? row.source_id : null,
		sourcePath: typeof row.source_path === "string" ? row.source_path : null,
		sourceRoot: typeof row.source_root === "string" ? row.source_root : null,
		status: row.status as EpistemicAssertionStatus,
		supersedesAssertionId: typeof row.supersedes_assertion_id === "string" ? row.supersedes_assertion_id : null,
		archivedAt: typeof row.archived_at === "string" ? row.archived_at : null,
		archivedBy: typeof row.archived_by === "string" ? row.archived_by : null,
		archiveReason: typeof row.archive_reason === "string" ? row.archive_reason : null,
		createdBy: row.created_by as string,
		createdAt: row.created_at as string,
		updatedAt: row.updated_at as string,
	};
}

function parsePredicate(value: string): EpistemicAssertionPredicate {
	const normalized = trim(value);
	if (normalized !== null && predicates.has(normalized)) return normalized as EpistemicAssertionPredicate;
	throw new OntologyAssertionError("predicate is invalid", 400);
}

export function parseEpistemicAssertionPredicate(value: string | undefined): EpistemicAssertionPredicate | undefined {
	const normalized = trim(value);
	return normalized !== null && predicates.has(normalized) ? (normalized as EpistemicAssertionPredicate) : undefined;
}

export function parseEpistemicAssertionStatus(value: string | undefined): EpistemicAssertionStatus | "all" | undefined {
	const normalized = trim(value);
	if (normalized === "all") return "all";
	return normalized !== null && statuses.has(normalized) ? (normalized as EpistemicAssertionStatus) : undefined;
}

function parseAssertedAt(value: string | null | undefined): string {
	const raw = trim(value) ?? new Date().toISOString();
	const ms = Date.parse(raw);
	if (!Number.isFinite(ms)) throw new OntologyAssertionError("asserted_at is invalid", 400);
	return new Date(ms).toISOString();
}

function readEntityById(
	db: ReadDb | WriteDb,
	agentId: string,
	id: string,
): { readonly id: string; readonly name: string } | null {
	const row = db
		.prepare(
			`SELECT id, name
			 FROM entities
			 WHERE id = ? AND agent_id = ? AND COALESCE(status, 'active') = 'active'`,
		)
		.get(id, agentId) as { id: string; name: string } | undefined;
	return row ?? null;
}

function resolveSubject(
	accessor: DbAccessor,
	db: ReadDb | WriteDb,
	input: Pick<CreateEpistemicAssertionInput, "agentId" | "entity" | "entityId">,
): { readonly id: string; readonly name: string } {
	const entityId = trim(input.entityId);
	if (entityId !== null) {
		const byId = readEntityById(db, input.agentId, entityId);
		if (byId === null) throw new OntologyAssertionError("entity_id was not found", 404);
		return byId;
	}
	const entity = trim(input.entity);
	if (entity === null) throw new OntologyAssertionError("entity or entity_id is required", 400);
	const resolved = resolveNamedEntity(accessor, { agentId: input.agentId, name: entity });
	if (resolved === null) throw new OntologyAssertionError("entity was not found", 404);
	return { id: resolved.id, name: resolved.name };
}

function validateEvidence(input: CreateEpistemicAssertionInput): readonly unknown[] {
	const evidence = input.evidence ?? [];
	if (
		evidence.length === 0 &&
		trim(input.sourceKind) === null &&
		trim(input.sourceId) === null &&
		trim(input.sourcePath) === null &&
		trim(input.sourceRoot) === null
	) {
		throw new OntologyAssertionError("evidence or source provenance is required", 400);
	}
	return evidence;
}

function readClaimAttributeEntityId(db: ReadDb | WriteDb, agentId: string, attributeId: string): string | null {
	const row = db
		.prepare(
			`SELECT asp.entity_id
			 FROM entity_attributes attr
			 JOIN entity_aspects asp ON asp.id = attr.aspect_id AND asp.agent_id = attr.agent_id
			 WHERE attr.id = ? AND attr.agent_id = ? AND attr.status = 'active'`,
		)
		.get(attributeId, agentId) as { entity_id: string } | undefined;
	return row?.entity_id ?? null;
}

function validateClaimAttribute(
	db: ReadDb | WriteDb,
	agentId: string,
	subjectEntityId: string,
	attributeId: string | null,
): string | null {
	if (attributeId === null) return null;
	const entityId = readClaimAttributeEntityId(db, agentId, attributeId);
	if (entityId === null) throw new OntologyAssertionError("claim attribute was not found", 404);
	if (entityId !== subjectEntityId) {
		throw new OntologyAssertionError("claim attribute belongs to a different entity", 409);
	}
	return attributeId;
}

function insertAssertion(accessor: DbAccessor, db: WriteDb, input: CreateEpistemicAssertionInput): EpistemicAssertion {
	const subject = resolveSubject(accessor, db, input);
	const content = trim(input.content);
	if (content === null) throw new OntologyAssertionError("content is required", 400);
	const predicate = parsePredicate(input.predicate);
	const evidence = validateEvidence(input);
	const assertedAt = parseAssertedAt(input.assertedAt);
	const claimAttributeId = validateClaimAttribute(db, input.agentId, subject.id, trim(input.claimAttributeId));
	const supersedesAssertionId = trim(input.supersedesAssertionId);
	if (supersedesAssertionId !== null) {
		const existing = db
			.prepare("SELECT id FROM epistemic_assertions WHERE id = ? AND agent_id = ?")
			.get(supersedesAssertionId, input.agentId) as { id: string } | undefined;
		if (!existing) throw new OntologyAssertionError("superseded assertion was not found", 404);
	}

	const now = new Date().toISOString();
	const id = crypto.randomUUID();
	db.prepare(
		`INSERT INTO epistemic_assertions
		 (id, agent_id, subject_entity_id, claim_attribute_id, predicate,
		  content, normalized_content, speaker, asserted_at, confidence, evidence,
		  source_kind, source_id, source_path, source_root, status,
		  supersedes_assertion_id, created_by, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
	).run(
		id,
		input.agentId,
		subject.id,
		claimAttributeId,
		predicate,
		content,
		normalizeContent(content),
		trim(input.speaker),
		assertedAt,
		clamp01(input.confidence),
		JSON.stringify(evidence),
		trim(input.sourceKind),
		trim(input.sourceId),
		trim(input.sourcePath),
		trim(input.sourceRoot),
		supersedesAssertionId,
		trim(input.createdBy) ?? "operator",
		now,
		now,
	);

	const row = db
		.prepare(
			`SELECT a.*, e.name AS subject_entity_name
			 FROM epistemic_assertions a
			 JOIN entities e ON e.id = a.subject_entity_id AND e.agent_id = a.agent_id
			 WHERE a.id = ? AND a.agent_id = ?`,
		)
		.get(id, input.agentId) as Record<string, unknown>;
	return rowToAssertion(row);
}

export function createEpistemicAssertion(
	accessor: DbAccessor,
	input: CreateEpistemicAssertionInput,
): EpistemicAssertion {
	return accessor.withWriteTx((db) => insertAssertion(accessor, db, input));
}

export function createEpistemicAssertionsInTx(
	accessor: DbAccessor,
	db: WriteDb,
	inputs: readonly CreateEpistemicAssertionInput[],
): readonly EpistemicAssertion[] {
	if (inputs.length > 500) throw new OntologyAssertionError("cannot create more than 500 assertions at once", 400);
	return inputs.map((input) => insertAssertion(accessor, db, input));
}

export function listEpistemicAssertions(
	accessor: DbAccessor,
	params: ListEpistemicAssertionsParams,
): ListEpistemicAssertionsResult {
	const limit = Math.min(Math.max(params.limit ?? 50, 1), 200);
	const offset = Math.max(params.offset ?? 0, 0);
	return accessor.withReadDb((db) => {
		const where = ["a.agent_id = ?"];
		const args: unknown[] = [params.agentId];
		const entityId = trim(params.entityId);
		if (entityId !== null) {
			where.push("a.subject_entity_id = ?");
			args.push(entityId);
		} else if (trim(params.entity) !== null) {
			const resolved = resolveNamedEntity(accessor, { agentId: params.agentId, name: params.entity ?? "" });
			if (resolved === null) return { items: [], count: 0 };
			where.push("a.subject_entity_id = ?");
			args.push(resolved.id);
		}
		if (params.status !== "all") {
			where.push("a.status = ?");
			args.push(params.status ?? "active");
		}
		if (params.predicate) {
			where.push("a.predicate = ?");
			args.push(params.predicate);
		}
		if (params.speaker) {
			where.push("a.speaker = ?");
			args.push(params.speaker);
		}
		if (params.sourceKind) {
			where.push("a.source_kind = ?");
			args.push(params.sourceKind);
		}
		if (params.sourceId) {
			where.push("a.source_id = ?");
			args.push(params.sourceId);
		}
		if (params.query) {
			where.push("a.normalized_content LIKE ?");
			args.push(`%${normalizeContent(params.query)}%`);
		}
		const clause = where.join(" AND ");
		const rows = db
			.prepare(
				`SELECT a.*, e.name AS subject_entity_name
				 FROM epistemic_assertions a
				 JOIN entities e ON e.id = a.subject_entity_id AND e.agent_id = a.agent_id
				 WHERE ${clause}
				 ORDER BY a.asserted_at DESC, a.created_at DESC
				 LIMIT ? OFFSET ?`,
			)
			.all(...args, limit, offset) as Array<Record<string, unknown>>;
		const count = db
			.prepare(
				`SELECT COUNT(*) AS count
				 FROM epistemic_assertions a
				 JOIN entities e ON e.id = a.subject_entity_id AND e.agent_id = a.agent_id
				 WHERE ${clause}`,
			)
			.get(...args) as { count: number } | undefined;
		return { items: rows.map(rowToAssertion), count: count?.count ?? rows.length };
	});
}

export function getEpistemicAssertion(
	accessor: DbAccessor,
	params: { readonly agentId: string; readonly id: string },
): EpistemicAssertion | null {
	return accessor.withReadDb((db) => {
		const row = db
			.prepare(
				`SELECT a.*, e.name AS subject_entity_name
				 FROM epistemic_assertions a
				 JOIN entities e ON e.id = a.subject_entity_id AND e.agent_id = a.agent_id
				 WHERE a.id = ? AND a.agent_id = ?`,
			)
			.get(params.id, params.agentId) as Record<string, unknown> | undefined;
		return row ? rowToAssertion(row) : null;
	});
}

export function linkEpistemicAssertionClaim(
	accessor: DbAccessor,
	params: { readonly agentId: string; readonly id: string; readonly attributeId: string },
): EpistemicAssertion {
	return accessor.withWriteTx((db) => {
		const assertion = db
			.prepare("SELECT subject_entity_id FROM epistemic_assertions WHERE id = ? AND agent_id = ?")
			.get(params.id, params.agentId) as { subject_entity_id: string } | undefined;
		if (!assertion) throw new OntologyAssertionError("assertion was not found", 404);
		validateClaimAttribute(db, params.agentId, assertion.subject_entity_id, params.attributeId);
		db.prepare(
			`UPDATE epistemic_assertions
			 SET claim_attribute_id = ?, updated_at = ?
			 WHERE id = ? AND agent_id = ?`,
		).run(params.attributeId, new Date().toISOString(), params.id, params.agentId);
		const row = db
			.prepare(
				`SELECT a.*, e.name AS subject_entity_name
				 FROM epistemic_assertions a
				 JOIN entities e ON e.id = a.subject_entity_id AND e.agent_id = a.agent_id
				 WHERE a.id = ? AND a.agent_id = ?`,
			)
			.get(params.id, params.agentId) as Record<string, unknown>;
		return rowToAssertion(row);
	});
}

export function archiveEpistemicAssertion(
	accessor: DbAccessor,
	params: { readonly agentId: string; readonly id: string; readonly actor: string; readonly reason?: string | null },
): EpistemicAssertion {
	return accessor.withWriteTx((db) => {
		const existing = db
			.prepare("SELECT id FROM epistemic_assertions WHERE id = ? AND agent_id = ?")
			.get(params.id, params.agentId) as { id: string } | undefined;
		if (!existing) throw new OntologyAssertionError("assertion was not found", 404);
		const now = new Date().toISOString();
		db.prepare(
			`UPDATE epistemic_assertions
			 SET status = 'archived', archived_at = ?, archived_by = ?, archive_reason = ?, updated_at = ?
			 WHERE id = ? AND agent_id = ?`,
		).run(now, params.actor, trim(params.reason), now, params.id, params.agentId);
		const row = db
			.prepare(
				`SELECT a.*, e.name AS subject_entity_name
				 FROM epistemic_assertions a
				 JOIN entities e ON e.id = a.subject_entity_id AND e.agent_id = a.agent_id
				 WHERE a.id = ? AND a.agent_id = ?`,
			)
			.get(params.id, params.agentId) as Record<string, unknown>;
		return rowToAssertion(row);
	});
}

export function supersedeEpistemicAssertion(
	accessor: DbAccessor,
	input: CreateEpistemicAssertionInput & { readonly oldAssertionId: string },
): EpistemicAssertion {
	return accessor.withWriteTx((db) => {
		const old = db
			.prepare(
				`SELECT a.*, e.name AS subject_entity_name
				 FROM epistemic_assertions a
				 JOIN entities e ON e.id = a.subject_entity_id AND e.agent_id = a.agent_id
				 WHERE a.id = ? AND a.agent_id = ?`,
			)
			.get(input.oldAssertionId, input.agentId) as Record<string, unknown> | undefined;
		if (!old) throw new OntologyAssertionError("assertion was not found", 404);
		if (trim(input.entityId) !== null || trim(input.entity) !== null) {
			const subject = resolveSubject(accessor, db, input);
			if (subject.id !== old.subject_entity_id) {
				throw new OntologyAssertionError("supersede cannot change assertion subject entity", 409);
			}
		}
		const next = insertAssertion(accessor, db, {
			...input,
			entityId: old.subject_entity_id as string,
			predicate: input.predicate || (old.predicate as string),
			speaker: input.speaker ?? (typeof old.speaker === "string" ? old.speaker : null),
			sourceKind: input.sourceKind ?? (typeof old.source_kind === "string" ? old.source_kind : null),
			sourceId: input.sourceId ?? (typeof old.source_id === "string" ? old.source_id : null),
			sourcePath: input.sourcePath ?? (typeof old.source_path === "string" ? old.source_path : null),
			sourceRoot: input.sourceRoot ?? (typeof old.source_root === "string" ? old.source_root : null),
			supersedesAssertionId: input.oldAssertionId,
		});
		db.prepare(
			`UPDATE epistemic_assertions
			 SET status = 'superseded', updated_at = ?
			 WHERE id = ? AND agent_id = ?`,
		).run(new Date().toISOString(), input.oldAssertionId, input.agentId);
		return next;
	});
}
