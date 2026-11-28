import { resolveNamedEntity } from "./knowledge-graph";
import { knowledgeReadDb, type KnowledgeReadDb } from "./knowledge-graph-hygiene";
import { readScopeSql, type ReadScope } from "./read-scope";
import { dreamingReadScopeInDb, recordSemanticCitationsInTx, semanticWritePartitionInDb } from "./classification-owner";
import { proposalCitationsInDb } from "./ontology-proposals";
import type { EpistemicAssertion, EpistemicAssertionPredicate, EpistemicAssertionStatus } from "@signet/core";
import type { WriteAuthor } from "./auth/audit-owner";
import type { DbAccessor, ReadDb, WriteDb } from "./db-accessor";
import { validateDerivedMemorySourceInTx } from "./derived-memory-provenance";
import { resolveEntityRecordByName } from "./knowledge-graph";

export class OntologyAssertionError extends Error {
	constructor(
		message: string,
		readonly status: 400 | 403 | 404 | 409,
	) {
		super(message);
		this.name = "OntologyAssertionError";
	}
}

export interface CreateEpistemicAssertionInput {
	readonly readScope?: ReadScope;
	readonly agentId: string;
	readonly observerId?: string | null;
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
	readonly author?: WriteAuthor;
}

export interface ListEpistemicAssertionsParams {
	readonly agentId: string;
	readonly observerId?: string;
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

export function validateEpistemicObserverScope(agentId: string, observerId?: string | null): string {
	const normalizedAgentId = trim(agentId);
	if (normalizedAgentId === null) throw new OntologyAssertionError("agent_id is required", 400);
	const normalizedObserverId = trim(observerId);
	if (normalizedObserverId !== null && normalizedObserverId !== normalizedAgentId) {
		throw new OntologyAssertionError(
			"observer_id must match the authorized agent scope; arbitrary peer observers are not enabled",
			403,
		);
	}
	return normalizedAgentId;
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
		observerId: row.agent_id as string,
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

function assertAssertionSubjectLabel(
	db: ReadDb,
	agentId: string,
	label: number | null,
	subjectLabel: number | null,
): void {
	const scope = dreamingReadScopeInDb(db, agentId, label);
	if (subjectLabel !== null && scope.compartments !== "all" && !scope.compartments.includes(subjectLabel))
		throw new OntologyAssertionError("compartment_mismatch", 409);
}

function assertionReadScope(agentId: string, scope?: ReadScope): ReadScope {
	if (scope?.projects !== undefined && scope.projects !== null)
		throw new OntologyAssertionError("project_scope_unsupported", 403);
	return scope ?? { reach: { kind: "own", agentId }, compartments: [], projects: null };
}

function readEntityById(
	db: ReadDb | WriteDb,
	agentId: string,
	id: string,
	readScope?: ReadScope,
): { readonly id: string; readonly name: string; readonly compartment_id: number | null } | null {
	const scope = readScopeSql("", assertionReadScope(agentId, readScope), { visibility: null });
	const row = db
		.prepare(
			`SELECT id, name, compartment_id
			 FROM entities
			 WHERE id = ? AND agent_id = ? AND COALESCE(status, 'active') = 'active' ${scope.sql}`,
		)
		.get(id, agentId, ...scope.args) as { id: string; name: string; compartment_id: number | null } | undefined;
	return row ?? null;
}

function resolveSubject(
	db: ReadDb | WriteDb,
	input: Pick<CreateEpistemicAssertionInput, "agentId" | "entity" | "entityId" | "readScope">,
): { readonly id: string; readonly name: string; readonly compartment_id: number | null } {
	const entityId = trim(input.entityId);
	if (entityId !== null) {
		const byId = readEntityById(db, input.agentId, entityId, input.readScope);
		if (byId === null) throw new OntologyAssertionError("entity_id was not found", 404);
		return byId;
	}
	const entity = trim(input.entity);
	if (entity === null) throw new OntologyAssertionError("entity or entity_id is required", 400);
	const resolved = resolveEntityRecordByName(
		db,
		{ agentId: input.agentId, name: entity },
		assertionReadScope(input.agentId, input.readScope),
	);
	if (resolved === null) throw new OntologyAssertionError("entity was not found", 404);
	const subject = readEntityById(db, input.agentId, resolved.id, input.readScope);
	if (subject === null) throw new OntologyAssertionError("entity was not found", 404);
	return subject;
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

function readClaimAttributeEntityId(
	db: ReadDb | WriteDb,
	agentId: string,
	attributeId: string,
	readScope?: ReadScope,
): { entity_id: string; compartment_id: number | null } | null {
	const scope = readScopeSql("attr", assertionReadScope(agentId, readScope), { visibility: null });
	const entityScope = readScopeSql("e", assertionReadScope(agentId, readScope), { visibility: null });
	const row = db
		.prepare(
			`SELECT asp.entity_id, attr.compartment_id
			 FROM entity_attributes attr
			 JOIN entity_aspects asp ON asp.id = attr.aspect_id AND asp.agent_id = attr.agent_id
			 JOIN entities e ON e.id=asp.entity_id AND e.agent_id=asp.agent_id
			 WHERE attr.id = ? AND attr.agent_id = ? AND attr.status = 'active' ${scope.sql} ${entityScope.sql}`,
		)
		.get(attributeId, agentId, ...scope.args, ...entityScope.args) as
		| { entity_id: string; compartment_id: number | null }
		| undefined;
	return row ?? null;
}

function validateClaimAttribute(
	db: ReadDb | WriteDb,
	agentId: string,
	subjectEntityId: string,
	attributeId: string | null,
	readScope?: ReadScope,
): string | null {
	if (attributeId === null) return null;
	const entityId = readClaimAttributeEntityId(db, agentId, attributeId, readScope);
	if (entityId === null) throw new OntologyAssertionError("claim attribute was not found", 404);
	if (entityId.entity_id !== subjectEntityId) {
		throw new OntologyAssertionError("claim attribute belongs to a different entity", 409);
	}
	return attributeId;
}

function insertAssertion(db: WriteDb, input: CreateEpistemicAssertionInput): EpistemicAssertion {
	validateEpistemicObserverScope(input.agentId, input.observerId);
	const subject = resolveSubject(db, input);
	const content = trim(input.content);
	if (content === null) throw new OntologyAssertionError("content is required", 400);
	const predicate = parsePredicate(input.predicate);
	const evidence = validateEvidence(input);
	const assertedAt = parseAssertedAt(input.assertedAt);
	const claimAttributeId = validateClaimAttribute(
		db,
		input.agentId,
		subject.id,
		trim(input.claimAttributeId),
		input.readScope,
	);
	const sourceKind = trim(input.sourceKind);
	const sourceId = trim(input.sourceId);
	if (sourceKind === "ontology_claim" && sourceId === null) {
		throw new OntologyAssertionError("ontology_claim source_id is required", 400);
	}
	if (sourceKind === "ontology_claim" && sourceId !== null) {
		if (readClaimAttributeEntityId(db, input.agentId, sourceId, input.readScope) === null)
			throw new OntologyAssertionError("Evidence source was not found", 404);
		try {
			validateDerivedMemorySourceInTx(db, { agentId: input.agentId, sourceKind, sourceId });
		} catch (err) {
			throw new OntologyAssertionError(
				err instanceof Error ? err.message : "assertion provenance is unauthorized",
				409,
			);
		}
	}
	const supersedesAssertionId = trim(input.supersedesAssertionId);
	const parents = subject.compartment_id === null ? [] : [subject.compartment_id];
	if (claimAttributeId !== null) {
		const claim = readClaimAttributeEntityId(db, input.agentId, claimAttributeId, input.readScope);
		if (claim?.compartment_id != null) parents.push(claim.compartment_id);
	}
	if (supersedesAssertionId !== null) {
		const predicate = readScopeSql("", assertionReadScope(input.agentId, input.readScope), { visibility: null });
		const existing = db
			.prepare(`SELECT id,compartment_id FROM epistemic_assertions WHERE id = ? AND agent_id = ? ${predicate.sql}`)
			.get(supersedesAssertionId, input.agentId, ...predicate.args) as
			| { id: string; compartment_id: number | null }
			| undefined;
		if (!existing) throw new OntologyAssertionError("superseded assertion was not found", 404);
		if (existing.compartment_id !== null) parents.push(existing.compartment_id);
	}

	const scope = assertionReadScope(input.agentId, input.readScope);
	const sourceEvidence =
		sourceKind && sourceId && ["memory", "artifact", "transcript", "summary"].includes(sourceKind)
			? [...evidence, { source_kind: sourceKind, source_id: sourceId }]
			: evidence;
	const citations = proposalCitationsInDb(
		db,
		input.agentId,
		sourceEvidence.filter((value) => {
			if (typeof value !== "object" || value === null) return false;
			return "source_ref" in value || "source_kind" in value || "source_id" in value || "memory_id" in value;
		}),
		undefined,
		scope,
	);
	if (sourceKind === "ontology_claim" && sourceId !== null) citations.push({ kind: "attribute", id: sourceId });
	if (scope.organizationMode && citations.length === 0)
		throw new OntologyAssertionError("Evidence source was not found", 404);
	const partition = semanticWritePartitionInDb(db, input.agentId, scope, citations, parents);
	const now = new Date().toISOString();
	const id = crypto.randomUUID();
	db.prepare(
		`INSERT INTO epistemic_assertions
		 (id, agent_id, subject_entity_id, claim_attribute_id, predicate,
		  content, normalized_content, speaker, asserted_at, confidence, evidence,
		  source_kind, source_id, source_path, source_root, status,
		  supersedes_assertion_id, created_by, created_at, updated_at, compartment_id)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`,
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
		sourceKind,
		sourceId,
		trim(input.sourcePath),
		trim(input.sourceRoot),
		supersedesAssertionId,
		trim(input.createdBy) ?? "operator",
		now,
		now,
		partition.compartmentId,
	);
	recordSemanticCitationsInTx(db, { kind: "assertion", id, partition, evidence: citations });

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
	// @ts-expect-error LEGACY_SYNC_DB_ACCESS: withWriteTx migration site
	return accessor.withWriteTx((db: WriteDb) => insertAssertion(db, input), "db:ontology.assertion.create.write");
}

export function createEpistemicAssertionsInTx(
	_accessor: DbAccessor,
	db: WriteDb,
	inputs: readonly CreateEpistemicAssertionInput[],
): readonly EpistemicAssertion[] {
	if (inputs.length > 500) throw new OntologyAssertionError("cannot create more than 500 assertions at once", 400);
	return inputs.map((input) => insertAssertion(db, input));
}

export async function listEpistemicAssertions(
	accessor: DbAccessor,
	params: ListEpistemicAssertionsParams,
	readScope?: ReadScope,
): Promise<ListEpistemicAssertionsResult> {
	const limit = Math.min(Math.max(params.limit ?? 50, 1), 200);
	const offset = Math.max(params.offset ?? 0, 0);

	return (async (db: KnowledgeReadDb) => {
		const observerId = validateEpistemicObserverScope(params.agentId, params.observerId);
		const where = ["a.agent_id = ?"];
		const args: unknown[] = [observerId];
		const entityId = trim(params.entityId);
		if (entityId !== null) {
			where.push("a.subject_entity_id = ?");
			args.push(entityId);
		} else if (trim(params.entity) !== null) {
			const resolved = await resolveNamedEntity(
				accessor,
				{ agentId: params.agentId, name: params.entity ?? "" },
				readScope,
			);
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
		const rows = (await db
			.prepare(
				`SELECT a.*, e.name AS subject_entity_name
				 FROM epistemic_assertions a
				 JOIN entities e ON e.id = a.subject_entity_id AND e.agent_id = a.agent_id
				 WHERE ${clause}
				 ORDER BY a.asserted_at DESC, a.created_at DESC
				 LIMIT ? OFFSET ?`,
			)
			.all(...args, limit, offset)) as Array<Record<string, unknown>>;
		const count = (await db
			.prepare(
				`SELECT COUNT(*) AS count
				 FROM epistemic_assertions a
				 JOIN entities e ON e.id = a.subject_entity_id AND e.agent_id = a.agent_id
				 WHERE ${clause}`,
			)
			.get(...args)) as { count: number } | undefined;
		return { items: rows.map(rowToAssertion), count: count?.count ?? rows.length };
	})(knowledgeReadDb(readScope));
}

export async function getEpistemicAssertion(
	_accessor: DbAccessor,
	params: { readonly agentId: string; readonly id: string; readonly observerId?: string | null },
	readScope?: ReadScope,
): Promise<EpistemicAssertion | null> {
	return (async (db: KnowledgeReadDb) => {
		const observerId = validateEpistemicObserverScope(params.agentId, params.observerId);
		const row = (await db
			.prepare(
				`SELECT a.*, e.name AS subject_entity_name
				 FROM epistemic_assertions a
				 JOIN entities e ON e.id = a.subject_entity_id AND e.agent_id = a.agent_id
				 WHERE a.id = ? AND a.agent_id = ?`,
			)
			.get(params.id, observerId)) as Record<string, unknown> | undefined;
		return row ? rowToAssertion(row) : null;
	})(knowledgeReadDb(readScope));
}

export function linkEpistemicAssertionClaim(
	accessor: DbAccessor,
	params: {
		readonly agentId: string;
		readonly id: string;
		readonly attributeId: string;
		readonly readScope?: ReadScope;
	},
): EpistemicAssertion {
	// @ts-expect-error LEGACY_SYNC_DB_ACCESS: withWriteTx migration site
	return accessor.withWriteTx((db: WriteDb) => {
		const scope = readScopeSql("a", assertionReadScope(params.agentId, params.readScope), { visibility: null });
		const entityScope = readScopeSql("e", assertionReadScope(params.agentId, params.readScope), { visibility: null });
		const assertion = db
			.prepare(
				`SELECT a.subject_entity_id,a.compartment_id,e.compartment_id AS subject_compartment_id FROM epistemic_assertions a JOIN entities e ON e.id=a.subject_entity_id AND e.agent_id=a.agent_id WHERE a.id = ? AND a.agent_id = ? ${scope.sql} ${entityScope.sql}`,
			)
			.get(params.id, params.agentId, ...scope.args, ...entityScope.args) as
			| { subject_entity_id: string; compartment_id: number | null; subject_compartment_id: number | null }
			| undefined;
		if (!assertion) throw new OntologyAssertionError("assertion was not found", 404);
		validateClaimAttribute(db, params.agentId, assertion.subject_entity_id, params.attributeId, params.readScope);
		const citations = [{ kind: "attribute" as const, id: params.attributeId }];
		const partition = semanticWritePartitionInDb(
			db,
			params.agentId,
			assertionReadScope(params.agentId, params.readScope),
			citations,
			[assertion.compartment_id, assertion.subject_compartment_id].filter((value): value is number => value !== null),
		);
		recordSemanticCitationsInTx(db, { kind: "assertion", id: params.id, partition, evidence: citations });
		db.prepare(
			`UPDATE epistemic_assertions
			 SET claim_attribute_id = ?, updated_at = ?, compartment_id = ?
			 WHERE id = ? AND agent_id = ?`,
		).run(params.attributeId, new Date().toISOString(), partition.compartmentId, params.id, params.agentId);
		const row = db
			.prepare(
				`SELECT a.*, e.name AS subject_entity_name
				 FROM epistemic_assertions a
				 JOIN entities e ON e.id = a.subject_entity_id AND e.agent_id = a.agent_id
				 WHERE a.id = ? AND a.agent_id = ?`,
			)
			.get(params.id, params.agentId) as Record<string, unknown>;
		return rowToAssertion(row);
	}, "db:ontology.assertion.link-claim.write");
}

export function archiveEpistemicAssertion(
	accessor: DbAccessor,
	params: {
		readonly agentId: string;
		readonly id: string;
		readonly actor: string;
		readonly readScope?: ReadScope;
		readonly author?: WriteAuthor;
		readonly reason?: string | null;
	},
): EpistemicAssertion {
	// @ts-expect-error LEGACY_SYNC_DB_ACCESS: withWriteTx migration site
	return accessor.withWriteTx((db: WriteDb) => {
		const scope = readScopeSql("a", assertionReadScope(params.agentId, params.readScope), { visibility: null });
		const entityScope = readScopeSql("e", assertionReadScope(params.agentId, params.readScope), { visibility: null });
		const existing = db
			.prepare(
				`SELECT a.id,a.compartment_id,e.compartment_id AS subject_compartment_id FROM epistemic_assertions a JOIN entities e ON e.id=a.subject_entity_id AND e.agent_id=a.agent_id WHERE a.id = ? AND a.agent_id = ? ${scope.sql} ${entityScope.sql}`,
			)
			.get(params.id, params.agentId, ...scope.args, ...entityScope.args) as
			| { id: string; compartment_id: number | null; subject_compartment_id: number | null }
			| undefined;
		if (!existing) throw new OntologyAssertionError("assertion was not found", 404);
		assertAssertionSubjectLabel(db, params.agentId, existing.compartment_id, existing.subject_compartment_id);
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
	}, "db:ontology.assertion.archive.write");
}

export function supersedeEpistemicAssertion(
	accessor: DbAccessor,
	input: CreateEpistemicAssertionInput & { readonly oldAssertionId: string },
): EpistemicAssertion {
	// @ts-expect-error LEGACY_SYNC_DB_ACCESS: withWriteTx migration site
	return accessor.withWriteTx((db: WriteDb) => {
		const scope = readScopeSql("a", assertionReadScope(input.agentId, input.readScope), { visibility: null });
		const entityScope = readScopeSql("e", assertionReadScope(input.agentId, input.readScope), { visibility: null });
		const old = db
			.prepare(
				`SELECT a.*, e.name AS subject_entity_name, e.compartment_id AS subject_compartment_id
				 FROM epistemic_assertions a
				 JOIN entities e ON e.id = a.subject_entity_id AND e.agent_id = a.agent_id
				 WHERE a.id = ? AND a.agent_id = ? ${scope.sql} ${entityScope.sql}`,
			)
			.get(input.oldAssertionId, input.agentId, ...scope.args, ...entityScope.args) as
			| Record<string, unknown>
			| undefined;
		if (!old) throw new OntologyAssertionError("assertion was not found", 404);
		assertAssertionSubjectLabel(
			db,
			input.agentId,
			typeof old.compartment_id === "number" ? old.compartment_id : null,
			typeof old.subject_compartment_id === "number" ? old.subject_compartment_id : null,
		);
		if (trim(input.entityId) !== null || trim(input.entity) !== null) {
			const subject = resolveSubject(db, input);
			if (subject.id !== old.subject_entity_id) {
				throw new OntologyAssertionError("supersede cannot change assertion subject entity", 409);
			}
		}
		const next = insertAssertion(db, {
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
	}, "db:ontology.assertion.supersede.write");
}
