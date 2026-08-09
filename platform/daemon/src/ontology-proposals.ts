import {
	ATTRIBUTE_KINDS,
	type AttributeKind,
	DEPENDENCY_TYPES,
	type DependencyType,
	ENTITY_TYPES,
	type EntityType,
	ONTOLOGY_PROPOSAL_STATUSES,
	type OntologyProposal,
	type OntologyProposalStatus,
} from "@signet/core";
import type { DbAccessor, ReadDb, WriteDb } from "./db-accessor";
import { requireDependencyReason } from "./dependency-history";
import { linkDerivedMemorySourcesInTx, markDerivedMemoriesStaleForSourceInTx } from "./derived-memory-provenance";
import { classifyEntityQuality } from "./entity-quality";
import {
	type OntologyEvidenceItem,
	type OntologyEvidenceRef,
	readOntologyEvidenceRef,
	resolveOntologyEvidenceRef,
	uniqueOntologyEvidenceRefs,
} from "./ontology-evidence";
import { insertHistoryEvent, txForgetMemory, txIngestEnvelope, txSupersedeMemory } from "./transactions";

type ProposalRow = {
	readonly id: string;
	readonly agent_id: string;
	readonly operation: string;
	readonly status: OntologyProposalStatus;
	readonly payload: string;
	readonly confidence: number;
	readonly rationale: string;
	readonly evidence: string;
	readonly risk: string | null;
	readonly source_kind: string | null;
	readonly source_id: string | null;
	readonly source_path: string | null;
	readonly source_root: string | null;
	readonly created_by: string;
	readonly applied_by: string | null;
	readonly rejected_by: string | null;
	readonly result: string | null;
	readonly created_at: string;
	readonly updated_at: string;
	readonly applied_at: string | null;
	readonly rejected_at: string | null;
};

export interface CreateOntologyProposalInput {
	readonly agentId: string;
	readonly operation: string;
	readonly payload: Readonly<Record<string, unknown>>;
	readonly confidence?: number;
	readonly rationale?: string;
	readonly evidence?: readonly unknown[];
	readonly risk?: string | null;
	readonly sourceKind?: string | null;
	readonly sourceId?: string | null;
	readonly sourcePath?: string | null;
	readonly sourceRoot?: string | null;
	readonly createdBy?: string;
}

export interface CreateOntologyProposalsResult {
	readonly items: readonly OntologyProposal[];
	readonly count: number;
}

export type OntologyProposalEvidenceItem = OntologyEvidenceItem;

export interface OntologyProposalEvidenceResult {
	readonly proposal: OntologyProposal;
	readonly items: readonly OntologyProposalEvidenceItem[];
	readonly count: number;
}

export interface OntologyProposalConflictValue {
	readonly proposalId: string;
	readonly value: string;
	readonly confidence: number;
	readonly rationale: string;
	readonly evidenceCount: number;
}

export interface OntologyProposalConflict {
	readonly entity: string;
	readonly aspect: string;
	readonly groupKey: string;
	readonly claimKey: string;
	readonly values: readonly OntologyProposalConflictValue[];
	readonly proposalIds: readonly string[];
	readonly count: number;
}

export interface OntologyProposalConflictsResult {
	readonly items: readonly OntologyProposalConflict[];
	readonly count: number;
}

export interface DuplicateEntityRef {
	readonly id: string;
	readonly name: string;
	readonly canonicalName: string;
	readonly entityType: string;
	readonly mentions: number;
	readonly pinned: boolean;
	readonly updatedAt: string;
}

export interface DuplicateEntityMergeCandidate {
	readonly operation: "merge_entities";
	readonly canonicalName: string;
	readonly target: DuplicateEntityRef;
	readonly sources: readonly DuplicateEntityRef[];
	readonly payload: Readonly<Record<string, unknown>>;
	readonly impact: EntityMergeImpact;
	readonly warnings: readonly string[];
	readonly blocked: boolean;
	readonly confidence: number;
	readonly rationale: string;
	readonly evidence: readonly unknown[];
	readonly risk: "low" | "review_required" | "blocked";
}

export interface DuplicateEntityMergeResult {
	readonly items: readonly DuplicateEntityMergeCandidate[];
	readonly proposals: readonly OntologyProposal[];
	readonly count: number;
	readonly writtenCount: number;
	readonly skippedCount: number;
	readonly dryRun: boolean;
}

export interface EntityMergeImpact {
	readonly sourceMentions: number;
	readonly memoryMentions: number;
	readonly aspects: number;
	readonly attributes: number;
	readonly dependencies: number;
	readonly relations: number;
}

export interface EntityMergePlanParams {
	readonly agentId: string;
	readonly targetEntity?: string;
	readonly targetEntityId?: string;
	readonly sourceEntities?: readonly string[];
	readonly sourceEntityIds?: readonly string[];
	readonly force?: boolean;
	readonly writeProposal?: boolean;
	readonly createdBy?: string;
	readonly rationale?: string;
	readonly evidence?: readonly unknown[];
}

export interface EntityMergePlanResult {
	readonly operation: "merge_entities";
	readonly target: DuplicateEntityRef;
	readonly sources: readonly DuplicateEntityRef[];
	readonly payload: Readonly<Record<string, unknown>>;
	readonly impact: EntityMergeImpact;
	readonly warnings: readonly string[];
	readonly blocked: boolean;
	readonly confidence: number;
	readonly rationale: string;
	readonly evidence: readonly unknown[];
	readonly risk: "low" | "review_required" | "blocked";
	readonly dryRun: boolean;
	readonly proposal?: OntologyProposal;
}

export interface ListOntologyProposalsParams {
	readonly agentId: string;
	readonly status?: OntologyProposalStatus;
	readonly operation?: string;
	readonly limit?: number;
	readonly offset?: number;
}

export interface ApplyOntologyProposalParams {
	readonly agentId: string;
	readonly id: string;
	readonly actor: string;
	readonly writeCaps?: GraphWriteCaps;
}

export interface RejectOntologyProposalParams extends ApplyOntologyProposalParams {
	readonly reason?: string;
}

export interface ProposeDuplicateEntityMergesParams {
	readonly agentId: string;
	readonly limit?: number;
	readonly writeProposals?: boolean;
	readonly createdBy?: string;
}

export interface FindDuplicateEntityMergesParams {
	readonly agentId: string;
	readonly name: string;
}

export interface OntologyOperationInput {
	readonly operation: string;
	readonly payload: Readonly<Record<string, unknown>>;
	readonly reason?: string;
	readonly evidence?: readonly unknown[];
	readonly confidence?: number;
	readonly risk?: string | null;
	readonly sourceKind?: string | null;
	readonly sourceId?: string | null;
	readonly sourcePath?: string | null;
	readonly sourceRoot?: string | null;
}

export interface ApplyOntologyOperationParams extends OntologyOperationInput {
	readonly agentId: string;
	readonly actor: string;
	readonly dryRun?: boolean;
	readonly propose?: boolean;
	readonly writeCaps?: GraphWriteCaps;
}

export interface ApplyOntologyOperationResult {
	readonly proposal: OntologyProposal;
	readonly result: Readonly<Record<string, unknown>> | null;
	readonly dryRun: boolean;
	readonly proposed: boolean;
}

export interface ApplyOntologyOperationBatchParams {
	readonly agentId: string;
	readonly actor: string;
	readonly operations: readonly OntologyOperationInput[];
	readonly dryRun?: boolean;
	readonly propose?: boolean;
	readonly writeCaps?: GraphWriteCaps;
}

export interface ApplyOntologyOperationBatchResult {
	readonly items: readonly ApplyOntologyOperationResult[];
	readonly errors?: readonly OntologyOperationBatchError[];
	readonly count: number;
	readonly dryRun: boolean;
	readonly proposed: boolean;
}

export interface OntologyOperationBatchError {
	readonly index: number;
	readonly line: number;
	readonly operation: string;
	readonly error: string;
	readonly status: 400 | 404 | 409;
}

/** Apply an audited operation batch inside a caller-owned transaction. */
export function applyOntologyOperationBatchInTx(
	db: WriteDb,
	params: Pick<ApplyOntologyOperationBatchParams, "agentId" | "actor" | "operations"> & {
		readonly writeCaps?: GraphWriteCaps;
	},
): ApplyOntologyOperationBatchResult {
	if (params.operations.length === 0) throw new OntologyProposalError("operations are required", 400);
	if (params.operations.length > 500)
		throw new OntologyProposalError("cannot apply more than 500 operations at once", 400);

	const items: ApplyOntologyOperationResult[] = [];
	for (const operation of params.operations) {
		const inserted = insertProposalInTx(
			db,
			{
				agentId: params.agentId,
				operation: operation.operation,
				payload: operation.payload,
				confidence: operation.confidence,
				rationale: operation.reason,
				evidence: operation.evidence,
				risk: operation.risk,
				sourceKind: operation.sourceKind,
				sourceId: operation.sourceId,
				sourcePath: operation.sourcePath,
				sourceRoot: operation.sourceRoot,
				createdBy: params.actor,
			},
			now(),
		);
		const row = getProposalInTx(db, inserted.id, params.agentId);
		if (row === null) throw new OntologyProposalError("Proposal not found", 404);
		const result = applyOperation(db, row, params.actor, params.writeCaps);
		items.push({
			proposal: markAppliedInTx(db, row, params.actor, result),
			result,
			dryRun: false,
			proposed: false,
		});
	}
	return { items, count: items.length, dryRun: false, proposed: false };
}

export interface ClaimVersionReadParams {
	readonly agentId: string;
	readonly entity: string;
	readonly aspect: string;
	readonly group: string;
	readonly claim: string;
	readonly kind?: AttributeKind;
}

export interface ClaimVersionItem {
	readonly id: string;
	readonly version: number;
	readonly versionRootId: string;
	readonly previousAttributeId: string | null;
	readonly content: string;
	readonly status: string;
	readonly confidence: number;
	readonly proposalId: string | null;
	readonly sourceKind: string | null;
	readonly sourceId: string | null;
	readonly sourcePath: string | null;
	readonly createdAt: string;
	readonly updatedAt: string;
}

export class OntologyProposalError extends Error {
	constructor(
		message: string,
		readonly status: 400 | 404 | 409,
	) {
		super(message);
		this.name = "OntologyProposalError";
	}
}

/** Write-path caps enforced before add_claim_value/create_aspect. */
export interface GraphWriteCaps {
	readonly maxAspectsPerEntity: number;
	readonly maxAttributesPerAspect: number;
}

function now(): string {
	return new Date().toISOString();
}

function canonical(value: string): string {
	return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonRecord(value: string): Readonly<Record<string, unknown>> {
	const parsed: unknown = JSON.parse(value);
	return isRecord(parsed) ? parsed : {};
}

function parseJsonArray(value: string): readonly unknown[] {
	const parsed: unknown = JSON.parse(value);
	return Array.isArray(parsed) ? parsed : [];
}

function parseOptionalJsonRecord(value: string | null): Readonly<Record<string, unknown>> | null {
	if (value === null) return null;
	const parsed = parseJsonRecord(value);
	return Object.keys(parsed).length > 0 ? parsed : null;
}

function toProposal(row: ProposalRow): OntologyProposal {
	return {
		id: row.id,
		agentId: row.agent_id,
		operation: row.operation,
		status: row.status,
		payload: parseJsonRecord(row.payload),
		confidence: row.confidence,
		rationale: row.rationale,
		evidence: parseJsonArray(row.evidence),
		risk: row.risk,
		sourceKind: row.source_kind,
		sourceId: row.source_id,
		sourcePath: row.source_path,
		sourceRoot: row.source_root,
		createdBy: row.created_by,
		appliedBy: row.applied_by,
		rejectedBy: row.rejected_by,
		result: parseOptionalJsonRecord(row.result),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		appliedAt: row.applied_at,
		rejectedAt: row.rejected_at,
	};
}

function readString(record: Readonly<Record<string, unknown>>, key: string): string | null {
	const value = record[key];
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function readReviewAfter(payload: Readonly<Record<string, unknown>>): string | null {
	const value = readString(payload, "review_after");
	if (value === null) return null;
	const parsed = new Date(value);
	if (Number.isNaN(parsed.getTime())) {
		throw new OntologyProposalError("payload.review_after must be a valid ISO timestamp", 400);
	}
	return parsed.toISOString();
}

function readNumber(record: Readonly<Record<string, unknown>>, key: string): number | null {
	const value = record[key];
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readStringArray(record: Readonly<Record<string, unknown>>, key: string): readonly string[] {
	const value = record[key];
	if (!Array.isArray(value)) return [];
	return value
		.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
		.map((item) => item.trim());
}

function unique(values: readonly string[]): string[] {
	return [...new Set(values)];
}

function clamp01(value: number | undefined): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return 0;
	return Math.max(0, Math.min(1, value));
}

function requireText(value: string, field: string): string {
	const trimmed = value.trim();
	if (trimmed.length === 0) throw new OntologyProposalError(`${field} is required`, 400);
	return trimmed;
}

function normalizeStatus(value: string | undefined): OntologyProposalStatus | undefined {
	return ONTOLOGY_PROPOSAL_STATUSES.includes(value as OntologyProposalStatus)
		? (value as OntologyProposalStatus)
		: undefined;
}

export function parseOntologyProposalStatus(value: string | undefined): OntologyProposalStatus | undefined {
	return normalizeStatus(value);
}

function normalizeEntityType(value: string | null): EntityType {
	if (value !== null && ENTITY_TYPES.includes(value as EntityType)) return value as EntityType;
	return "unknown";
}

function normalizeAttributeKind(value: string | null): AttributeKind {
	if (value !== null && ATTRIBUTE_KINDS.includes(value as AttributeKind)) return value as AttributeKind;
	return "attribute";
}

function normalizeDependencyType(value: string | null): DependencyType {
	if (value !== null && DEPENDENCY_TYPES.includes(value as DependencyType)) return value as DependencyType;
	throw new OntologyProposalError("payload.link_type must be a supported dependency type", 400);
}

function getProposalInTx(db: WriteDb, id: string, agentId: string): ProposalRow | null {
	const row = db.prepare("SELECT * FROM ontology_proposals WHERE id = ? AND agent_id = ?").get(id, agentId) as
		| ProposalRow
		| undefined;
	return row ?? null;
}

function getProposalReadRow(accessor: DbAccessor, id: string, agentId: string): ProposalRow | null {
	return accessor.withReadDb((db) => {
		const row = db.prepare("SELECT * FROM ontology_proposals WHERE id = ? AND agent_id = ?").get(id, agentId) as
			| ProposalRow
			| undefined;
		return row ?? null;
	});
}

function readBackInTx(db: WriteDb, id: string, agentId: string): OntologyProposal {
	const row = getProposalInTx(db, id, agentId);
	if (row === null) throw new OntologyProposalError("Proposal not found", 404);
	return toProposal(row);
}

function insertProposalInTx(db: WriteDb, input: CreateOntologyProposalInput, ts: string): OntologyProposal {
	const id = crypto.randomUUID();
	const agentId = requireText(input.agentId, "agentId");
	const operation = requireText(input.operation, "operation");
	if (Object.keys(input.payload).length === 0) throw new OntologyProposalError("payload is required", 400);
	const evidence = input.evidence ?? [];
	db.prepare(
		`INSERT INTO ontology_proposals
		 (id, agent_id, operation, status, payload, confidence, rationale,
		  evidence, risk, source_kind, source_id, source_path, source_root,
		  created_by, created_at, updated_at)
		 VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		id,
		agentId,
		operation,
		JSON.stringify(input.payload),
		clamp01(input.confidence),
		input.rationale?.trim() ?? "",
		JSON.stringify(evidence),
		input.risk ?? null,
		input.sourceKind ?? null,
		input.sourceId ?? null,
		input.sourcePath ?? null,
		input.sourceRoot ?? null,
		input.createdBy?.trim() || "operator",
		ts,
		ts,
	);
	return readBackInTx(db, id, agentId);
}

function proposalEvidenceRefs(proposal: OntologyProposal): OntologyEvidenceRef[] {
	const refs = proposal.evidence.map(readOntologyEvidenceRef).filter((ref): ref is OntologyEvidenceRef => ref !== null);
	if (proposal.sourceId || proposal.sourcePath || proposal.sourceKind) {
		refs.push({
			sourceKind: proposal.sourceKind,
			sourceId: proposal.sourceId,
			sourcePath: proposal.sourcePath,
			memoryId: null,
			quote: null,
			reference: {
				source_kind: proposal.sourceKind,
				source_id: proposal.sourceId,
				source_path: proposal.sourcePath,
				source_root: proposal.sourceRoot,
			},
		});
	}
	return uniqueOntologyEvidenceRefs(refs);
}

function proposalAuditEvidence(proposal: ProposalRow): readonly unknown[] {
	return parseJsonArray(proposal.evidence);
}

/**
 * The graph keeps connector/source ownership separately on its rows. Derived
 * memory lineage instead keys on the immutable record named by source_ref, so
 * corrections to that record can invalidate every dependent semantic row.
 */
function derivedMemorySourcesForProposal(proposal: ProposalRow): readonly {
	readonly sourceKind: string;
	readonly sourceId: string;
	readonly sourcePath: string | null;
}[] {
	const sources: Array<{ sourceKind: string; sourceId: string; sourcePath: string | null }> = [];
	for (const ref of proposalEvidenceRefs(toProposal(proposal))) {
		if (typeof ref.reference !== "object" || ref.reference === null || Array.isArray(ref.reference)) continue;
		const sourceRef = readString(ref.reference as Readonly<Record<string, unknown>>, "source_ref");
		if (sourceRef === null) continue;
		const separator = sourceRef.indexOf(":");
		if (separator <= 0 || separator === sourceRef.length - 1) continue;
		const sourceKind = sourceRef.slice(0, separator);
		const sourceId = sourceRef.slice(separator + 1);
		if (!(["memory", "artifact", "transcript", "summary"] as const).includes(sourceKind as "memory")) continue;
		sources.push({ sourceKind, sourceId, sourcePath: ref.sourcePath });
	}
	return sources;
}

function canonicalKey(value: string | null): string | null {
	if (value === null) return null;
	const key = canonical(value).replace(/\s+/g, "_");
	return key.length > 0 ? key : null;
}

function truthy(value: unknown): boolean {
	return value === true || value === 1 || value === "1" || value === "true";
}

function readPayloadSelector(payload: Readonly<Record<string, unknown>>, ...keys: readonly string[]): string | null {
	for (const key of keys) {
		const value = readString(payload, key);
		if (value !== null) return value;
	}
	return null;
}

function resolveEntityStrict(
	db: WriteDb,
	agentId: string,
	selector: string,
): { readonly id: string; readonly name: string } {
	const key = canonical(selector);
	const rows = db
		.prepare(
			`SELECT id, name FROM entities
			 WHERE agent_id = ?
			   AND COALESCE(status, 'active') = 'active'
			   AND (id = ? OR COALESCE(canonical_name, LOWER(name)) = ? OR LOWER(name) = ?)
			 ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END, updated_at DESC, name ASC`,
		)
		.all(agentId, selector, key, key, selector) as Array<{ id: string; name: string }>;
	if (rows.length === 0) throw new OntologyProposalError(`Entity not found: ${selector}`, 404);
	if (rows.length > 1) throw new OntologyProposalError(`Entity selector is ambiguous: ${selector}. Use an id.`, 409);
	return rows[0] as { id: string; name: string };
}

function resolveAspectStrict(
	db: WriteDb,
	agentId: string,
	entityId: string,
	selector: string,
): { readonly id: string; readonly name: string } {
	const key = canonical(selector);
	const rows = db
		.prepare(
			`SELECT id, name FROM entity_aspects
			 WHERE entity_id = ?
			   AND agent_id = ?
			   AND COALESCE(status, 'active') = 'active'
			   AND (id = ? OR canonical_name = ? OR LOWER(name) = ?)
			 ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END, updated_at DESC, name ASC`,
		)
		.all(entityId, agentId, selector, key, key, selector) as Array<{ id: string; name: string }>;
	if (rows.length === 0) throw new OntologyProposalError(`Aspect not found: ${selector}`, 404);
	if (rows.length > 1) throw new OntologyProposalError(`Aspect selector is ambiguous: ${selector}. Use an id.`, 409);
	return rows[0] as { id: string; name: string };
}

function resolveEntity(db: WriteDb, agentId: string, name: string): string | null {
	const key = canonical(name);
	const row = db
		.prepare(
			`SELECT id FROM entities
			 WHERE agent_id = ?
			   AND COALESCE(status, 'active') = 'active'
			   AND (COALESCE(canonical_name, LOWER(name)) = ? OR LOWER(name) = ?)
			 ORDER BY updated_at DESC, name ASC
			 LIMIT 2`,
		)
		.all(agentId, key, key) as Array<{ id: string }>;
	if (row.length > 1) throw new OntologyProposalError(`Entity selector is ambiguous: ${name}. Use an id.`, 409);
	return row[0]?.id ?? null;
}

function resolveOrCreateEntity(db: WriteDb, agentId: string, name: string, type: EntityType): string {
	const existing = resolveEntity(db, agentId, name);
	if (existing !== null) return existing;
	const quality = classifyEntityQuality(name);
	if (!quality.ok) throw new OntologyProposalError(`Entity name rejected: ${quality.reason}`, 400);
	const id = crypto.randomUUID();
	db.prepare(
		`INSERT INTO entities
		 (id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, 0, datetime('now'), datetime('now'))`,
	).run(id, name.trim(), canonical(name), type, agentId);
	return id;
}

function resolveOrCreateAspect(db: WriteDb, entityId: string, agentId: string, name: string): string {
	const key = canonical(name);
	const existing = db
		.prepare(
			`SELECT id, status FROM entity_aspects
			 WHERE entity_id = ? AND agent_id = ? AND canonical_name = ?
			 LIMIT 1`,
		)
		.get(entityId, agentId, key) as { id: string; status: string | null } | undefined;
	if (existing) {
		if ((existing.status ?? "active") !== "active") {
			db.prepare(
				`UPDATE entity_aspects
				 SET status = 'active', archived_at = NULL, archived_by = NULL,
				     archive_reason = NULL, updated_at = datetime('now')
				 WHERE id = ? AND agent_id = ?`,
			).run(existing.id, agentId);
		}
		return existing.id;
	}

	const id = crypto.randomUUID();
	db.prepare(
		`INSERT INTO entity_aspects
		 (id, entity_id, agent_id, name, canonical_name, weight, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, 0.5, datetime('now'), datetime('now'))`,
	).run(id, entityId, agentId, name.trim(), key);
	return id;
}

function resolveAspect(db: WriteDb, entityId: string, agentId: string, name: string): string | null {
	const key = canonical(name);
	const row = db
		.prepare(
			`SELECT id FROM entity_aspects
			 WHERE entity_id = ? AND agent_id = ? AND canonical_name = ?
			 LIMIT 1`,
		)
		.get(entityId, agentId, key) as { id: string } | undefined;
	return row?.id ?? null;
}

function applyCreateEntity(
	db: WriteDb,
	agentId: string,
	proposal: ProposalRow,
	payload: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
	const name = readString(payload, "name");
	if (name === null) throw new OntologyProposalError("payload.name is required", 400);
	const existingEntityId = resolveEntity(db, agentId, name);
	const entityId =
		existingEntityId ??
		resolveOrCreateEntity(db, agentId, name, normalizeEntityType(readString(payload, "entity_type")));
	const proposalEvidence = JSON.stringify(proposalAuditEvidence(proposal));
	if (existingEntityId !== null) {
		// Never turn a previously user-owned or differently sourced entity into a
		// source-owned row merely because new evidence mentions it.
		db.prepare(
			`UPDATE entities
			 SET proposal_id = ?, proposal_evidence = ?, updated_at = datetime('now')
			 WHERE id = ? AND agent_id = ?`,
		).run(proposal.id, proposalEvidence, entityId, agentId);
	} else {
		db.prepare(
			`UPDATE entities
			 SET proposal_id = ?, proposal_evidence = ?, source_id = ?, source_kind = ?,
			     source_path = ?, source_root = ?, updated_at = datetime('now')
			 WHERE id = ? AND agent_id = ?`,
		).run(
			proposal.id,
			proposalEvidence,
			proposal.source_id,
			proposal.source_kind,
			proposal.source_path,
			proposal.source_root,
			entityId,
			agentId,
		);
	}
	return { entityId, entity: name };
}

/**
 * Policies are durable constraints on the entity they govern. Keeping them as
 * claims preserves their evidence, versioning, and existing constraint guards
 * rather than introducing a second policy store.
 */
function applyCreatePolicy(
	db: WriteDb,
	agentId: string,
	proposal: ProposalRow,
	payload: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
	const target = readPayloadSelector(payload, "target_entity", "entity", "entity_id");
	const policyKind = readString(payload, "kind");
	const content = readString(payload, "content");
	if (target === null) throw new OntologyProposalError("payload.target_entity is required", 400);
	if (policyKind === null) throw new OntologyProposalError("payload.kind is required", 400);
	if (content === null) throw new OntologyProposalError("payload.content is required", 400);
	const result = applyAddClaimValue(db, agentId, proposal, {
		entity: target,
		entity_type: readString(payload, "entity_type") ?? undefined,
		aspect: "policy",
		group_key: "policy",
		claim_key: canonicalKey(policyKind) ?? policyKind,
		value: content,
		kind: "constraint",
		confidence: readNumber(payload, "confidence") ?? proposal.confidence,
		importance: readNumber(payload, "importance") ?? proposal.confidence,
	});
	return { ...result, policyKind, policy: content };
}

function applyCreateActionType(
	db: WriteDb,
	agentId: string,
	proposal: ProposalRow,
	payload: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
	const name = readString(payload, "name") ?? readString(payload, "action_type");
	if (name === null) throw new OntologyProposalError("payload.name is required", 400);
	return applyCreateEntity(db, agentId, proposal, { name, entity_type: "action" });
}

function applyCreateInterface(
	db: WriteDb,
	agentId: string,
	proposal: ProposalRow,
	payload: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
	const name = readString(payload, "name") ?? readString(payload, "interface");
	if (name === null) throw new OntologyProposalError("payload.name is required", 400);
	return applyCreateEntity(db, agentId, proposal, { name, entity_type: "interface" });
}

/** Attach a concrete entity to an interface using the existing typed edge. */
function applyAttachInterface(
	db: WriteDb,
	agentId: string,
	proposal: ProposalRow,
	payload: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
	const entity = readPayloadSelector(payload, "entity", "source_entity", "target_entity");
	const interfaceName = readPayloadSelector(payload, "interface", "interface_name", "target_interface");
	if (entity === null) throw new OntologyProposalError("payload.entity is required", 400);
	if (interfaceName === null) throw new OntologyProposalError("payload.interface is required", 400);
	return applyCreateLink(db, agentId, proposal, {
		source_entity: entity,
		target_entity: interfaceName,
		target_type: "interface",
		link_type: "implements",
		reason: readString(payload, "reason") ?? proposal.rationale,
		strength: readNumber(payload, "strength") ?? 0.5,
		confidence: readNumber(payload, "confidence") ?? proposal.confidence,
	});
}

/**
 * An active claim value is a first-class semantic memory, not merely a graph
 * decoration. The attribute and its retrievable memory intentionally share a
 * durable id and are created in the same ontology apply transaction.
 */
function materializeAttributeMemoryInTx(
	db: WriteDb,
	input: {
		readonly attributeId: string;
		readonly entityId: string;
		readonly agentId: string;
		readonly content: string;
		readonly normalizedContent: string;
		readonly importance: number;
		readonly reviewAfter: string | null;
		readonly proposal: ProposalRow;
	},
): string {
	const existing = db.prepare("SELECT id FROM memories WHERE id = ?").get(input.attributeId) as
		| { id: string }
		| undefined;
	if (!existing) {
		txIngestEnvelope(db, {
			id: input.attributeId,
			content: input.content,
			normalizedContent: input.normalizedContent,
			// Claim identity, rather than raw text, is the deduplication unit: two
			// independently maintained claims may legitimately render the same text.
			contentHash: `semantic-attribute:${input.attributeId}`,
			who: "dreaming",
			why: input.proposal.rationale || null,
			project: null,
			importance: input.importance,
			type: "semantic",
			tags: "semantic,attribute",
			pinned: 0,
			extractionStatus: "completed",
			updatedBy: "dreaming",
			memoryKind: "derived",
			sourceType: "dreaming",
			sourceId: input.proposal.source_id,
			sourcePath: input.proposal.source_path,
			agentId: input.agentId,
			visibility: "global",
			reviewAfter: input.reviewAfter,
			createdAt: now(),
		});
	}
	db.prepare("UPDATE entity_attributes SET memory_id = ? WHERE id = ? AND agent_id = ?").run(
		input.attributeId,
		input.attributeId,
		input.agentId,
	);
	db.prepare("INSERT OR IGNORE INTO memory_entity_mentions (memory_id, entity_id) VALUES (?, ?)").run(
		input.attributeId,
		input.entityId,
	);
	db.prepare(
		`UPDATE entities
		 SET mentions = (SELECT COUNT(*) FROM memory_entity_mentions WHERE entity_id = entities.id)
		 WHERE id = ? AND agent_id = ?`,
	).run(input.entityId, input.agentId);
	linkDerivedMemorySourcesInTx(db, {
		derivedMemoryId: input.attributeId,
		agentId: input.agentId,
		sources: derivedMemorySourcesForProposal(input.proposal),
		createdAt: now(),
	});
	return input.attributeId;
}

function supersedeAttributeMemoryInTx(
	db: WriteDb,
	input: { readonly memoryId: string | null; readonly replacementMemoryId: string; readonly proposal: ProposalRow },
): void {
	if (!input.memoryId || input.memoryId === input.replacementMemoryId) return;
	const result = txSupersedeMemory(db, {
		memoryId: input.memoryId,
		supersededBy: input.replacementMemoryId,
		reason: input.proposal.rationale || null,
		changedBy: "dreaming",
		changedAt: now(),
	});
	if (result.status !== "superseded" && result.status !== "already_superseded") {
		throw new OntologyProposalError(`Unable to supersede semantic memory: ${result.status}`, 409);
	}
	markDerivedMemoriesStaleForSourceInTx(db, {
		sourceKind: "ontology_claim",
		sourceId: input.memoryId,
		agentId: input.proposal.agent_id,
		staleAt: now(),
	});
}

function archiveAttributeMemoryInTx(db: WriteDb, memoryId: string | null, proposal: ProposalRow, force: boolean): void {
	if (!memoryId) return;
	const result = txForgetMemory(db, {
		memoryId,
		reason: proposal.rationale || "Semantic claim archived",
		changedBy: "dreaming",
		changedAt: now(),
		force,
	});
	if (result.status === "pinned_requires_force") {
		throw new OntologyProposalError("Refusing to archive a claim whose semantic memory is pinned", 409);
	}
	if (result.status !== "deleted" && result.status !== "already_deleted") {
		throw new OntologyProposalError(`Unable to archive semantic memory: ${result.status}`, 409);
	}
	markDerivedMemoriesStaleForSourceInTx(db, {
		sourceKind: "ontology_claim",
		sourceId: memoryId,
		agentId: proposal.agent_id,
		staleAt: now(),
	});
}

function restoreAttributeMemoryInTx(db: WriteDb, memoryId: string | null, proposal: ProposalRow): void {
	if (!memoryId) return;
	const memory = db.prepare("SELECT id, content, is_deleted, superseded_by FROM memories WHERE id = ?").get(memoryId) as
		| { id: string; content: string; is_deleted: number; superseded_by: string | null }
		| undefined;
	if (!memory) return;
	if (memory.is_deleted === 0 && memory.superseded_by === null) return;
	const changedAt = now();
	db.prepare(
		`UPDATE memories
		 SET is_deleted = 0, deleted_at = NULL, superseded_by = NULL, superseded_at = NULL,
		     superseded_reason = NULL, updated_at = ?, updated_by = 'dreaming', version = version + 1
		 WHERE id = ?`,
	).run(changedAt, memoryId);
	insertHistoryEvent(db, {
		memoryId,
		event: "recovered",
		oldContent: null,
		newContent: memory.content,
		changedBy: "dreaming",
		reason: proposal.rationale || "Semantic claim restored",
		metadata: JSON.stringify({ previousSupersededBy: memory.superseded_by }),
		createdAt: changedAt,
	});
}

function applyAddClaimValue(
	db: WriteDb,
	agentId: string,
	proposal: ProposalRow,
	payload: Readonly<Record<string, unknown>>,
	writeCaps?: GraphWriteCaps,
): Readonly<Record<string, unknown>> {
	const entity = readString(payload, "entity");
	const aspect = readString(payload, "aspect");
	const claimKey = readString(payload, "claim_key");
	const value = readString(payload, "value");
	if (entity === null) throw new OntologyProposalError("payload.entity is required", 400);
	if (aspect === null) throw new OntologyProposalError("payload.aspect is required", 400);
	if (claimKey === null) throw new OntologyProposalError("payload.claim_key is required", 400);
	if (value === null) throw new OntologyProposalError("payload.value is required", 400);

	const entityId = resolveOrCreateEntity(db, agentId, entity, normalizeEntityType(readString(payload, "entity_type")));
	// E1 fix (#1147 review): add_claim_value resolves-or-creates the aspect,
	// so a new aspect name would bypass the aspect cap. Guard it the same way
	// create_aspect does.
	const addEntityRow = db.prepare("SELECT id, name FROM entities WHERE id = ?").get(entityId) as
		| { id: string; name: string }
		| undefined;
	if (addEntityRow !== undefined) enforceAspectCapForNewAspect(db, addEntityRow, agentId, aspect, writeCaps);
	const aspectId = resolveOrCreateAspect(db, entityId, agentId, aspect);
	const groupKey = readString(payload, "group_key") ?? "general";
	const kind = normalizeAttributeKind(readString(payload, "kind"));
	const normalized = canonical(value);
	const existing = db
		.prepare(
			`SELECT id FROM entity_attributes
			 WHERE aspect_id = ?
			   AND agent_id = ?
			   AND kind = ?
			   AND normalized_content = ?
			   AND COALESCE(group_key, 'general') = ?
			   AND claim_key = ?
			   AND status = 'active'
			 LIMIT 1`,
		)
		.get(aspectId, agentId, kind, normalized, groupKey, claimKey) as { id: string } | undefined;
	if (existing) {
		return { entityId, aspectId, attributeId: existing.id, deduped: true };
	}

	if (writeCaps !== undefined) {
		const attrCount = db
			.prepare(
				`SELECT COUNT(*) AS c FROM entity_attributes
				 WHERE aspect_id = ? AND agent_id = ? AND status = 'active'`,
			)
			.get(aspectId, agentId) as { c: number };
		if (attrCount.c >= writeCaps.maxAttributesPerAspect) {
			const aspectName = db.prepare("SELECT name FROM entity_aspects WHERE id = ?").get(aspectId) as
				| { name: string }
				| undefined;
			throw new OntologyProposalError(
				`aspect '${aspectName?.name ?? aspectId}' is at attribute cap (${attrCount.c}/${writeCaps.maxAttributesPerAspect}) — supersede or expire an existing claim, or consolidate duplicates, before adding`,
				409,
			);
		}
	}

	const id = crypto.randomUUID();
	const confidence = clamp01(readNumber(payload, "confidence") ?? proposal.confidence);
	const importance = clamp01(readNumber(payload, "importance") ?? confidence);
	const reviewAfter = readReviewAfter(payload);
	const proposalEvidence = proposalAuditEvidence(proposal);
	db.prepare(
		`INSERT INTO entity_attributes
		 (id, aspect_id, agent_id, kind, content, normalized_content,
		  confidence, importance, status, group_key, claim_key,
		  version, version_root_id, previous_attribute_id,
		  created_at, updated_at, source_id, source_kind, source_path, source_root,
		  proposal_id, proposal_evidence)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?,
		         1, ?, NULL,
		         datetime('now'), datetime('now'), ?, ?, ?, ?, ?, ?)`,
	).run(
		id,
		aspectId,
		agentId,
		kind,
		value,
		normalized,
		confidence,
		importance,
		groupKey,
		claimKey,
		id,
		proposal.source_id,
		proposal.source_kind,
		proposal.source_path,
		proposal.source_root,
		proposal.id,
		JSON.stringify(proposalEvidence),
	);
	const memoryId = materializeAttributeMemoryInTx(db, {
		attributeId: id,
		entityId,
		agentId,
		content: value,
		normalizedContent: normalized,
		importance,
		reviewAfter,
		proposal,
	});
	return { entityId, aspectId, attributeId: id, memoryId, deduped: false };
}

function applySetClaimValue(
	db: WriteDb,
	agentId: string,
	proposal: ProposalRow,
	payload: Readonly<Record<string, unknown>>,
	writeCaps?: GraphWriteCaps,
): Readonly<Record<string, unknown>> {
	const entity = readString(payload, "entity");
	const aspect = readString(payload, "aspect");
	const claimKey = canonicalKey(readString(payload, "claim_key") ?? readString(payload, "claim"));
	const value = readString(payload, "value");
	if (entity === null) throw new OntologyProposalError("payload.entity is required", 400);
	if (aspect === null) throw new OntologyProposalError("payload.aspect is required", 400);
	if (claimKey === null) throw new OntologyProposalError("payload.claim_key is required", 400);
	if (value === null) throw new OntologyProposalError("payload.value is required", 400);

	const entityId = resolveOrCreateEntity(db, agentId, entity, normalizeEntityType(readString(payload, "entity_type")));
	const aspectId = resolveOrCreateAspect(db, entityId, agentId, aspect);
	const groupKey = canonicalKey(readString(payload, "group_key") ?? readString(payload, "group")) ?? "general";
	const kind = normalizeAttributeKind(readString(payload, "kind"));
	const slot = db
		.prepare(
			`SELECT id, memory_id, content, normalized_content, version, version_root_id, kind, status
			 FROM entity_attributes
			 WHERE aspect_id = ?
			   AND agent_id = ?
			   AND kind = ?
			   AND COALESCE(group_key, 'general') = ?
			   AND claim_key = ?
			 ORDER BY version DESC, updated_at DESC`,
		)
		.all(aspectId, agentId, kind, groupKey, claimKey) as Array<{
		id: string;
		memory_id: string | null;
		content: string;
		normalized_content: string;
		version: number | null;
		version_root_id: string | null;
		kind: string;
		status: string;
	}>;
	const active = slot.filter((row) => row.status === "active");
	const normalized = canonical(value);
	const existing = active.find((row) => row.normalized_content === normalized);
	if (existing && active.length === 1) {
		return {
			entityId,
			aspectId,
			attributeId: existing.id,
			version: existing.version ?? 1,
			versionRootId: existing.version_root_id ?? existing.id,
			deduped: true,
		};
	}
	if (kind === "constraint" && active.length > 0 && !truthy(payload.force)) {
		throw new OntologyProposalError("Refusing to replace active constraint claim without force", 409);
	}

	const previous = active[0] ?? slot[0] ?? null;
	// E2 fix (#1147 review): set_claim_value with a brand-new claim_key
	// inserts a new attribute row, bypassing the attribute cap. Replacing an
	// existing active slot does not grow the count, so the guard only fires
	// when this write would add a new row.
	if (previous === null && writeCaps !== undefined) {
		const attrCount = db
			.prepare(
				`SELECT COUNT(*) AS c FROM entity_attributes
				 WHERE aspect_id = ? AND agent_id = ? AND status = 'active'`,
			)
			.get(aspectId, agentId) as { c: number };
		if (attrCount.c >= writeCaps.maxAttributesPerAspect) {
			const aspectName = db.prepare("SELECT name FROM entity_aspects WHERE id = ?").get(aspectId) as
				| { name: string }
				| undefined;
			throw new OntologyProposalError(
				`aspect '${aspectName?.name ?? aspectId}' is at attribute cap (${attrCount.c}/${writeCaps.maxAttributesPerAspect}) — supersede or expire an existing claim, or consolidate duplicates, before adding`,
				409,
			);
		}
	}
	const version = previous === null ? 1 : Math.max(...slot.map((row) => row.version ?? 1)) + 1;
	const rootId = previous?.version_root_id ?? previous?.id ?? crypto.randomUUID();
	const id = version === 1 ? rootId : crypto.randomUUID();
	const confidence = clamp01(readNumber(payload, "confidence") ?? proposal.confidence);
	const importance = clamp01(readNumber(payload, "importance") ?? confidence);
	const reviewAfter = readReviewAfter(payload);
	db.prepare(
		`INSERT INTO entity_attributes
		 (id, aspect_id, agent_id, kind, content, normalized_content,
		  confidence, importance, status, group_key, claim_key,
		  version, version_root_id, previous_attribute_id,
		  created_at, updated_at, source_id, source_kind, source_path, source_root,
		  proposal_id, proposal_evidence)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?,
		         datetime('now'), datetime('now'), ?, ?, ?, ?, ?, ?)`,
	).run(
		id,
		aspectId,
		agentId,
		kind,
		value,
		normalized,
		confidence,
		importance,
		groupKey,
		claimKey,
		version,
		rootId,
		previous?.id ?? null,
		proposal.source_id,
		proposal.source_kind,
		proposal.source_path,
		proposal.source_root,
		proposal.id,
		JSON.stringify(proposalAuditEvidence(proposal)),
	);
	const memoryId = materializeAttributeMemoryInTx(db, {
		attributeId: id,
		entityId,
		agentId,
		content: value,
		normalizedContent: normalized,
		importance,
		reviewAfter,
		proposal,
	});

	if (active.length > 0) {
		db.prepare(
			`UPDATE entity_attributes
			 SET status = 'superseded', superseded_by = ?, updated_at = datetime('now')
			 WHERE agent_id = ?
			   AND aspect_id = ?
			   AND kind = ?
			   AND COALESCE(group_key, 'general') = ?
			   AND claim_key = ?
			   AND status = 'active'
			   AND id != ?`,
		).run(id, agentId, aspectId, kind, groupKey, claimKey, id);
		for (const prior of active) {
			supersedeAttributeMemoryInTx(db, { memoryId: prior.memory_id, replacementMemoryId: memoryId, proposal });
		}
	}

	return {
		entityId,
		aspectId,
		attributeId: id,
		memoryId,
		version,
		versionRootId: rootId,
		previousAttributeId: previous?.id ?? null,
		previousWasActive: previous?.status === "active",
		supersededAttributeIds: active.map((row) => row.id),
	};
}

function applySupersedeClaimValue(
	db: WriteDb,
	agentId: string,
	proposal: ProposalRow,
	payload: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
	const entity = readString(payload, "entity");
	const aspect = readString(payload, "aspect");
	const claimKey = readString(payload, "claim_key");
	if (entity === null) throw new OntologyProposalError("payload.entity is required", 400);
	if (aspect === null) throw new OntologyProposalError("payload.aspect is required", 400);
	if (claimKey === null) throw new OntologyProposalError("payload.claim_key is required", 400);

	const entityId = resolveEntity(db, agentId, entity);
	if (entityId === null) throw new OntologyProposalError("payload.entity was not found", 400);
	const aspectId = resolveAspect(db, entityId, agentId, aspect);
	if (aspectId === null) throw new OntologyProposalError("payload.aspect was not found", 400);

	const groupKey = readString(payload, "group_key") ?? "general";
	const kind = normalizeAttributeKind(readString(payload, "kind"));
	const attributeId = readString(payload, "attribute_id");
	const oldValue = readString(payload, "old_value");
	if (attributeId === null && oldValue === null) {
		throw new OntologyProposalError("payload.attribute_id or payload.old_value is required", 400);
	}

	const filters = ["aspect_id = ?", "agent_id = ?", "kind = ?", "claim_key = ?", "status = 'active'"];
	const args: unknown[] = [aspectId, agentId, kind, claimKey];
	if (attributeId !== null) {
		filters.push("id = ?");
		args.push(attributeId);
	} else if (oldValue !== null) {
		filters.push("normalized_content = ?");
		args.push(canonical(oldValue));
	}
	filters.push("COALESCE(group_key, 'general') = ?");
	args.push(groupKey);

	const rows = db
		.prepare(`SELECT id, memory_id FROM entity_attributes WHERE ${filters.join(" AND ")}`)
		.all(...args) as Array<{
		id: string;
		memory_id: string | null;
	}>;
	if (rows.length === 0) throw new OntologyProposalError("No active claim values matched supersession payload", 400);

	const replacementValue = readString(payload, "new_value");
	let replacementId: string | null = null;
	let replacementCreated = false;
	if (replacementValue !== null) {
		if (oldValue !== null && canonical(replacementValue) === canonical(oldValue)) {
			throw new OntologyProposalError("payload.new_value must differ from payload.old_value", 400);
		}
		const replacement = applySetClaimValue(db, agentId, proposal, {
			entity,
			aspect,
			claim_key: claimKey,
			group_key: groupKey,
			kind,
			value: replacementValue,
			confidence: readNumber(payload, "confidence") ?? proposal.confidence,
			importance: readNumber(payload, "importance") ?? readNumber(payload, "confidence") ?? proposal.confidence,
			entity_type: readString(payload, "entity_type") ?? undefined,
		});
		replacementId = typeof replacement.attributeId === "string" ? replacement.attributeId : null;
		replacementCreated = replacement.deduped !== true && replacementId !== null;
	}

	const requestedReplacementId = readString(payload, "superseded_by");
	const supersededBy = replacementId ?? requestedReplacementId;
	const replacementMemoryId =
		replacementId ??
		(requestedReplacementId === null
			? null
			: (() => {
					const target = db
						.prepare("SELECT id, memory_id FROM entity_attributes WHERE id = ? AND agent_id = ?")
						.get(requestedReplacementId, agentId) as { id: string; memory_id: string | null } | undefined;
					if (!target?.memory_id) {
						throw new OntologyProposalError("payload.superseded_by must reference a semantic claim memory", 400);
					}
					return target.memory_id;
				})());
	const ids = rows.map((row) => row.id);
	db.prepare(
		`UPDATE entity_attributes
		 SET status = 'superseded', superseded_by = ?, updated_at = datetime('now')
		 WHERE agent_id = ? AND id IN (${ids.map(() => "?").join(", ")})`,
	).run(supersededBy, agentId, ...ids);
	if (replacementMemoryId === null) {
		for (const row of rows) archiveAttributeMemoryInTx(db, row.memory_id, proposal, false);
	} else {
		for (const row of rows) {
			supersedeAttributeMemoryInTx(db, { memoryId: row.memory_id, replacementMemoryId, proposal });
		}
	}

	return { supersededAttributeIds: ids, replacementAttributeId: replacementId, replacementCreated };
}

function applyRenameEntity(
	db: WriteDb,
	agentId: string,
	proposal: ProposalRow,
	payload: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
	const selector = readPayloadSelector(payload, "selector", "entity", "entity_id", "name");
	const name = readString(payload, "new_name");
	if (selector === null) throw new OntologyProposalError("payload.selector is required", 400);
	if (name === null) throw new OntologyProposalError("payload.new_name is required", 400);
	const entity = resolveEntityStrict(db, agentId, selector);
	const key = canonical(name);
	const collision = db
		.prepare(
			`SELECT id, name FROM entities
			 WHERE agent_id = ?
			   AND id != ?
			   AND COALESCE(status, 'active') = 'active'
			   AND (COALESCE(canonical_name, LOWER(name)) = ? OR LOWER(name) = ?)
			 LIMIT 1`,
		)
		.get(agentId, entity.id, key, key) as { id: string; name: string } | undefined;
	if (collision) {
		throw new OntologyProposalError(
			`Entity canonical name collides with "${collision.name}". Use merge_entities instead.`,
			409,
		);
	}
	db.prepare(
		`UPDATE entities
		 SET name = ?, canonical_name = ?, proposal_id = ?, proposal_evidence = ?, updated_at = datetime('now')
		 WHERE id = ? AND agent_id = ?`,
	).run(name, key, proposal.id, JSON.stringify(proposalAuditEvidence(proposal)), entity.id, agentId);
	return { entityId: entity.id, oldName: entity.name, newName: name };
}

function applyArchiveEntity(
	db: WriteDb,
	agentId: string,
	proposal: ProposalRow,
	payload: Readonly<Record<string, unknown>>,
	actor: string,
): Readonly<Record<string, unknown>> {
	const selector = readPayloadSelector(payload, "selector", "entity", "entity_id", "name");
	if (selector === null) throw new OntologyProposalError("payload.selector is required", 400);
	const entity = resolveEntityStrict(db, agentId, selector);
	const pinned = db.prepare("SELECT pinned FROM entities WHERE id = ? AND agent_id = ?").get(entity.id, agentId) as
		| { pinned: number | null }
		| undefined;
	if (pinned?.pinned === 1 && !truthy(payload.force)) {
		throw new OntologyProposalError("Refusing to archive pinned entity without force", 409);
	}
	const attributeMemories = db
		.prepare(
			`SELECT attr.memory_id
			 FROM entity_attributes attr
			 JOIN entity_aspects asp ON asp.id = attr.aspect_id AND asp.agent_id = attr.agent_id
			 WHERE asp.entity_id = ? AND attr.agent_id = ? AND attr.status = 'active'`,
		)
		.all(entity.id, agentId) as Array<{ memory_id: string | null }>;
	for (const attribute of attributeMemories)
		archiveAttributeMemoryInTx(db, attribute.memory_id, proposal, truthy(payload.force));
	db.prepare(
		`UPDATE entities
		 SET status = 'archived', archived_at = datetime('now'), archived_by = ?,
		     archive_reason = ?, proposal_id = ?, proposal_evidence = ?, updated_at = datetime('now')
		 WHERE id = ? AND agent_id = ?`,
	).run(
		actor,
		readString(payload, "reason") ?? proposal.rationale,
		proposal.id,
		JSON.stringify(proposalAuditEvidence(proposal)),
		entity.id,
		agentId,
	);
	return { entityId: entity.id, archived: true };
}

/**
 * Reject aspect growth past the cap when the named aspect is not already
 * active. Applies to both create_aspect and add_claim_value resolving a
 * new aspect name: creating a fresh aspect OR reactivating an archived
 * one grows the active set, so both count against the cap.
 */
function enforceAspectCapForNewAspect(
	db: WriteDb,
	entity: { readonly id: string; readonly name: string },
	agentId: string,
	name: string,
	writeCaps?: GraphWriteCaps,
): void {
	if (writeCaps === undefined) return;
	const key = canonical(name);
	const activeAspect = db
		.prepare(
			`SELECT id FROM entity_aspects
			 WHERE entity_id = ? AND agent_id = ? AND canonical_name = ? AND COALESCE(status, 'active') = 'active'`,
		)
		.get(entity.id, agentId, key);
	if (activeAspect != null) return;
	const aspectCount = db
		.prepare(
			`SELECT COUNT(*) AS c FROM entity_aspects
			 WHERE entity_id = ? AND agent_id = ? AND COALESCE(status, 'active') = 'active'`,
		)
		.get(entity.id, agentId) as { c: number };
	if (aspectCount.c >= writeCaps.maxAspectsPerEntity) {
		throw new OntologyProposalError(
			`entity '${entity.name}' is at aspect cap (${aspectCount.c}/${writeCaps.maxAspectsPerEntity}) — consolidate or archive an existing aspect before creating a new one`,
			409,
		);
	}
}

function applyCreateAspect(
	db: WriteDb,
	agentId: string,
	proposal: ProposalRow,
	payload: Readonly<Record<string, unknown>>,
	writeCaps?: GraphWriteCaps,
): Readonly<Record<string, unknown>> {
	const entitySelector = readPayloadSelector(payload, "entity", "entity_id");
	const name = readString(payload, "name") ?? readString(payload, "aspect");
	if (entitySelector === null) throw new OntologyProposalError("payload.entity is required", 400);
	if (name === null) throw new OntologyProposalError("payload.name is required", 400);
	const entity = resolveEntityStrict(db, agentId, entitySelector);

	enforceAspectCapForNewAspect(db, entity, agentId, name, writeCaps);

	const aspectId = resolveOrCreateAspect(db, entity.id, agentId, name);
	db.prepare(
		`UPDATE entity_aspects
		 SET proposal_id = ?, proposal_evidence = ?, updated_at = datetime('now')
		 WHERE id = ? AND agent_id = ?`,
	).run(proposal.id, JSON.stringify(proposalAuditEvidence(proposal)), aspectId, agentId);
	return { entityId: entity.id, aspectId, aspect: name };
}

function applyRenameAspect(
	db: WriteDb,
	agentId: string,
	proposal: ProposalRow,
	payload: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
	const entitySelector = readPayloadSelector(payload, "entity", "entity_id");
	const aspectSelector = readPayloadSelector(payload, "selector", "aspect", "aspect_id", "name");
	const name = readString(payload, "new_name");
	if (entitySelector === null) throw new OntologyProposalError("payload.entity is required", 400);
	if (aspectSelector === null) throw new OntologyProposalError("payload.selector is required", 400);
	if (name === null) throw new OntologyProposalError("payload.new_name is required", 400);
	const entity = resolveEntityStrict(db, agentId, entitySelector);
	const aspect = resolveAspectStrict(db, agentId, entity.id, aspectSelector);
	const key = canonical(name);
	const collision = db
		.prepare(
			`SELECT id, name FROM entity_aspects
			 WHERE entity_id = ? AND agent_id = ? AND id != ?
			   AND COALESCE(status, 'active') = 'active'
			   AND (canonical_name = ? OR LOWER(name) = ?)
			 LIMIT 1`,
		)
		.get(entity.id, agentId, aspect.id, key, key) as { id: string; name: string } | undefined;
	if (collision) throw new OntologyProposalError(`Aspect collides with "${collision.name}"`, 409);
	db.prepare(
		`UPDATE entity_aspects
		 SET name = ?, canonical_name = ?, proposal_id = ?, proposal_evidence = ?, updated_at = datetime('now')
		 WHERE id = ? AND agent_id = ?`,
	).run(name, key, proposal.id, JSON.stringify(proposalAuditEvidence(proposal)), aspect.id, agentId);
	return { entityId: entity.id, aspectId: aspect.id, oldName: aspect.name, newName: name };
}

function applyArchiveAspect(
	db: WriteDb,
	agentId: string,
	proposal: ProposalRow,
	payload: Readonly<Record<string, unknown>>,
	actor: string,
): Readonly<Record<string, unknown>> {
	const entitySelector = readPayloadSelector(payload, "entity", "entity_id");
	const aspectSelector = readPayloadSelector(payload, "selector", "aspect", "aspect_id", "name");
	if (entitySelector === null) throw new OntologyProposalError("payload.entity is required", 400);
	if (aspectSelector === null) throw new OntologyProposalError("payload.selector is required", 400);
	const entity = resolveEntityStrict(db, agentId, entitySelector);
	const aspect = resolveAspectStrict(db, agentId, entity.id, aspectSelector);
	const constraint = db
		.prepare(
			`SELECT 1 FROM entity_attributes
			 WHERE aspect_id = ? AND agent_id = ? AND kind = 'constraint' AND status = 'active'
			 LIMIT 1`,
		)
		.get(aspect.id, agentId);
	if (constraint && !truthy(payload.force)) {
		throw new OntologyProposalError("Refusing to archive aspect with active constraint attributes without force", 409);
	}
	const attributeMemories = db
		.prepare("SELECT memory_id FROM entity_attributes WHERE aspect_id = ? AND agent_id = ? AND status = 'active'")
		.all(aspect.id, agentId) as Array<{ memory_id: string | null }>;
	for (const attribute of attributeMemories)
		archiveAttributeMemoryInTx(db, attribute.memory_id, proposal, truthy(payload.force));
	db.prepare(
		`UPDATE entity_aspects
		 SET status = 'archived', archived_at = datetime('now'), archived_by = ?,
		     archive_reason = ?, proposal_id = ?, proposal_evidence = ?, updated_at = datetime('now')
		 WHERE id = ? AND agent_id = ?`,
	).run(
		actor,
		readString(payload, "reason") ?? proposal.rationale,
		proposal.id,
		JSON.stringify(proposalAuditEvidence(proposal)),
		aspect.id,
		agentId,
	);
	db.prepare(
		`UPDATE entity_attributes
		 SET status = 'deleted', archived_at = datetime('now'), archived_by = ?,
		     archive_reason = ?, updated_at = datetime('now')
		 WHERE aspect_id = ? AND agent_id = ? AND status = 'active'`,
	).run(actor, readString(payload, "reason") ?? proposal.rationale, aspect.id, agentId);
	return { entityId: entity.id, aspectId: aspect.id, archived: true };
}

function applyArchiveClaimValue(
	db: WriteDb,
	agentId: string,
	proposal: ProposalRow,
	payload: Readonly<Record<string, unknown>>,
	actor: string,
): Readonly<Record<string, unknown>> {
	const attributeId = readString(payload, "attribute_id");
	if (attributeId === null) throw new OntologyProposalError("payload.attribute_id is required", 400);
	const row = db
		.prepare("SELECT id, kind, memory_id FROM entity_attributes WHERE id = ? AND agent_id = ?")
		.get(attributeId, agentId) as { id: string; kind: string; memory_id: string | null } | undefined;
	if (!row) throw new OntologyProposalError("Attribute not found", 404);
	if (row.kind === "constraint" && !truthy(payload.force)) {
		throw new OntologyProposalError("Refusing to archive constraint attribute without force", 409);
	}
	archiveAttributeMemoryInTx(db, row.memory_id, proposal, truthy(payload.force));
	db.prepare(
		`UPDATE entity_attributes
		 SET status = 'deleted', archived_at = datetime('now'), archived_by = ?,
		     archive_reason = ?, proposal_id = ?, proposal_evidence = ?, updated_at = datetime('now')
		 WHERE id = ? AND agent_id = ?`,
	).run(
		actor,
		readString(payload, "reason") ?? proposal.rationale,
		proposal.id,
		JSON.stringify(proposalAuditEvidence(proposal)),
		attributeId,
		agentId,
	);
	return { attributeId, archived: true };
}

function applyRestoreClaimVersion(
	db: WriteDb,
	agentId: string,
	proposal: ProposalRow,
	payload: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
	const attributeId = readString(payload, "attribute_id");
	if (attributeId === null) throw new OntologyProposalError("payload.attribute_id is required", 400);
	const row = db
		.prepare(
			`SELECT id, memory_id, aspect_id, kind, group_key, claim_key, version_root_id
			 FROM entity_attributes
			 WHERE id = ? AND agent_id = ?`,
		)
		.get(attributeId, agentId) as
		| {
				id: string;
				memory_id: string | null;
				aspect_id: string;
				kind: string;
				group_key: string | null;
				claim_key: string;
				version_root_id: string | null;
		  }
		| undefined;
	if (!row) throw new OntologyProposalError("Attribute not found", 404);
	const activeMemories = db
		.prepare(
			`SELECT memory_id FROM entity_attributes
			 WHERE agent_id = ? AND aspect_id = ? AND kind = ?
			   AND COALESCE(group_key, 'general') = COALESCE(?, 'general')
			   AND claim_key = ? AND status = 'active' AND id != ?`,
		)
		.all(agentId, row.aspect_id, row.kind, row.group_key, row.claim_key, attributeId) as Array<{
		memory_id: string | null;
	}>;
	restoreAttributeMemoryInTx(db, row.memory_id, proposal);
	for (const active of activeMemories) {
		supersedeAttributeMemoryInTx(db, { memoryId: active.memory_id, replacementMemoryId: attributeId, proposal });
	}
	db.prepare(
		`UPDATE entity_attributes
		 SET status = 'superseded', superseded_by = ?, updated_at = datetime('now')
		 WHERE agent_id = ? AND aspect_id = ? AND kind = ?
		   AND COALESCE(group_key, 'general') = COALESCE(?, 'general')
		   AND claim_key = ? AND status = 'active' AND id != ?`,
	).run(attributeId, agentId, row.aspect_id, row.kind, row.group_key, row.claim_key, attributeId);
	db.prepare(
		`UPDATE entity_attributes
		 SET status = 'active', superseded_by = NULL, archived_at = NULL, archived_by = NULL,
		     archive_reason = NULL, proposal_id = ?, proposal_evidence = ?, updated_at = datetime('now')
		 WHERE id = ? AND agent_id = ?`,
	).run(proposal.id, JSON.stringify(proposalAuditEvidence(proposal)), attributeId, agentId);
	return { attributeId, versionRootId: row.version_root_id ?? attributeId, restored: true };
}

function mergeEntityAspects(db: WriteDb, agentId: string, sourceId: string, targetId: string): number {
	const aspects = db
		.prepare("SELECT id, canonical_name FROM entity_aspects WHERE entity_id = ? AND agent_id = ?")
		.all(sourceId, agentId) as Array<{ id: string; canonical_name: string }>;
	for (const aspect of aspects) {
		const target = db
			.prepare(
				`SELECT id FROM entity_aspects
				 WHERE entity_id = ? AND agent_id = ? AND canonical_name = ?
				 LIMIT 1`,
			)
			.get(targetId, agentId, aspect.canonical_name) as { id: string } | undefined;
		if (target) {
			db.prepare("UPDATE entity_attributes SET aspect_id = ? WHERE aspect_id = ? AND agent_id = ?").run(
				target.id,
				aspect.id,
				agentId,
			);
			db.prepare("DELETE FROM entity_aspects WHERE id = ? AND agent_id = ?").run(aspect.id, agentId);
			continue;
		}
		db.prepare(
			`UPDATE entity_aspects
			 SET entity_id = ?, updated_at = datetime('now')
			 WHERE id = ? AND agent_id = ?`,
		).run(targetId, aspect.id, agentId);
	}
	return aspects.length;
}

function mergeEntityEdges(db: WriteDb, agentId: string, sourceId: string, targetId: string): number {
	let relationshipChanges = 0;
	relationshipChanges += db
		.prepare("UPDATE entity_dependencies SET source_entity_id = ? WHERE source_entity_id = ? AND agent_id = ?")
		.run(targetId, sourceId, agentId).changes;
	relationshipChanges += db
		.prepare("UPDATE entity_dependencies SET target_entity_id = ? WHERE target_entity_id = ? AND agent_id = ?")
		.run(targetId, sourceId, agentId).changes;
	relationshipChanges += db
		.prepare("DELETE FROM entity_dependencies WHERE source_entity_id = target_entity_id AND agent_id = ?")
		.run(agentId).changes;

	relationshipChanges += db
		.prepare("UPDATE relations SET source_entity_id = ? WHERE source_entity_id = ?")
		.run(targetId, sourceId).changes;
	relationshipChanges += db
		.prepare("UPDATE relations SET target_entity_id = ? WHERE target_entity_id = ?")
		.run(targetId, sourceId).changes;
	relationshipChanges += db.prepare("DELETE FROM relations WHERE source_entity_id = target_entity_id").run().changes;
	db.prepare(
		"INSERT OR IGNORE INTO memory_entity_mentions (memory_id, entity_id) SELECT memory_id, ? FROM memory_entity_mentions WHERE entity_id = ?",
	).run(targetId, sourceId);
	db.prepare("DELETE FROM memory_entity_mentions WHERE entity_id = ?").run(sourceId);
	return relationshipChanges;
}

function applyMergeEntities(
	db: WriteDb,
	agentId: string,
	payload: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
	const sources = sourceMergeSpecs(payload);
	const plan = buildEntityMergePlan(db, {
		agentId,
		targetEntity: readString(payload, "target_entity") ?? readString(payload, "target") ?? undefined,
		targetEntityId: readString(payload, "target_entity_id") ?? readString(payload, "target_id") ?? undefined,
		sourceEntities: sources.map((spec) => spec.selector).filter((selector): selector is string => selector !== null),
		sourceEntityIds: sources.map((spec) => spec.id).filter((id): id is string => id !== null),
		force: truthy(payload.force),
	});
	if (plan.blocked) throw new OntologyProposalError(`Merge blocked: ${plan.warnings.join("; ")}`, 409);

	const merged: Array<{ readonly name: string; readonly entityId: string; readonly movedAspects: number }> = [];
	let relationshipChanges = 0;
	for (const source of plan.sources) {
		const movedAspects = mergeEntityAspects(db, agentId, source.id, plan.target.id);
		relationshipChanges += mergeEntityEdges(db, agentId, source.id, plan.target.id);
		db.prepare(
			`UPDATE entities
			 SET mentions = COALESCE(mentions, 0) + COALESCE((SELECT mentions FROM entities WHERE id = ?), 0),
			     updated_at = datetime('now')
			 WHERE id = ? AND agent_id = ?`,
		).run(source.id, plan.target.id, agentId);
		db.prepare("DELETE FROM entities WHERE id = ? AND agent_id = ?").run(source.id, agentId);
		merged.push({ name: source.name, entityId: source.id, movedAspects });
	}
	if (merged.length === 0) throw new OntologyProposalError("No distinct source entities to merge", 400);
	return {
		targetEntityId: plan.target.id,
		targetEntityName: plan.target.name,
		mergedEntities: merged,
		warnings: plan.warnings,
		relationshipsChanged: relationshipChanges,
	};
}

/**
 * Fold source aspects into a target aspect on the same entity. Every
 * attribute row (active, superseded, deleted) of each source is repointed to
 * the target so claim version history stays with the merged aspect, then the
 * source aspect is archived. The merged target may exceed the write-path
 * attribute cap: consolidation is the remedy the cap forces, so it is never
 * blocked by it. Claim-key collisions between source and target are preserved
 * as distinct rows — further dedup is the agent's job via
 * supersede_claim_value. Original proposal attribution on moved rows is
 * preserved so claim-evidence drill-down still resolves the original write.
 */
function applyMergeAspects(
	db: WriteDb,
	agentId: string,
	proposal: ProposalRow,
	payload: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
	const entitySelector = readPayloadSelector(payload, "entity", "entity_id");
	const targetSelector = readPayloadSelector(payload, "target", "target_aspect", "target_aspect_id", "aspect");
	const rawSources = readStringArray(payload, "sources") ?? readStringArray(payload, "source_aspects");
	if (entitySelector === null) throw new OntologyProposalError("payload.entity is required", 400);
	if (targetSelector === null) throw new OntologyProposalError("payload.target is required", 400);
	if (rawSources.length === 0) throw new OntologyProposalError("payload.sources is required", 400);

	const entity = resolveEntityStrict(db, agentId, entitySelector);
	const target = resolveAspectStrict(db, agentId, entity.id, targetSelector);
	const newName = readString(payload, "new_name");
	if (newName !== null) {
		const key = canonical(newName);
		const collision = db
			.prepare(
				`SELECT id FROM entity_aspects
				 WHERE entity_id = ? AND agent_id = ? AND id != ?
				   AND COALESCE(status, 'active') = 'active'
				   AND (canonical_name = ? OR LOWER(name) = ?)
				 LIMIT 1`,
			)
			.get(entity.id, agentId, target.id, key, key);
		if (collision) throw new OntologyProposalError(`Aspect collides with "${newName}"`, 409);
	}

	const evidence = JSON.stringify(proposalAuditEvidence(proposal));
	const moved: Array<{ readonly aspect: string; readonly attributes: number }> = [];
	let totalMoved = 0;
	const seen = new Set<string>([target.id]);
	for (const raw of rawSources) {
		if (typeof raw !== "string") throw new OntologyProposalError("payload.sources must be aspect selectors", 400);
		const source = resolveAspectStrict(db, agentId, entity.id, raw);
		if (seen.has(source.id)) continue;
		seen.add(source.id);

		// #1147 review (findings 10, 11): move EVERY attribute row (active,
		// superseded, deleted) so version history stays with the merged
		// aspect, and preserve each row's original proposal_id/proposal_evidence
		// so claim-evidence drill-down still resolves the original write.
		const attributes = db
			.prepare("SELECT id FROM entity_attributes WHERE aspect_id = ? AND agent_id = ?")
			.all(source.id, agentId) as Array<{ id: string }>;
		for (const attribute of attributes) {
			db.prepare(
				`UPDATE entity_attributes
				 SET aspect_id = ?, updated_at = datetime('now')
				 WHERE id = ? AND agent_id = ?`,
			).run(target.id, attribute.id, agentId);
		}
		db.prepare(
			`UPDATE entity_aspects
			 SET status = 'archived', archived_at = datetime('now'), archived_by = ?,
			     archive_reason = ?, proposal_id = ?, proposal_evidence = ?, updated_at = datetime('now')
			 WHERE id = ? AND agent_id = ? AND COALESCE(status, 'active') = 'active'`,
		).run(
			proposal.created_by || "ontology-merge",
			`Merged into aspect '${target.name}'`,
			proposal.id,
			evidence,
			source.id,
			agentId,
		);
		moved.push({ aspect: source.name, attributes: attributes.length });
		totalMoved += attributes.length;
	}
	if (moved.length === 0) throw new OntologyProposalError("No distinct source aspects to merge", 400);

	if (newName !== null) {
		db.prepare(
			`UPDATE entity_aspects
			 SET name = ?, canonical_name = ?, proposal_id = ?, proposal_evidence = ?, updated_at = datetime('now')
			 WHERE id = ? AND agent_id = ?`,
		).run(newName, canonical(newName), proposal.id, evidence, target.id, agentId);
	}

	return {
		entityId: entity.id,
		targetAspectId: target.id,
		targetAspect: newName ?? target.name,
		mergedAspects: moved,
		totalAttributesMoved: totalMoved,
	};
}

function applyCreateLink(
	db: WriteDb,
	agentId: string,
	proposal: ProposalRow,
	payload: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
	const sourceIdSelector = readString(payload, "source_entity_id");
	const targetIdSelector = readString(payload, "target_entity_id");
	const source = sourceIdSelector ?? readString(payload, "source_entity");
	const target = targetIdSelector ?? readString(payload, "target_entity");
	if (source === null) throw new OntologyProposalError("payload.source_entity is required", 400);
	if (target === null) throw new OntologyProposalError("payload.target_entity is required", 400);

	const dependencyType = normalizeDependencyType(readString(payload, "link_type"));
	const sourceId = sourceIdSelector
		? resolveEntityStrict(db, agentId, source).id
		: resolveOrCreateEntity(db, agentId, source, normalizeEntityType(readString(payload, "source_type")));
	const targetId = targetIdSelector
		? resolveEntityStrict(db, agentId, target).id
		: resolveOrCreateEntity(db, agentId, target, normalizeEntityType(readString(payload, "target_type")));
	const reason = requireDependencyReason(dependencyType, readString(payload, "reason") ?? proposal.rationale);
	const strength = clamp01(readNumber(payload, "strength") ?? 0.5);
	const confidence = clamp01(readNumber(payload, "confidence") ?? proposal.confidence);

	const existing = db
		.prepare(
			`SELECT id, status FROM entity_dependencies
			 WHERE source_entity_id = ? AND target_entity_id = ?
			   AND dependency_type = ? AND agent_id = ?
			 LIMIT 1`,
		)
		.get(sourceId, targetId, dependencyType, agentId) as { id: string; status: string | null } | undefined;
	if (existing) {
		db.prepare(
			`UPDATE entity_dependencies
			 SET status = 'active', archived_at = NULL, archived_by = NULL,
			     archive_reason = NULL, strength = ?, confidence = ?, reason = ?,
			     updated_at = datetime('now'),
			     source_id = ?, source_kind = ?, source_path = ?, source_root = ?,
			     proposal_id = ?, proposal_evidence = ?
			 WHERE id = ? AND agent_id = ?`,
		).run(
			strength,
			confidence,
			reason,
			proposal.source_id,
			proposal.source_kind,
			proposal.source_path,
			proposal.source_root,
			proposal.id,
			JSON.stringify(proposalAuditEvidence(proposal)),
			existing.id,
			agentId,
		);
		return {
			dependencyId: existing.id,
			sourceId,
			targetId,
			updated: true,
			reactivated: (existing.status ?? "active") !== "active",
		};
	}

	const id = crypto.randomUUID();
	db.prepare(
		`INSERT INTO entity_dependencies
		 (id, source_entity_id, target_entity_id, agent_id, dependency_type,
		  strength, confidence, reason, created_at, updated_at,
		  source_id, source_kind, source_path, source_root, proposal_id, proposal_evidence)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), ?, ?, ?, ?, ?, ?)`,
	).run(
		id,
		sourceId,
		targetId,
		agentId,
		dependencyType,
		strength,
		confidence,
		reason,
		proposal.source_id,
		proposal.source_kind,
		proposal.source_path,
		proposal.source_root,
		proposal.id,
		JSON.stringify(proposalAuditEvidence(proposal)),
	);
	return { dependencyId: id, sourceId, targetId, updated: false };
}

function applyUpdateLink(
	db: WriteDb,
	agentId: string,
	proposal: ProposalRow,
	payload: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
	const id = readString(payload, "id") ?? readString(payload, "dependency_id") ?? readString(payload, "link_id");
	if (id === null) throw new OntologyProposalError("payload.id is required", 400);
	const existing = db
		.prepare(
			"SELECT dependency_type, reason, strength, confidence FROM entity_dependencies WHERE id = ? AND agent_id = ?",
		)
		.get(id, agentId) as
		| { dependency_type: DependencyType; reason: string | null; strength: number | null; confidence: number | null }
		| undefined;
	if (!existing) throw new OntologyProposalError("Link not found", 404);
	const dependencyType = readString(payload, "link_type")
		? normalizeDependencyType(readString(payload, "link_type"))
		: existing.dependency_type;
	const reason = requireDependencyReason(
		dependencyType,
		readString(payload, "reason") ?? existing.reason ?? proposal.rationale,
	);
	const strength = clamp01(readNumber(payload, "strength") ?? existing.strength ?? 0.5);
	const confidence = clamp01(readNumber(payload, "confidence") ?? existing.confidence ?? proposal.confidence);
	db.prepare(
		`UPDATE entity_dependencies
		 SET dependency_type = ?, reason = ?, strength = ?, confidence = ?,
		     source_id = COALESCE(?, source_id),
		     source_kind = COALESCE(?, source_kind),
		     source_path = COALESCE(?, source_path),
		     source_root = COALESCE(?, source_root),
		     proposal_id = ?, proposal_evidence = ?, updated_at = datetime('now')
		 WHERE id = ? AND agent_id = ?`,
	).run(
		dependencyType,
		reason,
		strength,
		confidence,
		proposal.source_id,
		proposal.source_kind,
		proposal.source_path,
		proposal.source_root,
		proposal.id,
		JSON.stringify(proposalAuditEvidence(proposal)),
		id,
		agentId,
	);
	return { dependencyId: id, updated: true };
}

function applyArchiveLink(
	db: WriteDb,
	agentId: string,
	proposal: ProposalRow,
	payload: Readonly<Record<string, unknown>>,
	actor: string,
): Readonly<Record<string, unknown>> {
	const id = readString(payload, "id") ?? readString(payload, "dependency_id") ?? readString(payload, "link_id");
	if (id === null) throw new OntologyProposalError("payload.id is required", 400);
	const existing = db.prepare("SELECT id FROM entity_dependencies WHERE id = ? AND agent_id = ?").get(id, agentId) as
		| { id: string }
		| undefined;
	if (!existing) throw new OntologyProposalError("Link not found", 404);
	db.prepare(
		`UPDATE entity_dependencies
		 SET status = 'archived', archived_at = datetime('now'), archived_by = ?,
		     archive_reason = ?, proposal_id = ?, proposal_evidence = ?, updated_at = datetime('now')
		 WHERE id = ? AND agent_id = ?`,
	).run(
		actor,
		readString(payload, "reason") ?? proposal.rationale,
		proposal.id,
		JSON.stringify(proposalAuditEvidence(proposal)),
		id,
		agentId,
	);
	return { dependencyId: id, archived: true };
}

function applyPinEntity(
	db: WriteDb,
	agentId: string,
	proposal: ProposalRow,
	payload: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
	const selector = readPayloadSelector(payload, "selector", "entity", "entity_id", "id");
	if (selector === null) throw new OntologyProposalError("payload.entity is required", 400);
	const entity = resolveEntityStrict(db, agentId, selector);
	const ts = now();
	db.prepare(
		`UPDATE entities
		 SET pinned = 1, pinned_at = ?, proposal_id = ?, proposal_evidence = ?, updated_at = ?
		 WHERE id = ? AND agent_id = ?`,
	).run(ts, proposal.id, JSON.stringify(proposalAuditEvidence(proposal)), ts, entity.id, agentId);
	return { entityId: entity.id, pinned: true, pinnedAt: ts };
}

function applyUnpinEntity(
	db: WriteDb,
	agentId: string,
	proposal: ProposalRow,
	payload: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
	const selector = readPayloadSelector(payload, "selector", "entity", "entity_id", "id");
	if (selector === null) throw new OntologyProposalError("payload.entity is required", 400);
	const entity = resolveEntityStrict(db, agentId, selector);
	db.prepare(
		`UPDATE entities
		 SET pinned = 0, pinned_at = NULL, proposal_id = ?, proposal_evidence = ?, updated_at = datetime('now')
		 WHERE id = ? AND agent_id = ?`,
	).run(proposal.id, JSON.stringify(proposalAuditEvidence(proposal)), entity.id, agentId);
	return { entityId: entity.id, pinned: false };
}

function applyCreateEntityAlias(
	db: WriteDb,
	agentId: string,
	proposal: ProposalRow,
	payload: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
	const entitySelector = readPayloadSelector(payload, "entity", "entity_id");
	const alias = readString(payload, "alias");
	if (entitySelector === null) throw new OntologyProposalError("payload.entity is required", 400);
	if (alias === null) throw new OntologyProposalError("payload.alias is required", 400);
	const canonicalAlias = canonical(alias);
	if (canonicalAlias.length === 0) throw new OntologyProposalError("payload.alias is required", 400);
	const entity = resolveEntityStrict(db, agentId, entitySelector);
	const confidence = clamp01(readNumber(payload, "confidence") ?? 1);
	const source = readString(payload, "source");
	const id = crypto.randomUUID();
	db.prepare(
		`INSERT INTO entity_aliases
		 (id, entity_id, agent_id, alias, canonical_alias, confidence, source, status, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, 'active', datetime('now'), datetime('now'))`,
	).run(id, entity.id, agentId, alias.trim(), canonicalAlias, confidence, source ?? null);
	return { aliasId: id, entityId: entity.id, alias: alias.trim(), canonicalAlias };
}

function applyArchiveEntityAlias(
	db: WriteDb,
	agentId: string,
	proposal: ProposalRow,
	payload: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
	const entitySelector = readPayloadSelector(payload, "entity", "entity_id");
	const aliasId = readString(payload, "alias_id");
	if (entitySelector === null) throw new OntologyProposalError("payload.entity is required", 400);
	if (aliasId === null) throw new OntologyProposalError("payload.alias_id is required", 400);
	const entity = resolveEntityStrict(db, agentId, entitySelector);
	const result = db
		.prepare(
			`UPDATE entity_aliases
			 SET status = 'archived', updated_at = datetime('now')
			 WHERE id = ? AND entity_id = ? AND agent_id = ? AND status = 'active'`,
		)
		.run(aliasId, entity.id, agentId);
	if (result.changes === 0) throw new OntologyProposalError("Alias not found", 404);
	return { aliasId, entityId: entity.id, archived: true };
}

function applyOperation(
	db: WriteDb,
	proposal: ProposalRow,
	actor: string,
	writeCaps?: GraphWriteCaps,
): Readonly<Record<string, unknown>> {
	const payload = parseJsonRecord(proposal.payload);
	if (proposal.operation === "create_entity") return applyCreateEntity(db, proposal.agent_id, proposal, payload);
	if (proposal.operation === "rename_entity") return applyRenameEntity(db, proposal.agent_id, proposal, payload);
	if (proposal.operation === "archive_entity")
		return applyArchiveEntity(db, proposal.agent_id, proposal, payload, actor);
	if (proposal.operation === "create_aspect")
		return applyCreateAspect(db, proposal.agent_id, proposal, payload, writeCaps);
	if (proposal.operation === "rename_aspect") return applyRenameAspect(db, proposal.agent_id, proposal, payload);
	if (proposal.operation === "archive_aspect")
		return applyArchiveAspect(db, proposal.agent_id, proposal, payload, actor);
	if (proposal.operation === "add_claim_value")
		return applyAddClaimValue(db, proposal.agent_id, proposal, payload, writeCaps);
	if (proposal.operation === "set_claim_value")
		return applySetClaimValue(db, proposal.agent_id, proposal, payload, writeCaps);
	if (proposal.operation === "merge_entities") return applyMergeEntities(db, proposal.agent_id, payload);
	if (proposal.operation === "merge_aspects") return applyMergeAspects(db, proposal.agent_id, proposal, payload);
	if (proposal.operation === "supersede_claim_value") {
		return applySupersedeClaimValue(db, proposal.agent_id, proposal, payload);
	}
	if (proposal.operation === "archive_claim_value")
		return applyArchiveClaimValue(db, proposal.agent_id, proposal, payload, actor);
	if (proposal.operation === "restore_claim_version") {
		return applyRestoreClaimVersion(db, proposal.agent_id, proposal, payload);
	}
	if (proposal.operation === "create_link") return applyCreateLink(db, proposal.agent_id, proposal, payload);
	if (proposal.operation === "update_link") return applyUpdateLink(db, proposal.agent_id, proposal, payload);
	if (proposal.operation === "archive_link") return applyArchiveLink(db, proposal.agent_id, proposal, payload, actor);
	if (proposal.operation === "create_policy") return applyCreatePolicy(db, proposal.agent_id, proposal, payload);
	if (proposal.operation === "create_action_type")
		return applyCreateActionType(db, proposal.agent_id, proposal, payload);
	if (proposal.operation === "create_interface") return applyCreateInterface(db, proposal.agent_id, proposal, payload);
	if (proposal.operation === "attach_interface") return applyAttachInterface(db, proposal.agent_id, proposal, payload);
	if (proposal.operation === "pin_entity") return applyPinEntity(db, proposal.agent_id, proposal, payload);
	if (proposal.operation === "unpin_entity") return applyUnpinEntity(db, proposal.agent_id, proposal, payload);
	if (proposal.operation === "create_entity_alias")
		return applyCreateEntityAlias(db, proposal.agent_id, proposal, payload);
	if (proposal.operation === "archive_entity_alias")
		return applyArchiveEntityAlias(db, proposal.agent_id, proposal, payload);
	throw new OntologyProposalError(`Unsupported ontology proposal operation: ${proposal.operation}`, 400);
}

function markFailed(accessor: DbAccessor, id: string, agentId: string, err: unknown): void {
	const message = err instanceof Error ? err.message : String(err);
	accessor.withWriteTx((db) => {
		db.prepare(
			`UPDATE ontology_proposals
			 SET status = 'failed', result = ?, updated_at = ?
			 WHERE id = ? AND agent_id = ? AND status = 'pending'`,
		).run(JSON.stringify({ error: message }), now(), id, agentId);
	});
}

export function createOntologyProposal(accessor: DbAccessor, input: CreateOntologyProposalInput): OntologyProposal {
	const ts = now();
	return accessor.withWriteTx((db) => insertProposalInTx(db, input, ts));
}

export function createOntologyProposals(
	accessor: DbAccessor,
	inputs: readonly CreateOntologyProposalInput[],
): CreateOntologyProposalsResult {
	if (inputs.length === 0) throw new OntologyProposalError("proposals are required", 400);
	if (inputs.length > 500) throw new OntologyProposalError("cannot create more than 500 proposals at once", 400);
	return accessor.withWriteTx((db) => createOntologyProposalsInTx(db, inputs));
}

export function createOntologyProposalsInTx(
	db: WriteDb,
	inputs: readonly CreateOntologyProposalInput[],
): CreateOntologyProposalsResult {
	if (inputs.length === 0) throw new OntologyProposalError("proposals are required", 400);
	if (inputs.length > 500) throw new OntologyProposalError("cannot create more than 500 proposals at once", 400);
	const ts = now();
	const items = inputs.map((input) => insertProposalInTx(db, input, ts));
	return { items, count: items.length };
}

export function getOntologyProposal(accessor: DbAccessor, id: string, agentId: string): OntologyProposal | null {
	const row = getProposalReadRow(accessor, id, agentId);
	return row === null ? null : toProposal(row);
}

export function getOntologyProposalEvidence(
	accessor: DbAccessor,
	id: string,
	agentId: string,
): OntologyProposalEvidenceResult {
	const proposal = getOntologyProposal(accessor, id, agentId);
	if (proposal === null) throw new OntologyProposalError("Proposal not found", 404);
	const items = accessor.withReadDb((db) =>
		proposalEvidenceRefs(proposal).map((ref) => resolveOntologyEvidenceRef(db, agentId, ref)),
	);
	return { proposal, items, count: items.length };
}

export function listOntologyProposals(
	accessor: DbAccessor,
	params: ListOntologyProposalsParams,
): {
	readonly items: readonly OntologyProposal[];
	readonly limit: number;
	readonly offset: number;
} {
	const limit = Math.min(Math.max(params.limit ?? 50, 1), 200);
	const offset = Math.max(params.offset ?? 0, 0);
	return accessor.withReadDb((db) => {
		const filters = ["agent_id = ?"];
		const args: unknown[] = [params.agentId];
		if (params.status) {
			filters.push("status = ?");
			args.push(params.status);
		}
		if (params.operation) {
			filters.push("operation = ?");
			args.push(params.operation);
		}
		args.push(limit, offset);
		const rows = db
			.prepare(
				`SELECT * FROM ontology_proposals
				 WHERE ${filters.join(" AND ")}
				 ORDER BY updated_at DESC
				 LIMIT ? OFFSET ?`,
			)
			.all(...args) as ProposalRow[];
		return { items: rows.map(toProposal), limit, offset };
	});
}

export function listOntologyProposalConflicts(
	accessor: DbAccessor,
	params: { readonly agentId: string; readonly limit?: number },
): OntologyProposalConflictsResult {
	const limit = Math.min(Math.max(params.limit ?? 500, 1), 1000);
	return accessor.withReadDb((db) => {
		const rows = db
			.prepare(
				`SELECT * FROM ontology_proposals
				 WHERE agent_id = ? AND status = 'pending' AND operation = 'add_claim_value'
				 ORDER BY updated_at DESC
				 LIMIT ?`,
			)
			.all(params.agentId, limit) as ProposalRow[];
		const groups = new Map<string, OntologyProposalConflict>();
		for (const proposal of rows.map(toProposal)) {
			const entity = readString(proposal.payload, "entity");
			const aspect = readString(proposal.payload, "aspect");
			const claimKey = readString(proposal.payload, "claim_key");
			const value = readString(proposal.payload, "value");
			if (entity === null || aspect === null || claimKey === null || value === null) continue;
			const groupKey = readString(proposal.payload, "group_key") ?? "general";
			const key = [canonical(entity), canonical(aspect), canonical(groupKey), canonical(claimKey)].join("\0");
			const current = groups.get(key) ?? {
				entity,
				aspect,
				groupKey,
				claimKey,
				values: [],
				proposalIds: [],
				count: 0,
			};
			groups.set(key, {
				...current,
				values: [
					...current.values,
					{
						proposalId: proposal.id,
						value,
						confidence: proposal.confidence,
						rationale: proposal.rationale,
						evidenceCount: proposal.evidence.length,
					},
				],
				proposalIds: [...current.proposalIds, proposal.id],
				count: current.count + 1,
			});
		}
		const items = [...groups.values()].filter(
			(group) => new Set(group.values.map((item) => canonical(item.value))).size > 1,
		);
		return { items, count: items.length };
	});
}

function claimVersionRow(row: Record<string, unknown>): ClaimVersionItem {
	return {
		id: row.id as string,
		version: Number(row.version ?? 1),
		versionRootId: typeof row.version_root_id === "string" ? row.version_root_id : (row.id as string),
		previousAttributeId: typeof row.previous_attribute_id === "string" ? row.previous_attribute_id : null,
		content: row.content as string,
		status: row.status as string,
		confidence: Number(row.confidence ?? 0),
		proposalId: typeof row.proposal_id === "string" ? row.proposal_id : null,
		sourceKind: typeof row.source_kind === "string" ? row.source_kind : null,
		sourceId: typeof row.source_id === "string" ? row.source_id : null,
		sourcePath: typeof row.source_path === "string" ? row.source_path : null,
		createdAt: row.created_at as string,
		updatedAt: row.updated_at as string,
	};
}

export function listClaimVersions(
	accessor: DbAccessor,
	params: ClaimVersionReadParams,
): { readonly items: readonly ClaimVersionItem[]; readonly count: number } {
	const groupKey = canonicalKey(params.group) ?? "general";
	const claimKey = canonicalKey(params.claim);
	if (claimKey === null) throw new OntologyProposalError("claim is required", 400);
	const kind = params.kind ?? "attribute";
	return accessor.withReadDb((db) => {
		const entityKey = canonical(params.entity);
		const exactEntity = db
			.prepare("SELECT id FROM entities WHERE agent_id = ? AND id = ? LIMIT 1")
			.get(params.agentId, params.entity) as { id: string } | undefined;
		const entity =
			exactEntity ??
			(() => {
				const rows = db
					.prepare(
						`SELECT id FROM entities
						 WHERE agent_id = ?
						   AND (COALESCE(canonical_name, LOWER(name)) = ? OR LOWER(name) = ?)
						 ORDER BY updated_at DESC, name ASC`,
					)
					.all(params.agentId, entityKey, entityKey) as Array<{ id: string }>;
				if (rows.length === 0) throw new OntologyProposalError(`Entity not found: ${params.entity}`, 404);
				if (rows.length > 1) {
					throw new OntologyProposalError(`Entity selector is ambiguous: ${params.entity}. Use an id.`, 409);
				}
				return rows[0] as { id: string };
			})();
		const aspectKey = canonical(params.aspect);
		const exactAspect = db
			.prepare("SELECT id FROM entity_aspects WHERE entity_id = ? AND agent_id = ? AND id = ? LIMIT 1")
			.get(entity.id, params.agentId, params.aspect) as { id: string } | undefined;
		const aspect =
			exactAspect ??
			(() => {
				const rows = db
					.prepare(
						`SELECT id FROM entity_aspects
						 WHERE entity_id = ?
						   AND agent_id = ?
						   AND (canonical_name = ? OR LOWER(name) = ?)
						 ORDER BY updated_at DESC, name ASC`,
					)
					.all(entity.id, params.agentId, aspectKey, aspectKey) as Array<{ id: string }>;
				if (rows.length === 0) throw new OntologyProposalError(`Aspect not found: ${params.aspect}`, 404);
				if (rows.length > 1) {
					throw new OntologyProposalError(`Aspect selector is ambiguous: ${params.aspect}. Use an id.`, 409);
				}
				return rows[0] as { id: string };
			})();
		const rows = db
			.prepare(
				`SELECT attr.*
				 FROM entity_attributes attr
				 WHERE attr.agent_id = ?
				   AND attr.aspect_id = ?
				   AND COALESCE(attr.group_key, 'general') = ?
				   AND attr.claim_key = ?
				   AND attr.kind = ?
				 ORDER BY attr.version DESC, attr.updated_at DESC`,
			)
			.all(params.agentId, aspect.id, groupKey, claimKey, kind) as Array<Record<string, unknown>>;
		const items = rows.map(claimVersionRow);
		return { items, count: items.length };
	});
}

export function getClaimVersion(
	accessor: DbAccessor,
	params: ClaimVersionReadParams & { readonly version: number },
): ClaimVersionItem | null {
	const versions = listClaimVersions(accessor, params);
	return versions.items.find((item) => item.version === params.version) ?? null;
}

interface DuplicateEntityRow {
	readonly id: string;
	readonly name: string;
	readonly canonical_name: string | null;
	readonly entity_type: string;
	readonly mentions: number | null;
	readonly pinned: number | null;
	readonly updated_at: string;
}

function toDuplicateEntityRef(row: DuplicateEntityRow, key: string): DuplicateEntityRef {
	return {
		id: row.id,
		name: row.name,
		canonicalName: key,
		entityType: row.entity_type,
		mentions: Math.max(0, row.mentions ?? 0),
		pinned: row.pinned === 1,
		updatedAt: row.updated_at,
	};
}

function entityRowToRef(row: DuplicateEntityRow): DuplicateEntityRef {
	return toDuplicateEntityRef(row, canonical(row.canonical_name ?? row.name));
}

function getEntityRefById(db: ReadDb, agentId: string, id: string): DuplicateEntityRef | null {
	const row = db
		.prepare(
			`SELECT id, name, canonical_name, entity_type,
			        COALESCE(mentions, 0) AS mentions,
			        COALESCE(pinned, 0) AS pinned,
			        updated_at
			 FROM entities
			 WHERE agent_id = ?
			   AND COALESCE(status, 'active') = 'active'
			   AND id = ?
			 LIMIT 1`,
		)
		.get(agentId, id) as DuplicateEntityRow | undefined;
	return row ? entityRowToRef(row) : null;
}

function resolveEntityRefStrict(db: ReadDb, agentId: string, selector: string): DuplicateEntityRef {
	const key = canonical(selector);
	const rows = db
		.prepare(
			`SELECT id, name, canonical_name, entity_type,
			        COALESCE(mentions, 0) AS mentions,
			        COALESCE(pinned, 0) AS pinned,
			        updated_at
			 FROM entities
			 WHERE agent_id = ?
			   AND COALESCE(status, 'active') = 'active'
			   AND (id = ? OR COALESCE(canonical_name, LOWER(name)) = ? OR LOWER(name) = ?)
			 ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END, updated_at DESC, name ASC`,
		)
		.all(agentId, selector, key, key, selector) as DuplicateEntityRow[];
	if (rows.length === 0) throw new OntologyProposalError(`Entity not found: ${selector}`, 404);
	if (rows.length > 1) throw new OntologyProposalError(`Entity selector is ambiguous: ${selector}. Use an id.`, 409);
	return entityRowToRef(rows[0] as DuplicateEntityRow);
}

function resolveMergeEntityRef(
	db: ReadDb,
	agentId: string,
	field: string,
	selector: string | null,
	id: string | null,
): DuplicateEntityRef {
	if (id !== null) {
		const byId = getEntityRefById(db, agentId, id);
		if (byId === null) throw new OntologyProposalError(`${field}_id was not found: ${id}`, 404);
		if (selector !== null && !selectorMatchesEntityRef(selector, byId)) {
			throw new OntologyProposalError(`${field}_id does not match ${field}`, 409);
		}
		return byId;
	}
	if (selector === null) throw new OntologyProposalError(`${field} is required`, 400);
	return resolveEntityRefStrict(db, agentId, selector);
}

function selectorMatchesEntityRef(selector: string, entity: DuplicateEntityRef): boolean {
	const key = canonical(selector);
	return selector === entity.id || key === canonical(entity.name) || key === canonical(entity.canonicalName);
}

function sourceMergeSpecs(payload: Readonly<Record<string, unknown>>): Array<{
	readonly selector: string | null;
	readonly id: string | null;
}> {
	const selectors = unique([
		...readStringArray(payload, "source_entities"),
		...readStringArray(payload, "sources"),
		...(readString(payload, "source_entity") ? [readString(payload, "source_entity") as string] : []),
		...(readString(payload, "source") ? [readString(payload, "source") as string] : []),
	]);
	const ids = unique([
		...readStringArray(payload, "source_entity_ids"),
		...readStringArray(payload, "source_ids"),
		...(readString(payload, "source_entity_id") ? [readString(payload, "source_entity_id") as string] : []),
		...(readString(payload, "source_id") ? [readString(payload, "source_id") as string] : []),
	]);
	if (ids.length > 0) {
		if (selectors.length > ids.length) {
			throw new OntologyProposalError("payload.source_entities and payload.source_entity_ids must match", 400);
		}
		return ids.map((id, index) => ({ id, selector: selectors[index] ?? null }));
	}
	return selectors.map((selector) => ({ selector, id: null }));
}

function entityMergeImpact(db: ReadDb, agentId: string, sources: readonly DuplicateEntityRef[]): EntityMergeImpact {
	const ids = sources.map((source) => source.id);
	if (ids.length === 0) {
		return { sourceMentions: 0, memoryMentions: 0, aspects: 0, attributes: 0, dependencies: 0, relations: 0 };
	}
	const placeholders = ids.map(() => "?").join(", ");
	const sourceMentions = sources.reduce((sum, source) => sum + source.mentions, 0);
	const aspects = db
		.prepare(`SELECT COUNT(*) AS count FROM entity_aspects WHERE agent_id = ? AND entity_id IN (${placeholders})`)
		.get(agentId, ...ids) as { count: number };
	const attributes = db
		.prepare(
			`SELECT COUNT(*) AS count
			 FROM entity_attributes attr
			 JOIN entity_aspects asp ON asp.id = attr.aspect_id
			 WHERE attr.agent_id = ? AND asp.entity_id IN (${placeholders})`,
		)
		.get(agentId, ...ids) as { count: number };
	const dependencies = db
		.prepare(
			`SELECT COUNT(*) AS count
			 FROM entity_dependencies
			 WHERE agent_id = ? AND (source_entity_id IN (${placeholders}) OR target_entity_id IN (${placeholders}))`,
		)
		.get(agentId, ...ids, ...ids) as { count: number };
	const relations = db
		.prepare(
			`SELECT COUNT(*) AS count
			 FROM relations
			 WHERE source_entity_id IN (${placeholders}) OR target_entity_id IN (${placeholders})`,
		)
		.get(...ids, ...ids) as { count: number };
	const memoryMentions = db
		.prepare(`SELECT COUNT(*) AS count FROM memory_entity_mentions WHERE entity_id IN (${placeholders})`)
		.get(...ids) as { count: number };
	return {
		sourceMentions,
		memoryMentions: memoryMentions.count,
		aspects: aspects.count,
		attributes: attributes.count,
		dependencies: dependencies.count,
		relations: relations.count,
	};
}

function mergeWarnings(
	target: DuplicateEntityRef,
	sources: readonly DuplicateEntityRef[],
	force: boolean,
): {
	readonly warnings: readonly string[];
	readonly blocked: boolean;
	readonly risk: "low" | "review_required" | "blocked";
} {
	const warnings: string[] = [];
	for (const source of sources) {
		if (source.pinned) warnings.push(`source entity "${source.name}" is pinned`);
		if (source.entityType !== target.entityType) {
			warnings.push(
				`source entity "${source.name}" type ${source.entityType} differs from target type ${target.entityType}`,
			);
		}
	}
	if (warnings.length === 0) return { warnings, blocked: false, risk: "low" };
	return { warnings, blocked: !force, risk: force ? "review_required" : "blocked" };
}

function mergePlanPayload(
	target: DuplicateEntityRef,
	sources: readonly DuplicateEntityRef[],
	force: boolean,
): Readonly<Record<string, unknown>> {
	return {
		repair_kind: "manual_entity_merge",
		target_entity: target.name,
		target_entity_id: target.id,
		source_entities: sources.map((source) => source.name),
		source_entity_ids: sources.map((source) => source.id),
		...(force ? { force: true } : {}),
	};
}

function buildEntityMergePlan(
	db: ReadDb,
	params: EntityMergePlanParams,
	payloadKind = "manual_entity_merge",
): Omit<EntityMergePlanResult, "dryRun" | "proposal"> {
	const agentId = requireText(params.agentId, "agentId");
	const targetSelector = params.targetEntity?.trim() || null;
	const targetId = params.targetEntityId?.trim() || null;
	const target = resolveMergeEntityRef(db, agentId, "payload.target_entity", targetSelector, targetId);
	const specs = params.sourceEntityIds?.length
		? params.sourceEntityIds.map((id, index) => ({ id, selector: params.sourceEntities?.[index] ?? null }))
		: (params.sourceEntities ?? []).map((selector) => ({ selector, id: null }));
	if (params.sourceEntityIds?.length && (params.sourceEntities?.length ?? 0) > params.sourceEntityIds.length) {
		throw new OntologyProposalError("sourceEntities and sourceEntityIds must match", 400);
	}
	if (specs.length === 0) throw new OntologyProposalError("source entities are required", 400);
	const resolved = specs.map((spec) =>
		resolveMergeEntityRef(db, agentId, "payload.source_entity", spec.selector, spec.id),
	);
	const sourceMap = new Map(resolved.map((source) => [source.id, source]));
	sourceMap.delete(target.id);
	const sources = [...sourceMap.values()];
	if (sources.length === 0) throw new OntologyProposalError("No distinct source entities to merge", 400);
	const force = params.force === true;
	const safety = mergeWarnings(target, sources, force);
	const payload = {
		...mergePlanPayload(target, sources, force),
		repair_kind: payloadKind,
	};
	const evidence = params.evidence ?? [
		{
			source_kind: "ontology_index",
			source_id: `entities:${target.canonicalName}`,
			quote: `Merge ${sources.map((source) => source.name).join(", ")} into ${target.name}.`,
		},
	];
	return {
		operation: "merge_entities",
		target,
		sources,
		payload,
		impact: entityMergeImpact(db, agentId, sources),
		warnings: safety.warnings,
		blocked: safety.blocked,
		confidence: safety.risk === "low" ? 0.86 : 0.72,
		rationale:
			params.rationale?.trim() ||
			`Merge ${sources.map((source) => `"${source.name}"`).join(", ")} into "${target.name}".`,
		evidence,
		risk: safety.risk,
	};
}

function timeRank(value: string): number {
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : 0;
}

function compareDuplicateTargets(a: DuplicateEntityRow, b: DuplicateEntityRow): number {
	const pinned = (b.pinned ?? 0) - (a.pinned ?? 0);
	if (pinned !== 0) return pinned;
	const mentions = (b.mentions ?? 0) - (a.mentions ?? 0);
	if (mentions !== 0) return mentions;
	const updated = timeRank(b.updated_at) - timeRank(a.updated_at);
	if (updated !== 0) return updated;
	const length = a.name.length - b.name.length;
	if (length !== 0) return length;
	return a.name.localeCompare(b.name);
}

function pendingDuplicateRepairKeys(db: ReadDb, agentId: string): Set<string> {
	const rows = db
		.prepare(
			`SELECT payload FROM ontology_proposals
			 WHERE agent_id = ? AND status = 'pending' AND operation = 'merge_entities'
			 ORDER BY updated_at DESC
			 LIMIT 1000`,
		)
		.all(agentId) as Array<{ readonly payload: string }>;
	return new Set(
		rows
			.map((row) => {
				const payload = parseJsonRecord(row.payload);
				return readString(payload, "repair_kind") === "duplicate_entities"
					? readString(payload, "canonical_name")
					: null;
			})
			.filter((key): key is string => key !== null),
	);
}

function duplicateMergeCandidates(
	db: ReadDb,
	agentId: string,
	limit: number,
	canonicalName?: string,
	includePending = false,
): readonly DuplicateEntityMergeCandidate[] {
	const existing = pendingDuplicateRepairKeys(db, agentId);
	const scopedCanonicalName = canonicalName?.trim() || null;
	const rows = db
		.prepare(
			`SELECT id, name, canonical_name, entity_type,
			        COALESCE(mentions, 0) AS mentions,
			        COALESCE(pinned, 0) AS pinned,
			        updated_at
			 FROM entities
			 WHERE agent_id = ?
			   AND COALESCE(status, 'active') = 'active'
			   AND (? IS NULL OR canonical_name = ? OR canonical_name IS NULL)
			 ORDER BY COALESCE(canonical_name, LOWER(name)), COALESCE(mentions, 0) DESC, updated_at DESC`,
		)
		.all(agentId, scopedCanonicalName, scopedCanonicalName) as DuplicateEntityRow[];
	const groups = new Map<string, DuplicateEntityRow[]>();
	for (const row of rows) {
		const key = canonical(row.canonical_name ?? row.name);
		groups.set(key, [...(groups.get(key) ?? []), row]);
	}

	return [...groups.entries()]
		.filter(
			([key, group]) =>
				key.length > 0 &&
				group.length > 1 &&
				(scopedCanonicalName === null || key === scopedCanonicalName) &&
				(includePending || !existing.has(key)),
		)
		.map(([key, group]) => {
			const ordered = [...group].sort(compareDuplicateTargets);
			const target = ordered[0];
			const sources = ordered.slice(1);
			const evidence = [
				{
					source_kind: "ontology_index",
					source_id: `entities:${key}`,
					quote: `Duplicate canonical_name "${key}" appears on ${ordered.map((row) => row.name).join(", ")}.`,
				},
			];
			const plan = buildEntityMergePlan(
				db,
				{
					agentId,
					targetEntityId: target.id,
					sourceEntityIds: sources.map((row) => row.id),
					rationale: `Entities share canonical_name "${key}" in the same agent scope.`,
					evidence,
				},
				"duplicate_entities",
			);
			return {
				operation: "merge_entities" as const,
				canonicalName: key,
				target: plan.target,
				sources: plan.sources,
				payload: {
					...plan.payload,
					canonical_name: key,
				},
				impact: plan.impact,
				warnings: plan.warnings,
				blocked: plan.blocked,
				confidence: plan.confidence,
				rationale: plan.rationale,
				evidence: plan.evidence,
				risk: plan.risk,
			};
		})
		.sort((a, b) => b.sources.length - a.sources.length || a.canonicalName.localeCompare(b.canonicalName))
		.slice(0, limit);
}

/**
 * Read-only exact-canonical duplicate lookup for a named entity. The same
 * merge candidate planner powers the repair/proposal path, so guard callers
 * see the target, sources, and safety warnings that the daemon would use.
 */
export function findDuplicateEntityMerges(
	accessor: DbAccessor,
	params: FindDuplicateEntityMergesParams,
): readonly DuplicateEntityMergeCandidate[] {
	const agentId = requireText(params.agentId, "agentId");
	const canonicalName = canonical(params.name);
	if (canonicalName.length === 0) return [];
	return accessor.withReadDb((db) => duplicateMergeCandidates(db, agentId, 1, canonicalName, true));
}

export function proposeDuplicateEntityMerges(
	accessor: DbAccessor,
	params: ProposeDuplicateEntityMergesParams,
): DuplicateEntityMergeResult {
	const agentId = requireText(params.agentId, "agentId");
	const limit = Math.min(Math.max(params.limit ?? 25, 1), 100);
	const items = accessor.withReadDb((db) => duplicateMergeCandidates(db, agentId, limit));
	const dryRun = params.writeProposals !== true;
	if (dryRun || items.length === 0) {
		return {
			items,
			proposals: [],
			count: items.length,
			writtenCount: 0,
			skippedCount: items.filter((item) => item.blocked).length,
			dryRun,
		};
	}
	const writableItems = items.filter((item) => !item.blocked);
	if (writableItems.length === 0) {
		return { items, proposals: [], count: items.length, writtenCount: 0, skippedCount: items.length, dryRun };
	}

	const written = createOntologyProposals(
		accessor,
		writableItems.map((item) => ({
			agentId,
			operation: item.operation,
			payload: item.payload,
			confidence: item.confidence,
			rationale: item.rationale,
			evidence: item.evidence,
			risk: item.risk,
			sourceKind: "ontology_index",
			sourceId: `entities:${item.canonicalName}`,
			createdBy: params.createdBy?.trim() || "ontology-repair",
		})),
	);
	return {
		items,
		proposals: written.items,
		count: items.length,
		writtenCount: written.count,
		skippedCount: items.length - writableItems.length,
		dryRun: false,
	};
}

export function createEntityMergePlan(accessor: DbAccessor, params: EntityMergePlanParams): EntityMergePlanResult {
	const agentId = requireText(params.agentId, "agentId");
	const dryRun = params.writeProposal !== true;
	const plan = accessor.withReadDb((db) => buildEntityMergePlan(db, { ...params, agentId }, "manual_entity_merge"));
	if (dryRun || plan.blocked) return { ...plan, dryRun: true };
	const proposal = createOntologyProposal(accessor, {
		agentId,
		operation: plan.operation,
		payload: plan.payload,
		confidence: plan.confidence,
		rationale: plan.rationale,
		evidence: plan.evidence,
		risk: plan.risk,
		sourceKind: "ontology_index",
		sourceId: `entities:${plan.target.id}`,
		createdBy: params.createdBy?.trim() || "ontology-merge-plan",
	});
	return { ...plan, dryRun: false, proposal };
}

export function applyOntologyProposal(accessor: DbAccessor, params: ApplyOntologyProposalParams): OntologyProposal {
	try {
		return accessor.withWriteTx((db) => {
			const proposal = getProposalInTx(db, params.id, params.agentId);
			if (proposal === null) throw new OntologyProposalError("Proposal not found", 404);
			if (proposal.status !== "pending") {
				throw new OntologyProposalError(`Proposal is ${proposal.status}, not pending`, 409);
			}

			const result = applyOperation(db, proposal, params.actor, params.writeCaps);
			const ts = now();
			db.prepare(
				`UPDATE ontology_proposals
				 SET status = 'applied', applied_by = ?, result = ?,
				     applied_at = ?, updated_at = ?
				 WHERE id = ? AND agent_id = ?`,
			).run(params.actor, JSON.stringify(result), ts, ts, params.id, params.agentId);
			return readBackInTx(db, params.id, params.agentId);
		});
	} catch (err) {
		if (err instanceof OntologyProposalError && err.status !== 404 && err.status !== 409) {
			markFailed(accessor, params.id, params.agentId, err);
		}
		throw err;
	}
}

class DryRunRollback extends Error {
	constructor() {
		super("dry-run rollback");
		this.name = "DryRunRollback";
	}
}

function operationToProposalInput(params: ApplyOntologyOperationParams): CreateOntologyProposalInput {
	return {
		agentId: params.agentId,
		operation: params.operation,
		payload: params.payload,
		confidence: params.confidence,
		rationale: params.reason,
		evidence: params.evidence,
		risk: params.risk,
		sourceKind: params.sourceKind,
		sourceId: params.sourceId,
		sourcePath: params.sourcePath,
		sourceRoot: params.sourceRoot,
		createdBy: params.actor,
	};
}

function markAppliedInTx(
	db: WriteDb,
	proposal: ProposalRow,
	actor: string,
	result: Readonly<Record<string, unknown>>,
): OntologyProposal {
	const ts = now();
	db.prepare(
		`UPDATE ontology_proposals
		 SET status = 'applied', applied_by = ?, result = ?,
		     applied_at = ?, updated_at = ?
		 WHERE id = ? AND agent_id = ?`,
	).run(actor, JSON.stringify(result), ts, ts, proposal.id, proposal.agent_id);
	return readBackInTx(db, proposal.id, proposal.agent_id);
}

export function applyOntologyOperation(
	accessor: DbAccessor,
	params: ApplyOntologyOperationParams,
): ApplyOntologyOperationResult {
	if (params.propose && params.dryRun) {
		throw new OntologyProposalError("--dry-run and --propose cannot be used together", 400);
	}
	if (Object.keys(params.payload).length === 0) throw new OntologyProposalError("payload is required", 400);
	if (params.propose) {
		const proposal = createOntologyProposal(accessor, operationToProposalInput(params));
		return { proposal, result: null, dryRun: false, proposed: true };
	}

	let preview: ApplyOntologyOperationResult | null = null;
	try {
		const result = accessor.withWriteTx((db) => {
			const inserted = insertProposalInTx(db, operationToProposalInput(params), now());
			const row = getProposalInTx(db, inserted.id, params.agentId);
			if (row === null) throw new OntologyProposalError("Proposal not found", 404);
			const operationResult = applyOperation(db, row, params.actor, params.writeCaps);
			const proposal = markAppliedInTx(db, row, params.actor, operationResult);
			const item = { proposal, result: operationResult, dryRun: params.dryRun === true, proposed: false };
			if (params.dryRun) {
				preview = item;
				throw new DryRunRollback();
			}
			return item;
		});
		return result;
	} catch (err) {
		if (err instanceof DryRunRollback && preview !== null) return preview;
		throw err;
	}
}

export function applyOntologyOperationBatch(
	accessor: DbAccessor,
	params: ApplyOntologyOperationBatchParams,
): ApplyOntologyOperationBatchResult {
	if (params.operations.length === 0) throw new OntologyProposalError("operations are required", 400);
	if (params.operations.length > 500)
		throw new OntologyProposalError("cannot apply more than 500 operations at once", 400);
	if (params.propose && params.dryRun) {
		throw new OntologyProposalError("--dry-run and --propose cannot be used together", 400);
	}

	if (params.propose) {
		const written = createOntologyProposals(
			accessor,
			params.operations.map((operation) => ({
				agentId: params.agentId,
				operation: operation.operation,
				payload: operation.payload,
				confidence: operation.confidence,
				rationale: operation.reason,
				evidence: operation.evidence,
				risk: operation.risk,
				sourceKind: operation.sourceKind,
				sourceId: operation.sourceId,
				sourcePath: operation.sourcePath,
				sourceRoot: operation.sourceRoot,
				createdBy: params.actor,
			})),
		);
		return {
			items: written.items.map((proposal) => ({ proposal, result: null, dryRun: false, proposed: true })),
			count: written.count,
			dryRun: false,
			proposed: true,
		};
	}
	if (!params.dryRun) {
		return accessor.withWriteTx((db) => applyOntologyOperationBatchInTx(db, params));
	}

	let preview: ApplyOntologyOperationBatchResult | null = null;
	try {
		const result = accessor.withWriteTx((db) => {
			const items: ApplyOntologyOperationResult[] = [];
			const errors: OntologyOperationBatchError[] = [];
			for (const [index, operation] of params.operations.entries()) {
				try {
					const inserted = insertProposalInTx(
						db,
						{
							agentId: params.agentId,
							operation: operation.operation,
							payload: operation.payload,
							confidence: operation.confidence,
							rationale: operation.reason,
							evidence: operation.evidence,
							risk: operation.risk,
							sourceKind: operation.sourceKind,
							sourceId: operation.sourceId,
							sourcePath: operation.sourcePath,
							sourceRoot: operation.sourceRoot,
							createdBy: params.actor,
						},
						now(),
					);
					const row = getProposalInTx(db, inserted.id, params.agentId);
					if (row === null) throw new OntologyProposalError("Proposal not found", 404);
					const operationResult = applyOperation(db, row, params.actor, params.writeCaps);
					const proposal = markAppliedInTx(db, row, params.actor, operationResult);
					items.push({ proposal, result: operationResult, dryRun: params.dryRun === true, proposed: false });
				} catch (err) {
					if (!params.dryRun) throw err;
					errors.push({
						index,
						line: index + 1,
						operation: operation.operation,
						error: err instanceof Error ? err.message : String(err),
						status: err instanceof OntologyProposalError ? err.status : 400,
					});
				}
			}
			const batch = {
				items,
				errors: errors.length > 0 ? errors : undefined,
				count: items.length,
				dryRun: params.dryRun === true,
				proposed: false,
			};
			if (params.dryRun) {
				preview = batch;
				throw new DryRunRollback();
			}
			return batch;
		});
		return result;
	} catch (err) {
		if (err instanceof DryRunRollback && preview !== null) return preview;
		throw err;
	}
}

export function rejectOntologyProposal(accessor: DbAccessor, params: RejectOntologyProposalParams): OntologyProposal {
	return accessor.withWriteTx((db) => {
		const proposal = getProposalInTx(db, params.id, params.agentId);
		if (proposal === null) throw new OntologyProposalError("Proposal not found", 404);
		if (proposal.status !== "pending") {
			throw new OntologyProposalError(`Proposal is ${proposal.status}, not pending`, 409);
		}

		const ts = now();
		db.prepare(
			`UPDATE ontology_proposals
			 SET status = 'rejected', rejected_by = ?, result = ?,
			     rejected_at = ?, updated_at = ?
			 WHERE id = ? AND agent_id = ?`,
		).run(params.actor, JSON.stringify({ reason: params.reason ?? "rejected" }), ts, ts, params.id, params.agentId);
		return readBackInTx(db, params.id, params.agentId);
	});
}
