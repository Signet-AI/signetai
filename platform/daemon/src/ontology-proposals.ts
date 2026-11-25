import {
	ATTRIBUTE_KINDS,
	type AttributeKind,
	CLAIM_TIME_PRECISIONS,
	type ClaimTimePrecision,
	DEPENDENCY_TYPES,
	type DependencyType,
	ENTITY_TYPES,
	type EntityType,
	ONTOLOGY_PROPOSAL_STATUSES,
	type OntologyProposal,
	type OntologyProposalStatus,
} from "@signet/core";
import { auditAuthoredWriteInTx, requireWriteAuthor, type WriteAuthor } from "./auth/audit-owner";
import type { DbAccessor, ReadDb, WriteDb } from "./db-accessor";
import { prepareTypedStatement, runWriteTxAsync } from "./db-accessor";
import { requireDependencyReason } from "./dependency-history";
import { linkDerivedMemorySourcesInTx, markDerivedMemoriesStaleForSourceInTx } from "./derived-memory-provenance";
import {
	assertDreamingAgentInDb,
	type SemanticCitationKind,
	type SemanticEvidenceCitation,
	recordSemanticCitationsInTx,
	evidenceCitationInDb,
	assertDreamingMutationLabelInDb,
	dreamingPassPartitionInDb,
	dreamingReadScopeInDb,
	type DreamingPartition,
	type DreamingMutationTable,
} from "./classification-owner";
import { renderDreamingEvidence } from "./pipeline/dreaming-evidence";
import { classifyEntityQuality } from "./entity-quality";
import { readEpisodicSource, resolveStrictEpisodicSourceRef } from "./episodic-sources";
import {
	reconcileOntologyContradictionsInTx,
	recordOntologyContradictionsForAttributeInTx,
} from "./ontology-contradictions";
import {
	type OntologyEvidenceItem,
	type OntologyEvidenceRef,
	readOntologyEvidenceRef,
	resolveOntologyEvidenceRef,
	uniqueOntologyEvidenceRefs,
} from "./ontology-evidence";
import { readScopeSql } from "./read-scope";
import { type MemoryTemporalEdgeInput, txInsertMemoryTemporalEdges } from "./temporal-edges";
import { insertHistoryEvent, txForgetMemory, txIngestEnvelope, txSupersedeMemory } from "./transactions";

type ProposalRow = {
	readonly dreaming_pass_id: string | null;
	readonly compartment_id: number | null;
	readonly author_user_id: string | null;
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
	readonly passId?: string;
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
	readonly author: WriteAuthor;
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
	readonly author?: WriteAuthor;
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
	readonly passId?: string;
	readonly agentId: string;
	readonly id: string;
	readonly actor: string;
	readonly author: WriteAuthor;
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
	readonly author: WriteAuthor;
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
	readonly passId?: string;
	readonly agentId: string;
	readonly actor: string;
	readonly author: WriteAuthor;
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
	readonly passId?: string;
	readonly agentId: string;
	readonly actor: string;
	readonly author: WriteAuthor;
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
export function applyOntologyOperationBatchInTx(
	db: WriteDb,
	params: Pick<ApplyOntologyOperationBatchParams, "agentId" | "actor" | "author" | "operations" | "passId"> & {
		readonly writeCaps?: GraphWriteCaps;
	},
): ApplyOntologyOperationBatchResult {
	if (params.operations.length === 0) throw new OntologyProposalError("operations are required", 400);
	if (params.operations.length > 500)
		throw new OntologyProposalError("cannot apply more than 500 operations at once", 400);

	for (const operation of params.operations)
		assertOntologyOperationPartitionInTx(db, { ...operation, agentId: params.agentId, passId: params.passId });
	const items: ApplyOntologyOperationResult[] = [];
	for (const operation of params.operations) {
		const inserted = insertProposalInTx(
			db,
			{
				agentId: params.agentId,
				passId: params.passId,
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
				author: requireWriteAuthor(params.author),
			},
			now(),
		);
		const row = getProposalInTx(db, inserted.id, params.agentId);
		if (row === null) throw new OntologyProposalError("Proposal not found", 404);
		const result = applyOperation(db, row, params.actor, params.author, params.writeCaps);
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
	readonly occurredStart: string | null;
	readonly occurredEnd: string | null;
	readonly validFrom: string | null;
	readonly validUntil: string | null;
	readonly timePrecision: string | null;
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

interface ClaimTime {
	readonly occurredStart: string | null;
	readonly occurredEnd: string | null;
	readonly validFrom: string | null;
	readonly validUntil: string | null;
	readonly precision: ClaimTimePrecision | null;
}

const CLAIM_TIME_FIELDS = ["occurred_at", "occurred_until", "valid_from", "valid_until", "time_precision"] as const;

function readClaimTimestamp(payload: Readonly<Record<string, unknown>>, key: string): string | null {
	const value = readString(payload, key);
	if (value === null) return null;
	const parsed = new Date(value);
	if (Number.isNaN(parsed.getTime())) {
		throw new OntologyProposalError(`payload.${key} must be a valid ISO date or timestamp`, 400);
	}
	return parsed.toISOString();
}

function readClaimTime(payload: Readonly<Record<string, unknown>>): ClaimTime {
	const occurredStart = readClaimTimestamp(payload, "occurred_at");
	const occurredEnd = readClaimTimestamp(payload, "occurred_until");
	const validFrom = readClaimTimestamp(payload, "valid_from");
	const validUntil = readClaimTimestamp(payload, "valid_until");
	const rawPrecision = readString(payload, "time_precision");
	if (rawPrecision !== null && !CLAIM_TIME_PRECISIONS.includes(rawPrecision as ClaimTimePrecision)) {
		throw new OntologyProposalError(`payload.time_precision must be one of ${CLAIM_TIME_PRECISIONS.join(", ")}`, 400);
	}
	if (occurredEnd !== null && occurredStart === null) {
		throw new OntologyProposalError("payload.occurred_until requires payload.occurred_at", 400);
	}
	if (occurredStart !== null && occurredEnd !== null && occurredEnd < occurredStart) {
		throw new OntologyProposalError("payload.occurred_until must not be before payload.occurred_at", 400);
	}
	if (validFrom !== null && validUntil !== null && validUntil <= validFrom) {
		throw new OntologyProposalError("payload.valid_until must be after payload.valid_from", 400);
	}
	const hasTime = occurredStart !== null || validFrom !== null || validUntil !== null;
	if (rawPrecision !== null && !hasTime) {
		throw new OntologyProposalError("payload.time_precision needs payload.occurred_at or payload.valid_from", 400);
	}
	const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(
		readString(payload, "occurred_at") ?? readString(payload, "valid_from") ?? "",
	);
	const precision = (rawPrecision as ClaimTimePrecision | null) ?? (hasTime && dateOnly ? "day" : null);
	return { occurredStart, occurredEnd, validFrom, validUntil, precision };
}

function claimTimeFields(payload: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
	const fields: Record<string, unknown> = {};
	for (const key of CLAIM_TIME_FIELDS) {
		if (payload[key] !== undefined) fields[key] = payload[key];
	}
	return fields;
}

function claimEvidenceTime(time: {
	readonly valid_from: string | null;
	readonly occurred_start: string | null;
}): string | null {
	return time.valid_from ?? time.occurred_start;
}

function claimSourceCapturedAt(
	db: ReadDb,
	agentId: string,
	sourceKind: string | null,
	sourceId: string | null,
): string | null {
	if (!sourceKind || !sourceId) return null;
	const capturedAt = readEpisodicSource(db, { agentId, from: `${sourceKind}:${sourceId}` })?.capturedAt;
	if (!capturedAt) return null;
	const ms = Date.parse(capturedAt);
	return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

function precisionSpanEnd(start: string, precision: ClaimTimePrecision | null): string {
	const end = new Date(start);
	if (precision === "day" || precision === "approximate") end.setUTCDate(end.getUTCDate() + 1);
	else if (precision === "week") end.setUTCDate(end.getUTCDate() + 7);
	else if (precision === "month") end.setUTCMonth(end.getUTCMonth() + 1);
	else if (precision === "year") end.setUTCFullYear(end.getUTCFullYear() + 1);
	else return start;
	return new Date(end.getTime() - 1).toISOString();
}

function claimTemporalEdges(time: ClaimTime, attributeId: string, proposal: ProposalRow): MemoryTemporalEdgeInput[] {
	const metadata = { attributeId, precision: time.precision, proposalId: proposal.id, sourceId: proposal.source_id };
	const edges: MemoryTemporalEdgeInput[] = [];
	if (time.occurredStart !== null) {
		edges.push({
			facet: "occurred",
			startAt: time.occurredStart,
			endAt: time.occurredEnd ?? precisionSpanEnd(time.occurredStart, time.precision),
			provenance: "dreaming.claim.occurred",
			metadata,
		});
	}
	if (time.validFrom !== null) {
		edges.push({
			facet: "valid",
			startAt: time.validFrom,
			endAt: time.validUntil,
			provenance: "dreaming.claim.valid",
			metadata,
		});
	}
	return edges;
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

async function getProposalReadRow(accessor: DbAccessor, id: string, agentId: string): Promise<ProposalRow | null> {
	return await accessor.withReadDbAsync(
		async (db) => {
			const row = db.prepare("SELECT * FROM ontology_proposals WHERE id = ? AND agent_id = ?").get(id, agentId) as
				| ProposalRow
				| undefined;
			return row ?? null;
		},
		{ siteToken: "ontology-proposals.ts:626" },
	);
}

function readBackInTx(db: WriteDb, id: string, agentId: string): OntologyProposal {
	const row = getProposalInTx(db, id, agentId);
	if (row === null) throw new OntologyProposalError("Proposal not found", 404);
	return toProposal(row);
}

function requireStrictEpisodicSourceRefInTx(
	db: WriteDb,
	agentId: string,
	sourceRef: unknown,
	partition?: DreamingPartition,
) {
	const resolved = resolveStrictEpisodicSourceRef(db, {
		agentId,
		sourceRef,
		readScope: partition ? dreamingReadScopeInDb(db, agentId, partition.compartmentId) : undefined,
	});
	if (partition && resolved.status === "not_found") {
		const unscoped = resolveStrictEpisodicSourceRef(db, { agentId, sourceRef });
		if (unscoped.status === "resolved") throw new OntologyProposalError("compartment_mismatch", 409);
		if (unscoped.status === "cross_agent")
			throw new OntologyProposalError("Evidence source_ref crosses the authorized agent scope", 409);
	}
	if (resolved.status === "resolved") return resolved.source;
	if (resolved.status === "invalid") {
		throw new OntologyProposalError("Evidence source_ref must name a canonical episodic source", 409);
	}
	if (resolved.status === "cross_agent") {
		throw new OntologyProposalError("Evidence source_ref crosses the authorized agent scope", 409);
	}
	throw new OntologyProposalError(`Evidence source_ref was not found: ${resolved.sourceRef}`, 409);
}

function isDreamingAttentionEvidenceInTx(
	db: WriteDb,
	agentId: string,
	value: Readonly<Record<string, unknown>>,
): boolean {
	const sourceRef = typeof value.source_ref === "string" ? value.source_ref.trim() : "";
	const sourceId = typeof value.source_id === "string" ? value.source_id.trim() : "";
	if (
		value.source_kind !== "attention" ||
		value.source_root !== "dreaming_attention" ||
		!/^attention:(?:\$\d+|[^:]+)$/.test(sourceRef) ||
		sourceId.length === 0
	) {
		return false;
	}
	const row = db.prepare("SELECT id FROM dreaming_attention WHERE id = ? AND agent_id = ?").get(sourceId, agentId) as
		| { id: string }
		| undefined;
	return row !== undefined;
}

function insertProposalInTx(db: WriteDb, input: CreateOntologyProposalInput, ts: string): OntologyProposal {
	const id = crypto.randomUUID();
	const agentId = requireText(input.agentId, "agentId");
	const operation = requireText(input.operation, "operation");
	if (Object.keys(input.payload).length === 0) throw new OntologyProposalError("payload is required", 400);
	const evidence = input.evidence ?? [];
	const partition: DreamingPartition = ontologyPartitionInDb(db, agentId, input.passId);
	const targets = assertOntologyOperationPartitionInTx(db, { ...input, agentId });
	const citations = [
		...proposalCitationsInDb(db, agentId, evidence, partition),
		...proposalTargetCitationsInDb(db, targets, partition),
	];
	const authors = citations.map((citation) => evidenceCitationInDb(db, partition, citation).authorUserId);
	const authorUserId =
		authors.length > 0 && authors.every((author) => author !== null && author === authors[0]) ? authors[0] : null;
	db.prepare(
		`INSERT INTO ontology_proposals
		 (id, agent_id, operation, status, payload, confidence, rationale,
		  evidence, risk, source_kind, source_id, source_path, source_root,
		  created_by, created_at, updated_at,author_user_id, compartment_id, dreaming_pass_id)
		 VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
		authorUserId ?? (input.passId ? null : (input.author?.userId ?? null)),
		partition.compartmentId,
		input.passId ?? null,
	);
	recordSemanticCitationsInTx(db, { kind: "proposal", id, partition, evidence: citations });
	auditAuthoredWriteInTx(db, input.author, "ontology.proposed", "proposal", id, agentId);
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
function derivedMemorySourcesForProposalInTx(
	db: WriteDb,
	proposal: ProposalRow,
): readonly {
	readonly sourceKind: string;
	readonly sourceId: string;
	readonly sourcePath: string | null;
}[] {
	const sources: Array<{ sourceKind: string; sourceId: string; sourcePath: string | null }> = [];
	for (const ref of proposalEvidenceRefs(toProposal(proposal))) {
		if (typeof ref.reference !== "object" || ref.reference === null || Array.isArray(ref.reference)) continue;
		const evidence = ref.reference as Readonly<Record<string, unknown>>;
		if (!("source_ref" in evidence)) continue;
		if (isDreamingAttentionEvidenceInTx(db, proposal.agent_id, evidence)) continue;
		const source = requireStrictEpisodicSourceRefInTx(
			db,
			proposal.agent_id,
			evidence.source_ref,
			ontologyPartitionInDb(db, proposal.agent_id, proposal.dreaming_pass_id ?? undefined),
		);
		sources.push({
			sourceKind: source.kind,
			sourceId: source.id,
			sourcePath: source.sourcePath,
		});
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

function resolveOrCreateEntity(
	db: WriteDb,
	agentId: string,
	name: string,
	type: EntityType,
	proposal: ProposalRow,
): string {
	const existing = resolveEntity(db, agentId, name);
	if (existing !== null) {
		assertDreamingMutationLabelInDb(
			db,
			"entities",
			existing,
			ontologyPartitionInDb(db, agentId, proposal.dreaming_pass_id ?? undefined),
		);
		return existing;
	}
	const quality = classifyEntityQuality(name, type === "person" ? type : undefined);
	if (!quality.ok) throw new OntologyProposalError(`Entity name rejected: ${quality.reason}`, 400);
	const id = crypto.randomUUID();
	db.prepare(
		`INSERT INTO entities
		 (id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, 0, datetime('now'), datetime('now'))`,
	).run(id, name.trim(), canonical(name), type, agentId);
	labelProposalRowInTx(db, "entities", "entity", id, proposal);
	return id;
}

function resolveOrCreateAspect(
	db: WriteDb,
	entityId: string,
	agentId: string,
	name: string,
	proposal: ProposalRow,
): string {
	const key = canonical(name);
	const existing = db
		.prepare(
			`SELECT id, status FROM entity_aspects
			 WHERE entity_id = ? AND agent_id = ? AND canonical_name = ?
			 LIMIT 1`,
		)
		.get(entityId, agentId, key) as { id: string; status: string | null } | undefined;
	if (existing) {
		assertDreamingMutationLabelInDb(
			db,
			"entity_aspects",
			existing.id,
			ontologyPartitionInDb(db, agentId, proposal.dreaming_pass_id ?? undefined),
		);
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
	labelProposalRowInTx(db, "entity_aspects", "aspect", id, proposal);
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
		resolveOrCreateEntity(db, agentId, name, normalizeEntityType(readString(payload, "entity_type")), proposal);
	const proposalEvidence = JSON.stringify(proposalAuditEvidence(proposal));
	if (existingEntityId !== null) {
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
function applyCreatePolicy(
	db: WriteDb,
	agentId: string,
	proposal: ProposalRow,
	payload: Readonly<Record<string, unknown>>,
	actor: string,
	author: WriteAuthor,
): Readonly<Record<string, unknown>> {
	const target = readPayloadSelector(payload, "target_entity", "entity", "entity_id");
	const policyKind = readString(payload, "kind");
	const content = readString(payload, "content");
	if (target === null) throw new OntologyProposalError("payload.target_entity is required", 400);
	if (policyKind === null) throw new OntologyProposalError("payload.kind is required", 400);
	if (content === null) throw new OntologyProposalError("payload.content is required", 400);
	const result = applyAddClaimValue(
		db,
		agentId,
		proposal,
		{
			entity: target,
			entity_type: readString(payload, "entity_type") ?? undefined,
			aspect: "policy",
			group_key: "policy",
			claim_key: canonicalKey(policyKind) ?? policyKind,
			value: content,
			kind: "constraint",
			confidence: readNumber(payload, "confidence") ?? proposal.confidence,
			importance: readNumber(payload, "importance") ?? proposal.confidence,
		},
		actor,
		author,
	);
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
		readonly time: ClaimTime;
		readonly proposal: ProposalRow;
		readonly actor: string;
		readonly author: WriteAuthor;
	},
): string {
	const existing = db.prepare("SELECT id FROM memories WHERE id = ?").get(input.attributeId) as
		| { id: string }
		| undefined;
	if (!existing) {
		txIngestEnvelope(db, {
			author: input.author,
			id: input.attributeId,
			content: input.content,
			normalizedContent: input.normalizedContent,
			contentHash: `semantic-attribute:${input.attributeId}`,
			who: input.actor,
			why: input.proposal.rationale || null,
			project: null,
			importance: input.importance,
			type: "semantic",
			tags: "semantic,attribute",
			pinned: 0,
			extractionStatus: "completed",
			updatedBy: input.actor,
			memoryKind: "derived",
			sourceType: input.actor,
			sourceId: input.proposal.source_id,
			sourcePath: input.proposal.source_path,
			agentId: input.agentId,
			visibility: "global",
			reviewAfter: input.reviewAfter,
			createdAt: now(),
		});
	}
	labelProposalRowInTx(db, "entity_attributes", "attribute", input.attributeId, input.proposal);
	labelProposalRowInTx(db, "memories", "memory", input.attributeId, input.proposal);
	recordSemanticCitationsInTx(db, {
		kind: "memory",
		id: input.attributeId,
		partition: ontologyPartitionInDb(db, input.agentId, input.proposal.dreaming_pass_id ?? undefined),
		evidence: [{ kind: "attribute", id: input.attributeId }],
	});
	db.prepare("UPDATE memories SET author_user_id = ? WHERE id = ? AND agent_id = ?").run(
		input.proposal.author_user_id,
		input.attributeId,
		input.agentId,
	);
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
		passId: input.proposal.dreaming_pass_id ?? undefined,
		sources: derivedMemorySourcesForProposalInTx(db, input.proposal),
		createdAt: now(),
	});
	txInsertMemoryTemporalEdges({
		db,
		memoryId: input.attributeId,
		agentId: input.agentId,
		inputs: claimTemporalEdges(input.time, input.attributeId, input.proposal),
		now: now(),
	});
	for (const edge of prepareTypedStatement<{ id: string }>(
		db,
		"SELECT id FROM temporal_edges WHERE subject_type = 'memory' AND subject_id = ? AND agent_id = ?",
	).all(input.attributeId, input.agentId)) {
		labelProposalRowInTx(db, "temporal_edges", "temporal_edge", edge.id, input.proposal);
		recordSemanticCitationsInTx(db, {
			kind: "temporal_edge",
			id: edge.id,
			partition: ontologyPartitionInDb(db, input.agentId, input.proposal.dreaming_pass_id ?? undefined),
			evidence: [{ kind: "memory", id: input.attributeId }],
		});
	}
	return input.attributeId;
}

function supersedeAttributeMemoryInTx(
	db: WriteDb,
	input: {
		readonly memoryId: string | null;
		readonly replacementMemoryId: string;
		readonly proposal: ProposalRow;
		readonly actor: string;
		readonly author: WriteAuthor;
	},
): void {
	if (!input.memoryId || input.memoryId === input.replacementMemoryId) return;
	const result = txSupersedeMemory(db, {
		memoryId: input.memoryId,
		supersededBy: input.replacementMemoryId,
		reason: input.proposal.rationale || null,
		changedBy: input.actor,
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
		partition: ontologyPartitionInDb(db, input.proposal.agent_id, input.proposal.dreaming_pass_id ?? undefined),
	});
}

function archiveAttributeMemoryInTx(
	db: WriteDb,
	memoryId: string | null,
	proposal: ProposalRow,
	actor: string,
	force: boolean,
): void {
	if (!memoryId) return;
	const result = txForgetMemory(db, {
		memoryId,
		reason: proposal.rationale || "Semantic claim archived",
		changedBy: actor,
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
		partition: ontologyPartitionInDb(db, proposal.agent_id, proposal.dreaming_pass_id ?? undefined),
	});
}

function restoreAttributeMemoryInTx(db: WriteDb, memoryId: string | null, proposal: ProposalRow, actor: string): void {
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
		     superseded_reason = NULL, updated_at = ?, updated_by = ?, version = version + 1
		 WHERE id = ?`,
	).run(changedAt, actor, memoryId);
	insertHistoryEvent(db, {
		memoryId,
		event: "recovered",
		oldContent: null,
		newContent: memory.content,
		changedBy: actor,
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
	actor: string,
	author: WriteAuthor,
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

	const entityId = resolveOrCreateEntity(
		db,
		agentId,
		entity,
		normalizeEntityType(readString(payload, "entity_type")),
		proposal,
	);
	const addEntityRow = db.prepare("SELECT id, name FROM entities WHERE id = ?").get(entityId) as
		| { id: string; name: string }
		| undefined;
	if (addEntityRow !== undefined) enforceAspectCapForNewAspect(db, addEntityRow, agentId, aspect, proposal, writeCaps);
	const aspectId = resolveOrCreateAspect(db, entityId, agentId, aspect, proposal);
	const scope = readScopeSql(
		"",
		dreamingReadScopeInDb(
			db,
			agentId,
			ontologyPartitionInDb(db, agentId, proposal.dreaming_pass_id ?? undefined).compartmentId,
		),
		{ visibility: null },
	);
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
			   AND status = 'active' ${scope.sql}
			 LIMIT 1`,
		)
		.get(aspectId, agentId, kind, normalized, groupKey, claimKey, ...scope.args) as { id: string } | undefined;
	if (existing) {
		return {
			entityId,
			aspectId,
			attributeId: existing.id,
			deduped: true,
			contradictionIds: recordOntologyContradictionsForAttributeInTx(db, {
				agentId,
				partition: ontologyPartitionInDb(db, agentId, proposal.dreaming_pass_id ?? undefined),
				attributeId: existing.id,
			}),
		};
	}

	if (writeCaps !== undefined) {
		const attrCount = db
			.prepare(
				`SELECT COUNT(*) AS c FROM entity_attributes
				 WHERE aspect_id = ? AND agent_id = ? AND status = 'active' ${scope.sql}`,
			)
			.get(aspectId, agentId, ...scope.args) as { c: number };
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
	const time = readClaimTime(payload);
	const proposalEvidence = proposalAuditEvidence(proposal);
	db.prepare(
		`INSERT INTO entity_attributes
		 (id, aspect_id, agent_id, kind, content, normalized_content,
		  confidence, importance, status, group_key, claim_key,
		  version, version_root_id, previous_attribute_id,
		  created_at, updated_at, source_id, source_kind, source_path, source_root,
		  proposal_id, proposal_evidence,
		  occurred_start, occurred_end, valid_from, valid_until, time_precision)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?,
		         1, ?, NULL,
		         datetime('now'), datetime('now'), ?, ?, ?, ?, ?, ?,
		         ?, ?, ?, ?, ?)`,
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
		time.occurredStart,
		time.occurredEnd,
		time.validFrom,
		time.validUntil,
		time.precision,
	);
	const memoryId = materializeAttributeMemoryInTx(db, {
		author,
		attributeId: id,
		entityId,
		agentId,
		content: value,
		normalizedContent: normalized,
		importance,
		reviewAfter,
		time,
		proposal,
		actor,
	});
	return {
		entityId,
		aspectId,
		attributeId: id,
		memoryId,
		deduped: false,
		contradictionIds: recordOntologyContradictionsForAttributeInTx(db, {
			agentId,
			partition: ontologyPartitionInDb(db, agentId, proposal.dreaming_pass_id ?? undefined),
			attributeId: id,
		}),
	};
}

function applySetClaimValue(
	db: WriteDb,
	agentId: string,
	proposal: ProposalRow,
	payload: Readonly<Record<string, unknown>>,
	actor: string,
	author: WriteAuthor,
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

	const entityId = resolveOrCreateEntity(
		db,
		agentId,
		entity,
		normalizeEntityType(readString(payload, "entity_type")),
		proposal,
	);
	const aspectId = resolveOrCreateAspect(db, entityId, agentId, aspect, proposal);
	const scope = readScopeSql(
		"",
		dreamingReadScopeInDb(
			db,
			agentId,
			ontologyPartitionInDb(db, agentId, proposal.dreaming_pass_id ?? undefined).compartmentId,
		),
		{ visibility: null },
	);
	const groupKey = canonicalKey(readString(payload, "group_key") ?? readString(payload, "group")) ?? "general";
	const kind = normalizeAttributeKind(readString(payload, "kind"));
	const slot = db
		.prepare(
			`SELECT id, memory_id, content, normalized_content, version, version_root_id, kind, status,
			        occurred_start, valid_from, source_kind, source_id
			 FROM entity_attributes
			 WHERE aspect_id = ?
			   AND agent_id = ?
			   AND kind = ?
			   AND COALESCE(group_key, 'general') = ?
			   AND claim_key = ? ${scope.sql}
			 ORDER BY version DESC, updated_at DESC`,
		)
		.all(aspectId, agentId, kind, groupKey, claimKey, ...scope.args) as Array<{
		id: string;
		memory_id: string | null;
		content: string;
		normalized_content: string;
		version: number | null;
		version_root_id: string | null;
		kind: string;
		status: string;
		occurred_start: string | null;
		valid_from: string | null;
		source_kind: string | null;
		source_id: string | null;
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
			contradictionIds: [],
		};
	}
	if (kind === "constraint" && active.length > 0 && !truthy(payload.force)) {
		throw new OntologyProposalError("Refusing to replace active constraint claim without force", 409);
	}

	const previous = active[0] ?? slot[0] ?? null;
	if (previous === null && writeCaps !== undefined) {
		const attrCount = db
			.prepare(
				`SELECT COUNT(*) AS c FROM entity_attributes
				 WHERE aspect_id = ? AND agent_id = ? AND status = 'active' ${scope.sql}`,
			)
			.get(aspectId, agentId, ...scope.args) as { c: number };
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
	const time = readClaimTime(payload);
	const incomingTime = claimEvidenceTime({ valid_from: time.validFrom, occurred_start: time.occurredStart });
	const incomingCapturedAt = claimSourceCapturedAt(db, agentId, proposal.source_kind, proposal.source_id);
	const newerActive = active
		.filter((row) => {
			const activeTime = claimEvidenceTime(row);
			if (activeTime !== incomingTime) return activeTime !== null && incomingTime !== null && activeTime > incomingTime;
			const activeCapturedAt = claimSourceCapturedAt(db, agentId, row.source_kind, row.source_id);
			return activeCapturedAt !== null && incomingCapturedAt !== null && activeCapturedAt > incomingCapturedAt;
		})
		.sort(
			(a, b) =>
				(claimEvidenceTime(b) ?? "").localeCompare(claimEvidenceTime(a) ?? "") ||
				(claimSourceCapturedAt(db, agentId, b.source_kind, b.source_id) ?? "").localeCompare(
					claimSourceCapturedAt(db, agentId, a.source_kind, a.source_id) ?? "",
				),
		)[0];
	db.prepare(
		`INSERT INTO entity_attributes
		 (id, aspect_id, agent_id, kind, content, normalized_content,
		  confidence, importance, status, superseded_by, group_key, claim_key,
		  version, version_root_id, previous_attribute_id,
		  created_at, updated_at, source_id, source_kind, source_path, source_root,
		  proposal_id, proposal_evidence,
		  occurred_start, occurred_end, valid_from, valid_until, time_precision)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
		         datetime('now'), datetime('now'), ?, ?, ?, ?, ?, ?,
		         ?, ?, ?, ?, ?)`,
	).run(
		id,
		aspectId,
		agentId,
		kind,
		value,
		normalized,
		confidence,
		importance,
		newerActive === undefined ? "active" : "superseded",
		newerActive?.id ?? null,
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
		time.occurredStart,
		time.occurredEnd,
		time.validFrom,
		time.validUntil,
		time.precision,
	);
	const memoryId = materializeAttributeMemoryInTx(db, {
		author,
		attributeId: id,
		entityId,
		agentId,
		content: value,
		normalizedContent: normalized,
		importance,
		reviewAfter,
		time,
		proposal,
		actor,
	});
	if (newerActive !== undefined) {
		supersedeAttributeMemoryInTx(db, {
			author,
			memoryId,
			replacementMemoryId: newerActive.memory_id ?? newerActive.id,
			proposal,
			actor,
		});
		return {
			entityId,
			aspectId,
			attributeId: id,
			memoryId,
			version,
			versionRootId: rootId,
			previousAttributeId: previous?.id ?? null,
			previousWasActive: previous?.status === "active",
			supersededAttributeIds: [],
			supersededByNewerEvidence: newerActive.id,
			contradictionIds: [],
		};
	}
	const contradictionIds = recordOntologyContradictionsForAttributeInTx(db, {
		agentId,
		partition: ontologyPartitionInDb(db, agentId, proposal.dreaming_pass_id ?? undefined),
		attributeId: id,
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
			supersedeAttributeMemoryInTx(db, {
				author,
				memoryId: prior.memory_id,
				replacementMemoryId: memoryId,
				proposal,
				actor,
			});
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
		contradictionIds,
	};
}

function applySupersedeClaimValue(
	db: WriteDb,
	agentId: string,
	proposal: ProposalRow,
	payload: Readonly<Record<string, unknown>>,
	actor: string,
	author: WriteAuthor,
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
		const replacement = applySetClaimValue(
			db,
			agentId,
			proposal,
			{
				entity,
				aspect,
				claim_key: claimKey,
				group_key: groupKey,
				kind,
				value: replacementValue,
				confidence: readNumber(payload, "confidence") ?? proposal.confidence,
				importance: readNumber(payload, "importance") ?? readNumber(payload, "confidence") ?? proposal.confidence,
				entity_type: readString(payload, "entity_type") ?? undefined,
				review_after: readString(payload, "review_after") ?? undefined,
				...claimTimeFields(payload),
			},
			actor,
			author,
		);
		replacementId = typeof replacement.attributeId === "string" ? replacement.attributeId : null;
		if (typeof replacement.supersededByNewerEvidence === "string") {
			return {
				supersededAttributeIds: [],
				replacementAttributeId: replacementId,
				replacementCreated: true,
				supersededByNewerEvidence: replacement.supersededByNewerEvidence,
			};
		}
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
		for (const row of rows) archiveAttributeMemoryInTx(db, row.memory_id, proposal, actor, false);
	} else {
		for (const row of rows) {
			supersedeAttributeMemoryInTx(db, { author, memoryId: row.memory_id, replacementMemoryId, proposal, actor });
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
		archiveAttributeMemoryInTx(db, attribute.memory_id, proposal, actor, truthy(payload.force));
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
function enforceAspectCapForNewAspect(
	db: WriteDb,
	entity: { readonly id: string; readonly name: string },
	agentId: string,
	name: string,
	proposal: ProposalRow,
	writeCaps?: GraphWriteCaps,
): void {
	if (writeCaps === undefined) return;
	const scope = readScopeSql(
		"",
		dreamingReadScopeInDb(
			db,
			agentId,
			ontologyPartitionInDb(db, agentId, proposal.dreaming_pass_id ?? undefined).compartmentId,
		),
		{ visibility: null },
	);
	const key = canonical(name);
	const activeAspect = db
		.prepare(
			`SELECT id FROM entity_aspects
			 WHERE entity_id = ? AND agent_id = ? AND canonical_name = ? AND COALESCE(status, 'active') = 'active' ${scope.sql}`,
		)
		.get(entity.id, agentId, key, ...scope.args);
	if (activeAspect != null) return;
	const aspectCount = db
		.prepare(
			`SELECT COUNT(*) AS c FROM entity_aspects
			 WHERE entity_id = ? AND agent_id = ? AND COALESCE(status, 'active') = 'active' ${scope.sql}`,
		)
		.get(entity.id, agentId, ...scope.args) as { c: number };
	if (aspectCount.c >= writeCaps.maxAspectsPerEntity) {
		const aspects = db
			.prepare(
				`SELECT id, name FROM entity_aspects
				 WHERE entity_id = ? AND agent_id = ? AND COALESCE(status, 'active') = 'active' ${scope.sql}
				 ORDER BY name`,
			)
			.all(entity.id, agentId, ...scope.args) as Array<{ id: string; name: string }>;
		throw new OntologyProposalError(
			`entity '${entity.name}' is at aspect cap (${aspectCount.c}/${writeCaps.maxAspectsPerEntity}), so '${name}' cannot be added as a new aspect. File the claim under the existing aspect that covers it, or make room: merge overlapping aspects (merge_aspects) or rename one to cover both (rename_aspect), with a reason. Existing aspects: ${aspects.map((aspect) => `${aspect.name} (${aspect.id})`).join("; ")}`,
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

	enforceAspectCapForNewAspect(db, entity, agentId, name, proposal, writeCaps);

	const aspectId = resolveOrCreateAspect(db, entity.id, agentId, name, proposal);
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
		archiveAttributeMemoryInTx(db, attribute.memory_id, proposal, actor, truthy(payload.force));
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
	_author: WriteAuthor,
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
	archiveAttributeMemoryInTx(db, row.memory_id, proposal, actor, truthy(payload.force));
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
	actor: string,
	author: WriteAuthor,
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
	restoreAttributeMemoryInTx(db, row.memory_id, proposal, actor);
	for (const active of activeMemories) {
		supersedeAttributeMemoryInTx(db, {
			author,
			memoryId: active.memory_id,
			replacementMemoryId: attributeId,
			proposal,
			actor,
		});
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
	recordOntologyContradictionsForAttributeInTx(db, {
		agentId,
		partition: ontologyPartitionInDb(db, agentId, proposal.dreaming_pass_id ?? undefined),
		attributeId,
	});
	return { attributeId, versionRootId: row.version_root_id ?? attributeId, restored: true };
}

function mergeSemanticEvidenceInTx(
	db: WriteDb,
	table: "entities" | "entity_aspects" | "entity_dependencies",
	kind: "entity" | "aspect" | "dependency",
	sourceId: string,
	targetId: string,
	proposal: ProposalRow,
	removeSource: boolean,
): void {
	const partition: DreamingPartition = ontologyPartitionInDb(
		db,
		proposal.agent_id,
		proposal.dreaming_pass_id ?? undefined,
	);
	assertDreamingMutationLabelInDb(db, table, sourceId, partition);
	assertDreamingMutationLabelInDb(db, table, targetId, partition);
	const citations = prepareTypedStatement<{
		evidence_kind: "memory" | "transcript" | "artifact" | "summary" | "attribute";
		evidence_id: string;
	}>(
		db,
		"SELECT evidence_kind, evidence_id FROM evidence_citations WHERE derived_kind = ? AND derived_id = ? AND agent_id = ?",
	)
		.all(kind, sourceId, proposal.agent_id)
		.map((row) => ({ kind: row.evidence_kind, id: row.evidence_id }));
	recordSemanticCitationsInTx(db, { kind, id: targetId, partition, evidence: citations });
	const evidence = prepareTypedStatement<{ proposal_evidence: string }>(
		db,
		`SELECT proposal_evidence FROM ${table} WHERE id IN (?, ?) AND agent_id = ?`,
	)
		.all(sourceId, targetId, proposal.agent_id)
		.flatMap((row) => parseJsonArray(row.proposal_evidence));
	db.prepare(`UPDATE ${table} SET proposal_id = ?, proposal_evidence = ? WHERE id = ? AND agent_id = ?`).run(
		proposal.id,
		JSON.stringify([...evidence, ...proposalAuditEvidence(proposal)]),
		targetId,
		proposal.agent_id,
	);
	if (removeSource)
		db.prepare("DELETE FROM evidence_citations WHERE derived_kind = ? AND derived_id = ? AND agent_id = ?").run(
			kind,
			sourceId,
			proposal.agent_id,
		);
}

function mergeEntityAspects(
	db: WriteDb,
	agentId: string,
	sourceId: string,
	targetId: string,
	proposal: ProposalRow,
): number {
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
			mergeSemanticEvidenceInTx(db, "entity_aspects", "aspect", aspect.id, target.id, proposal, true);
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

function mergeEntityEdges(
	db: WriteDb,
	agentId: string,
	sourceId: string,
	targetId: string,
	proposal: ProposalRow,
): number {
	let relationshipChanges = mergeEntityDependencies(db, agentId, sourceId, targetId, proposal);

	relationshipChanges += db
		.prepare(
			`DELETE FROM relations
			 WHERE (source_entity_id = ? AND target_entity_id IN (?, ?))
			    OR (source_entity_id = ? AND target_entity_id = ?)`,
		)
		.run(sourceId, sourceId, targetId, targetId, sourceId).changes;
	relationshipChanges += db
		.prepare("UPDATE relations SET source_entity_id = ? WHERE source_entity_id = ?")
		.run(targetId, sourceId).changes;
	relationshipChanges += db
		.prepare("UPDATE relations SET target_entity_id = ? WHERE target_entity_id = ?")
		.run(targetId, sourceId).changes;
	db.prepare(
		"INSERT OR IGNORE INTO memory_entity_mentions (memory_id, entity_id) SELECT memory_id, ? FROM memory_entity_mentions WHERE entity_id = ?",
	).run(targetId, sourceId);
	db.prepare("DELETE FROM memory_entity_mentions WHERE entity_id = ?").run(sourceId);
	return relationshipChanges;
}

function mergeEntityAliases(db: WriteDb, agentId: string, sourceId: string, targetId: string): void {
	db.prepare(
		`DELETE FROM entity_aliases
		 WHERE agent_id = ? AND entity_id = ?
		   AND EXISTS (
			 SELECT 1 FROM entity_aliases kept
			 WHERE kept.agent_id = entity_aliases.agent_id AND kept.entity_id = ?
			   AND kept.canonical_alias = entity_aliases.canonical_alias
			   AND kept.status = entity_aliases.status
		   )`,
	).run(agentId, sourceId, targetId);
	db.prepare(
		`UPDATE entity_aliases
		 SET entity_id = ?, updated_at = datetime('now')
		 WHERE agent_id = ? AND entity_id = ?`,
	).run(targetId, agentId, sourceId);
}

function mergeEntityAssertions(db: WriteDb, agentId: string, sourceId: string, targetId: string): void {
	db.prepare(
		`UPDATE epistemic_assertions
		 SET subject_entity_id = ?, updated_at = datetime('now')
		 WHERE agent_id = ? AND subject_entity_id = ?`,
	).run(targetId, agentId, sourceId);
}

function mergeEntityDependencies(
	db: WriteDb,
	agentId: string,
	sourceId: string,
	targetId: string,
	proposal: ProposalRow,
): number {
	const rows = db
		.prepare(
			`SELECT id, source_entity_id, target_entity_id, dependency_type
			 FROM entity_dependencies
			 WHERE agent_id = ? AND (source_entity_id = ? OR target_entity_id = ?)`,
		)
		.all(agentId, sourceId, sourceId) as Array<{
		id: string;
		source_entity_id: string;
		target_entity_id: string;
		dependency_type: string;
	}>;
	let changes = 0;
	for (const row of rows) {
		const nextSource = row.source_entity_id === sourceId ? targetId : row.source_entity_id;
		const nextTarget = row.target_entity_id === sourceId ? targetId : row.target_entity_id;
		if (nextSource === nextTarget) {
			db.prepare(
				"DELETE FROM evidence_citations WHERE derived_kind = 'dependency' AND derived_id = ? AND agent_id = ?",
			).run(row.id, agentId);
			changes += db
				.prepare("DELETE FROM entity_dependencies WHERE id = ? AND agent_id = ?")
				.run(row.id, agentId).changes;
			continue;
		}

		const duplicate = db
			.prepare(
				`SELECT id FROM entity_dependencies
				 WHERE agent_id = ? AND id != ?
				   AND source_entity_id = ? AND target_entity_id = ? AND dependency_type = ?
				 LIMIT 1`,
			)
			.get(agentId, row.id, nextSource, nextTarget, row.dependency_type) as { id: string } | undefined;
		if (duplicate) {
			mergeSemanticEvidenceInTx(db, "entity_dependencies", "dependency", row.id, duplicate.id, proposal, true);
			changes += db
				.prepare("DELETE FROM entity_dependencies WHERE id = ? AND agent_id = ?")
				.run(row.id, agentId).changes;
			continue;
		}
		changes += db
			.prepare(
				`UPDATE entity_dependencies
				 SET source_entity_id = ?, target_entity_id = ?, updated_at = datetime('now')
				 WHERE id = ? AND agent_id = ?`,
			)
			.run(nextSource, nextTarget, row.id, agentId).changes;
	}
	return changes;
}

function applyMergeEntities(
	db: WriteDb,
	agentId: string,
	proposal: ProposalRow,
	payload: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
	const sources = sourceMergeSpecs(payload);
	const target = resolveMergeEntityRef(
		db,
		agentId,
		"payload.target_entity",
		readString(payload, "target_entity") ?? readString(payload, "target") ?? null,
		readString(payload, "target_entity_id") ?? readString(payload, "target_id") ?? null,
	);
	const alreadyMerged = sources.filter((source) => {
		if (source.id !== null) {
			return (
				getEntityRefById(db, agentId, source.id) === null &&
				wasEntityMergeApplied(db, agentId, source.id, target.id, source.selector)
			);
		}
		if (source.selector === null) return false;
		try {
			resolveEntityRefStrict(db, agentId, source.selector);
			return false;
		} catch (err) {
			if (!(err instanceof OntologyProposalError) || err.status !== 404) throw err;
			return wasEntityMergeApplied(db, agentId, null, target.id, source.selector);
		}
	});
	const pendingSources = sources.filter((source) => !alreadyMerged.includes(source));
	if (pendingSources.length === 0 && alreadyMerged.length > 0) {
		return {
			targetEntityId: target.id,
			targetEntityName: target.name,
			mergedEntities: [],
			alreadyMergedEntities: alreadyMerged.map((source) => source.selector ?? source.id),
			warnings: [],
			relationshipsChanged: 0,
		};
	}
	const plan = buildEntityMergePlan(db, {
		agentId,
		targetEntityId: target.id,
		sourceEntities: pendingSources
			.map((spec) => spec.selector)
			.filter((selector): selector is string => selector !== null),
		sourceEntityIds: pendingSources.map((spec) => spec.id).filter((id): id is string => id !== null),
		force: truthy(payload.force),
	});
	if (plan.blocked) throw new OntologyProposalError(`Merge blocked: ${plan.warnings.join("; ")}`, 409);

	const merged: Array<{ readonly name: string; readonly entityId: string; readonly movedAspects: number }> = [];
	let relationshipChanges = 0;
	for (const source of plan.sources) {
		const movedAspects = mergeEntityAspects(db, agentId, source.id, plan.target.id, proposal);
		relationshipChanges += mergeEntityEdges(db, agentId, source.id, plan.target.id, proposal);
		mergeEntityAliases(db, agentId, source.id, plan.target.id);
		mergeEntityAssertions(db, agentId, source.id, plan.target.id);
		db.prepare(
			`UPDATE entities
			 SET mentions = COALESCE(mentions, 0) + COALESCE((SELECT mentions FROM entities WHERE id = ?), 0),
			     updated_at = datetime('now')
			 WHERE id = ? AND agent_id = ?`,
		).run(source.id, plan.target.id, agentId);
		mergeSemanticEvidenceInTx(db, "entities", "entity", source.id, plan.target.id, proposal, true);
		db.prepare("DELETE FROM entities WHERE id = ? AND agent_id = ?").run(source.id, agentId);
		merged.push({ name: source.name, entityId: source.id, movedAspects });
	}
	if (merged.length === 0) throw new OntologyProposalError("No distinct source entities to merge", 400);
	return {
		targetEntityId: plan.target.id,
		targetEntityName: plan.target.name,
		mergedEntities: merged,
		alreadyMergedEntities: alreadyMerged.map((source) => source.selector ?? source.id),
		warnings: plan.warnings,
		relationshipsChanged: relationshipChanges,
	};
}
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
		mergeSemanticEvidenceInTx(db, "entity_aspects", "aspect", source.id, target.id, proposal, false);
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
		: resolveOrCreateEntity(db, agentId, source, normalizeEntityType(readString(payload, "source_type")), proposal);
	const targetId = targetIdSelector
		? resolveEntityStrict(db, agentId, target).id
		: resolveOrCreateEntity(db, agentId, target, normalizeEntityType(readString(payload, "target_type")), proposal);
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
	_proposal: ProposalRow,
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
	_proposal: ProposalRow,
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

function ontologyPartitionInDb(db: ReadDb, agentId: string, passId?: string): DreamingPartition {
	if (passId !== undefined) return dreamingPassPartitionInDb(db, passId, agentId);
	assertDreamingAgentInDb(db, agentId);
	return { agentId, compartmentId: null };
}

function proposalCitationsInDb(
	db: WriteDb,
	agentId: string,
	evidence: readonly unknown[],
	partition?: DreamingPartition,
): SemanticEvidenceCitation[] {
	const citations: SemanticEvidenceCitation[] = [];
	for (const value of evidence) {
		if (!isRecord(value)) continue;
		if (isDreamingAttentionEvidenceInTx(db, agentId, value)) continue;
		if ("source_ref" in value) {
			const source = requireStrictEpisodicSourceRefInTx(db, agentId, value.source_ref, partition);
			if (typeof value.quote === "string" && !renderDreamingEvidence(source).includes(value.quote))
				throw new OntologyProposalError("Evidence quote no longer matches its source", 409);
			citations.push({ kind: source.kind, id: source.id });
		} else if (typeof value.memory_id === "string") {
			citations.push({ kind: "memory", id: value.memory_id });
		}
	}
	return citations;
}

function proposalTargetCitationsInDb(
	db: WriteDb,
	targets: readonly OntologyMutationTarget[],
	partition: DreamingPartition,
): SemanticEvidenceCitation[] {
	const citations: SemanticEvidenceCitation[] = [];
	const kinds: Readonly<Partial<Record<DreamingMutationTable, SemanticCitationKind>>> = {
		entities: "entity",
		entity_aspects: "aspect",
		entity_dependencies: "dependency",
		epistemic_assertions: "assertion",
	};
	for (const target of targets) {
		if (target.table === "entity_attributes") citations.push({ kind: "attribute", id: target.id });
		else if (target.table === "memories") citations.push({ kind: "memory", id: target.id });
		else {
			const kind = kinds[target.table];
			if (kind === undefined) continue;
			for (const row of prepareTypedStatement<{ evidence_kind: SemanticEvidenceCitation["kind"]; evidence_id: string }>(
				db,
				"SELECT evidence_kind, evidence_id FROM evidence_citations WHERE derived_kind = ? AND derived_id = ? AND agent_id = ?",
			).all(kind, target.id, partition.agentId))
				citations.push({ kind: row.evidence_kind, id: row.evidence_id });
		}
	}
	return citations;
}

function labelProposalRowInTx(
	db: WriteDb,
	table: DreamingMutationTable,
	kind: SemanticCitationKind,
	id: string,
	proposal: ProposalRow,
): void {
	const partition: DreamingPartition = ontologyPartitionInDb(
		db,
		proposal.agent_id,
		proposal.dreaming_pass_id ?? undefined,
	);
	const proposalOwned =
		table === "entities" ||
		table === "entity_aspects" ||
		table === "entity_attributes" ||
		table === "entity_dependencies";
	db.prepare(
		`UPDATE ${table} SET compartment_id = ?${proposalOwned ? `, proposal_id = ${table === "entity_attributes" ? "COALESCE(proposal_id, ?)" : "?"}, proposal_evidence = CASE WHEN proposal_id IS NULL AND proposal_evidence = '[]' THEN ? ELSE proposal_evidence END` : ""}${table === "entities" ? ", dreaming_pass_id = ?" : ""} WHERE id = ? AND agent_id = ?`,
	).run(
		partition.compartmentId,
		...(proposalOwned ? [proposal.id, JSON.stringify(proposalAuditEvidence(proposal))] : []),
		...(table === "entities" ? [proposal.dreaming_pass_id] : []),
		id,
		partition.agentId,
	);

	recordSemanticCitationsInTx(db, {
		kind,
		id,
		partition,
		evidence: proposalCitationsInDb(db, proposal.agent_id, proposalAuditEvidence(proposal), partition),
	});
}

interface OntologyMutationTarget {
	readonly table: DreamingMutationTable;
	readonly id: string;
}

export function assertOntologyOperationPartitionInTx(
	db: WriteDb,
	input: {
		readonly agentId: string;
		readonly passId?: string;
		readonly operation: string;
		readonly payload: Readonly<Record<string, unknown>>;
		readonly evidence?: readonly unknown[];
	},
): readonly OntologyMutationTarget[] {
	const partition: DreamingPartition = ontologyPartitionInDb(db, input.agentId, input.passId);
	for (const evidence of proposalCitationsInDb(db, input.agentId, input.evidence ?? [], partition))
		evidenceCitationInDb(db, partition, evidence);
	const targets = new Map<string, OntologyMutationTarget>();
	const add = (table: DreamingMutationTable, id: string): void => {
		assertDreamingMutationLabelInDb(db, table, id, partition);
		targets.set(`${table}:${id}`, { table, id });
	};
	const select = (table: DreamingMutationTable, where: string, args: readonly unknown[]): string[] => {
		const ids = prepareTypedStatement<{ id: string }>(db, `SELECT id FROM ${table} WHERE ${where}`)
			.all(...args)
			.map((row) => row.id);
		for (const id of ids) add(table, id);
		return ids;
	};
	const entity = (selector: string | null): string | null => {
		if (selector === null) return null;
		const direct = prepareTypedStatement<{ id: string }>(db, "SELECT id FROM entities WHERE id = ?").get(selector);
		const id = direct?.id ?? resolveEntity(db, input.agentId, selector);
		if (id !== null) add("entities", id);
		return id;
	};
	const aspect = (entityId: string | null, selector: string | null): string | null => {
		if (entityId === null || selector === null) return null;
		const row = prepareTypedStatement<{ id: string }>(
			db,
			"SELECT id FROM entity_aspects WHERE entity_id = ? AND agent_id = ? AND (id = ? OR canonical_name = ? OR LOWER(name) = ?) LIMIT 1",
		).get(entityId, input.agentId, selector, canonical(selector), canonical(selector));
		if (row) add("entity_aspects", row.id);
		return row?.id ?? null;
	};
	const p = input.payload;
	const op = input.operation;
	const e = entity(
		op === "create_policy"
			? readPayloadSelector(p, "target_entity", "entity", "entity_id")
			: readPayloadSelector(p, "entity", "entity_id"),
	);
	const a = aspect(e, readPayloadSelector(p, "aspect", "aspect_id"));
	if (["create_entity", "create_action_type", "create_interface"].includes(op))
		entity(readPayloadSelector(p, "name", "action_type", "interface"));
	if (["rename_entity", "archive_entity", "pin_entity", "unpin_entity"].includes(op))
		entity(readPayloadSelector(p, "selector", "entity", "entity_id", "name", "id"));
	if (["create_aspect", "rename_aspect", "archive_aspect"].includes(op))
		aspect(e, readPayloadSelector(p, "selector", "aspect", "aspect_id", "name"));
	if (op === "create_policy") {
		const policyAspect = aspect(e, "policy");
		if (policyAspect !== null)
			select(
				"entity_attributes",
				"aspect_id = ? AND kind = 'constraint' AND group_key = 'policy' AND claim_key = ? AND normalized_content = ? AND status = 'active'",
				[policyAspect, canonicalKey(readString(p, "kind")), canonical(readString(p, "content") ?? "")],
			);
	}
	if (op === "create_link" || op === "attach_interface") {
		const source = entity(readPayloadSelector(p, "source_entity_id", "source_entity", "entity"));
		const target = entity(
			readPayloadSelector(p, "target_entity_id", "target_entity", "interface", "interface_name", "target_interface"),
		);
		if (source && target)
			select(
				"entity_dependencies",
				"source_entity_id = ? AND target_entity_id = ? AND agent_id = ? AND dependency_type = ?",
				[
					source,
					target,
					input.agentId,
					op === "attach_interface" ? "implements" : normalizeDependencyType(readString(p, "link_type")),
				],
			);
	}
	if (op === "update_link" || op === "archive_link") {
		const id = readPayloadSelector(p, "id", "dependency_id", "link_id");
		if (id !== null) select("entity_dependencies", "id = ?", [id]);
	}
	if (op === "merge_entities") {
		const roots = new Set<string>();
		const target = entity(readPayloadSelector(p, "target_entity_id", "target_id", "target_entity", "target"));
		if (target) roots.add(target);
		for (const spec of sourceMergeSpecs(p)) {
			const id = entity(spec.id ?? spec.selector);
			if (id) roots.add(id);
		}
		for (const id of roots) {
			select("entity_aspects", "entity_id = ?", [id]);
			select("entity_dependencies", "source_entity_id = ? OR target_entity_id = ?", [id, id]);
			select("epistemic_assertions", "subject_entity_id = ?", [id]);
			select("memories", "id IN (SELECT memory_id FROM memory_entity_mentions WHERE entity_id = ?)", [id]);
			const neighbors = prepareTypedStatement<{ id: string }>(
				db,
				"SELECT source_entity_id AS id FROM relations WHERE target_entity_id = ? UNION SELECT target_entity_id AS id FROM relations WHERE source_entity_id = ?",
			).all(id, id);
			for (const neighbor of neighbors) add("entities", neighbor.id);
		}
	}
	if (op === "merge_aspects") {
		aspect(e, readPayloadSelector(p, "target", "target_aspect", "target_aspect_id", "aspect"));
		for (const raw of [...readStringArray(p, "sources"), ...readStringArray(p, "source_aspects")]) aspect(e, raw);
	}
	const cascade =
		op === "merge_entities" || op === "merge_aspects" || op === "archive_entity" || op === "archive_aspect";
	if (op === "archive_entity") {
		for (const target of [...targets.values()])
			if (target.table === "entities") select("entity_aspects", "entity_id = ?", [target.id]);
	}
	if (cascade) {
		for (const target of [...targets.values()])
			if (target.table === "entity_aspects") {
				select("entity_attributes", "aspect_id = ?", [target.id]);
				if (op === "merge_entities") select("entity_dependencies", "aspect_id = ?", [target.id]);
			}
	}
	const replacementId = readString(p, "superseded_by");
	if (replacementId !== null) select("entity_attributes", "id = ?", [replacementId]);
	const attributeId = readString(p, "attribute_id");
	if (attributeId !== null) {
		const row = prepareTypedStatement<{ aspect_id: string; kind: string; group_key: string | null; claim_key: string }>(
			db,
			"SELECT aspect_id, kind, group_key, claim_key FROM entity_attributes WHERE id = ?",
		).get(attributeId);
		add("entity_attributes", attributeId);
		if (row && op === "restore_claim_version")
			select(
				"entity_attributes",
				"aspect_id = ? AND kind = ? AND COALESCE(group_key, 'general') = COALESCE(?, 'general') AND claim_key = ? AND status = 'active'",
				[row.aspect_id, row.kind, row.group_key, row.claim_key],
			);
	}
	if (a !== null && ["add_claim_value", "set_claim_value", "supersede_claim_value"].includes(op)) {
		const group = readString(p, "group_key") ?? readString(p, "group") ?? "general";
		const claim = readString(p, "claim_key") ?? readString(p, "claim");
		const duplicate = op === "add_claim_value";
		select(
			"entity_attributes",
			`aspect_id = ? AND kind = ? AND COALESCE(group_key, 'general') = ? AND claim_key = ? ${duplicate ? "AND normalized_content = ? AND status = 'active'" : "AND status = 'active'"}`,
			[
				a,
				normalizeAttributeKind(readString(p, "kind")),
				duplicate ? group : canonicalKey(group),
				duplicate ? claim : canonicalKey(claim),
				...(duplicate ? [canonical(readString(p, "value") ?? "")] : []),
			],
		);
	}

	for (const target of [...targets.values()]) {
		if (target.table !== "entity_attributes") continue;
		const row = prepareTypedStatement<{ memory_id: string | null }>(
			db,
			"SELECT memory_id FROM entity_attributes WHERE id = ?",
		).get(target.id);
		if (row?.memory_id) {
			add("memories", row.memory_id);
			select(
				"memories",
				"id IN (SELECT derived_memory_id FROM derived_memory_sources WHERE source_kind IN ('ontology_claim', 'memory') AND source_id = ?)",
				[row.memory_id],
			);
			select("temporal_edges", "subject_type = 'memory' AND subject_id = ?", [row.memory_id]);
		}
		select("ontology_contradictions", "left_attribute_id = ? OR right_attribute_id = ?", [target.id, target.id]);
	}
	if (op === "archive_entity" || op === "merge_entities")
		for (const target of [...targets.values()])
			if (target.table === "entities")
				select("ontology_contradictions", "entity_id = ? AND status = 'active'", [target.id]);
	const resolvedTargets = [...targets.values()];
	for (const evidence of proposalTargetCitationsInDb(db, resolvedTargets, partition))
		evidenceCitationInDb(db, partition, evidence);
	return resolvedTargets;
}

function applyOperation(
	db: WriteDb,
	proposal: ProposalRow,
	actor: string,
	author: WriteAuthor,
	writeCaps?: GraphWriteCaps,
): Readonly<Record<string, unknown>> {
	const partition: DreamingPartition = ontologyPartitionInDb(
		db,
		proposal.agent_id,
		proposal.dreaming_pass_id ?? undefined,
	);
	assertDreamingMutationLabelInDb(db, "ontology_proposals", proposal.id, partition);
	const targets = [
		...assertOntologyOperationPartitionInTx(db, {
			agentId: proposal.agent_id,
			passId: proposal.dreaming_pass_id ?? undefined,
			operation: proposal.operation,
			payload: parseJsonRecord(proposal.payload),
			evidence: proposalAuditEvidence(proposal),
		}),
	];
	const result = dispatchOperation(db, proposal, actor, author, writeCaps);
	const kinds = {
		entities: "entity",
		entity_aspects: "aspect",
		entity_attributes: "attribute",
		entity_dependencies: "dependency",
		epistemic_assertions: "assertion",
		memories: "memory",
		ontology_contradictions: "contradiction",
		temporal_edges: "temporal_edge",
	} as const;
	for (const table of Object.keys(kinds)) {
		if (
			table !== "entities" &&
			table !== "entity_aspects" &&
			table !== "entity_attributes" &&
			table !== "entity_dependencies"
		)
			continue;
		for (const row of prepareTypedStatement<{ id: string }>(
			db,
			`SELECT id FROM ${table} WHERE proposal_id = ? AND agent_id = ?`,
		).all(proposal.id, proposal.agent_id))
			targets.push({ table, id: row.id });
	}
	const contradictions = new Set(
		targets.filter((target) => target.table === "ontology_contradictions").map((target) => target.id),
	);
	for (const target of [...targets]) {
		if (target.table !== "entity_attributes") continue;
		for (const row of prepareTypedStatement<{ id: string }>(
			db,
			"SELECT id FROM ontology_contradictions WHERE agent_id = ? AND (left_attribute_id = ? OR right_attribute_id = ?)",
		).all(proposal.agent_id, target.id, target.id)) {
			assertDreamingMutationLabelInDb(db, "ontology_contradictions", row.id, partition);
			contradictions.add(row.id);
		}
	}
	for (const id of contradictions) {
		reconcileOntologyContradictionsInTx(db, { agentId: proposal.agent_id, contradictionId: id, partition });
		targets.push({ table: "ontology_contradictions", id });
	}
	for (const target of targets) {
		if (!(target.table in kinds)) continue;
		const kind = Reflect.get(kinds, target.table);
		if (typeof kind !== "string") continue;
		if (
			kind !== "entity" &&
			kind !== "aspect" &&
			kind !== "attribute" &&
			kind !== "dependency" &&
			kind !== "assertion" &&
			kind !== "memory" &&
			kind !== "contradiction" &&
			kind !== "temporal_edge"
		)
			continue;
		if (prepareTypedStatement<{ id: string }>(db, `SELECT id FROM ${target.table} WHERE id = ?`).get(target.id))
			labelProposalRowInTx(db, target.table, kind, target.id, proposal);
	}
	return result;
}

function dispatchOperation(
	db: WriteDb,
	proposal: ProposalRow,
	actor: string,
	author: WriteAuthor,
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
		return applyAddClaimValue(db, proposal.agent_id, proposal, payload, actor, author, writeCaps);
	if (proposal.operation === "set_claim_value")
		return applySetClaimValue(db, proposal.agent_id, proposal, payload, actor, author, writeCaps);
	if (proposal.operation === "merge_entities") return applyMergeEntities(db, proposal.agent_id, proposal, payload);
	if (proposal.operation === "merge_aspects") return applyMergeAspects(db, proposal.agent_id, proposal, payload);
	if (proposal.operation === "supersede_claim_value") {
		return applySupersedeClaimValue(db, proposal.agent_id, proposal, payload, actor, author);
	}
	if (proposal.operation === "archive_claim_value")
		return applyArchiveClaimValue(db, proposal.agent_id, proposal, payload, actor, author);
	if (proposal.operation === "restore_claim_version") {
		return applyRestoreClaimVersion(db, proposal.agent_id, proposal, payload, actor, author);
	}
	if (proposal.operation === "create_link") return applyCreateLink(db, proposal.agent_id, proposal, payload);
	if (proposal.operation === "update_link") return applyUpdateLink(db, proposal.agent_id, proposal, payload);
	if (proposal.operation === "archive_link") return applyArchiveLink(db, proposal.agent_id, proposal, payload, actor);
	if (proposal.operation === "create_policy")
		return applyCreatePolicy(db, proposal.agent_id, proposal, payload, actor, author);
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

async function markFailed(
	accessor: DbAccessor,
	id: string,
	agentId: string,
	err: unknown,
	passId?: string,
): Promise<void> {
	const message = err instanceof Error ? err.message : String(err);
	await runWriteTxAsync(accessor, (db) => {
		const proposal = getProposalInTx(db, id, agentId);
		if (proposal === null) throw new OntologyProposalError("Proposal not found", 404);
		assertDreamingMutationLabelInDb(
			db,
			"ontology_proposals",
			id,
			ontologyPartitionInDb(db, agentId, passId ?? proposal.dreaming_pass_id ?? undefined),
		);
		db.prepare(
			`UPDATE ontology_proposals
			 SET status = 'failed', result = ?, updated_at = ?
			 WHERE id = ? AND agent_id = ? AND status = 'pending'`,
		).run(JSON.stringify({ error: message }), now(), id, agentId);
	});
}

export async function createOntologyProposal(
	accessor: DbAccessor,
	input: CreateOntologyProposalInput,
): Promise<OntologyProposal> {
	const ts = now();
	return await runWriteTxAsync(accessor, (db) => insertProposalInTx(db, input, ts));
}

export async function createOntologyProposals(
	accessor: DbAccessor,
	inputs: readonly CreateOntologyProposalInput[],
): Promise<CreateOntologyProposalsResult> {
	if (inputs.length === 0) throw new OntologyProposalError("proposals are required", 400);
	if (inputs.length > 500) throw new OntologyProposalError("cannot create more than 500 proposals at once", 400);
	return await runWriteTxAsync(accessor, (db) => createOntologyProposalsInTx(db, inputs));
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

export async function getOntologyProposal(
	accessor: DbAccessor,
	id: string,
	agentId: string,
): Promise<OntologyProposal | null> {
	const row = await getProposalReadRow(accessor, id, agentId);
	return row === null ? null : toProposal(row);
}

export async function getOntologyProposalEvidence(
	accessor: DbAccessor,
	id: string,
	agentId: string,
): Promise<OntologyProposalEvidenceResult> {
	const proposal = await getOntologyProposal(accessor, id, agentId);
	if (proposal === null) throw new OntologyProposalError("Proposal not found", 404);
	const items = await accessor.withReadDbAsync(
		async (db) => proposalEvidenceRefs(proposal).map((ref) => resolveOntologyEvidenceRef(db, agentId, ref)),
		{ siteToken: "ontology-proposals.ts:3190" },
	);
	return { proposal, items, count: items.length };
}

export async function listOntologyProposals(
	accessor: DbAccessor,
	params: ListOntologyProposalsParams,
): Promise<{
	readonly items: readonly OntologyProposal[];
	readonly limit: number;
	readonly offset: number;
}> {
	const limit = Math.min(Math.max(params.limit ?? 50, 1), 200);
	const offset = Math.max(params.offset ?? 0, 0);
	return await accessor.withReadDbAsync(
		async (db) => {
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
		},
		{ siteToken: "ontology-proposals.ts:3207" },
	);
}

export async function listOntologyProposalConflicts(
	accessor: DbAccessor,
	params: { readonly agentId: string; readonly limit?: number },
): Promise<OntologyProposalConflictsResult> {
	const limit = Math.min(Math.max(params.limit ?? 500, 1), 1000);
	return await accessor.withReadDbAsync(
		async (db) => {
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
		},
		{ siteToken: "ontology-proposals.ts:3239" },
	);
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
		occurredStart: typeof row.occurred_start === "string" ? row.occurred_start : null,
		occurredEnd: typeof row.occurred_end === "string" ? row.occurred_end : null,
		validFrom: typeof row.valid_from === "string" ? row.valid_from : null,
		validUntil: typeof row.valid_until === "string" ? row.valid_until : null,
		timePrecision: typeof row.time_precision === "string" ? row.time_precision : null,
		createdAt: row.created_at as string,
		updatedAt: row.updated_at as string,
	};
}

export async function listClaimVersions(
	accessor: DbAccessor,
	params: ClaimVersionReadParams,
): Promise<{ readonly items: readonly ClaimVersionItem[]; readonly count: number }> {
	const groupKey = canonicalKey(params.group) ?? "general";
	const claimKey = canonicalKey(params.claim);
	if (claimKey === null) throw new OntologyProposalError("claim is required", 400);
	const kind = params.kind ?? "attribute";
	return await accessor.withReadDbAsync(
		async (db) => {
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
		},
		{ siteToken: "ontology-proposals.ts:3323" },
	);
}

export async function getClaimVersion(
	accessor: DbAccessor,
	params: ClaimVersionReadParams & { readonly version: number },
): Promise<ClaimVersionItem | null> {
	const versions = await listClaimVersions(accessor, params);
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

function wasEntityMergeApplied(
	db: ReadDb,
	agentId: string,
	sourceId: string | null,
	targetId: string,
	sourceSelector: string | null,
): boolean {
	const needle = sourceId ?? sourceSelector;
	if (needle === null) return false;
	const rows = db
		.prepare(
			`SELECT result FROM ontology_proposals
			 WHERE agent_id = ? AND operation = 'merge_entities' AND status = 'applied'
			   AND result LIKE ?`,
		)
		.all(agentId, `%${needle}%`) as Array<{ result: string | null }>;
	for (const row of rows) {
		if (row.result === null) continue;
		try {
			const result = parseJsonRecord(row.result);
			if (readString(result, "targetEntityId") !== targetId) continue;
			const merged = result.mergedEntities;
			if (!Array.isArray(merged)) continue;
			if (
				merged.some((item) => {
					if (!isRecord(item)) return false;
					if (sourceId !== null) return readString(item, "entityId") === sourceId;
					const name = readString(item, "name");
					return name !== null && canonical(name) === canonical(sourceSelector ?? "");
				})
			)
				return true;
		} catch {}
	}
	return false;
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
export async function findDuplicateEntityMerges(
	accessor: DbAccessor,
	params: FindDuplicateEntityMergesParams,
): Promise<readonly DuplicateEntityMergeCandidate[]> {
	const agentId = requireText(params.agentId, "agentId");
	const canonicalName = canonical(params.name);
	if (canonicalName.length === 0) return [];
	return await accessor.withReadDbAsync(async (db) => duplicateMergeCandidates(db, agentId, 1, canonicalName, true), {
		siteToken: "ontology-proposals.ts:3803",
	});
}

export async function proposeDuplicateEntityMerges(
	accessor: DbAccessor,
	params: ProposeDuplicateEntityMergesParams,
): Promise<DuplicateEntityMergeResult> {
	const agentId = requireText(params.agentId, "agentId");
	const limit = Math.min(Math.max(params.limit ?? 25, 1), 100);
	const items = await accessor.withReadDbAsync(async (db) => duplicateMergeCandidates(db, agentId, limit), {
		siteToken: "ontology-proposals.ts:3814",
	});
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

	const written = await createOntologyProposals(
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
			author: requireWriteAuthor(params.author),
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

export async function createEntityMergePlan(
	accessor: DbAccessor,
	params: EntityMergePlanParams,
): Promise<EntityMergePlanResult> {
	const agentId = requireText(params.agentId, "agentId");
	const dryRun = params.writeProposal !== true;
	const plan = await accessor.withReadDbAsync(
		async (db) => buildEntityMergePlan(db, { ...params, agentId }, "manual_entity_merge"),
		{ siteToken: "ontology-proposals.ts:3865" },
	);
	if (dryRun || plan.blocked) return { ...plan, dryRun: true };
	const proposal = await createOntologyProposal(accessor, {
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
		author: requireWriteAuthor(params.author),
	});
	return { ...plan, dryRun: false, proposal };
}

export async function applyOntologyProposal(
	accessor: DbAccessor,
	params: ApplyOntologyProposalParams,
): Promise<OntologyProposal> {
	try {
		return await runWriteTxAsync(accessor, (db) => {
			let proposal = getProposalInTx(db, params.id, params.agentId);
			if (proposal === null) throw new OntologyProposalError("Proposal not found", 404);
			if (proposal.status !== "pending") {
				throw new OntologyProposalError(`Proposal is ${proposal.status}, not pending`, 409);
			}

			if (params.passId !== undefined) {
				const partition: DreamingPartition = ontologyPartitionInDb(db, params.agentId, params.passId);
				assertDreamingMutationLabelInDb(db, "ontology_proposals", proposal.id, partition);
				proposal = { ...proposal, dreaming_pass_id: params.passId };
			}
			const result = applyOperation(db, proposal, params.actor, params.author, params.writeCaps);
			const ts = now();
			db.prepare(
				`UPDATE ontology_proposals
				 SET status = 'applied', applied_by = ?, result = ?,
				     applied_at = ?, updated_at = ?, dreaming_pass_id = ?
				 WHERE id = ? AND agent_id = ?`,
			).run(params.actor, JSON.stringify(result), ts, ts, proposal.dreaming_pass_id, params.id, params.agentId);
			return readBackInTx(db, params.id, params.agentId);
		});
	} catch (err) {
		if (err instanceof OntologyProposalError && err.status !== 404 && err.status !== 409) {
			try {
				await markFailed(accessor, params.id, params.agentId, err, params.passId);
			} catch (markError) {
				console.error("[ontology] failed to mark proposal as failed", {
					proposalId: params.id,
					agentId: params.agentId,
					passId: params.passId,
					error: markError instanceof Error ? markError.message : String(markError),
				});
			}
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
		author: params.author,
		agentId: params.agentId,
		passId: params.passId,
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

export async function applyOntologyOperation(
	accessor: DbAccessor,
	params: ApplyOntologyOperationParams,
): Promise<ApplyOntologyOperationResult> {
	if (params.propose && params.dryRun) {
		throw new OntologyProposalError("--dry-run and --propose cannot be used together", 400);
	}
	if (Object.keys(params.payload).length === 0) throw new OntologyProposalError("payload is required", 400);
	if (params.propose) {
		const proposal = await createOntologyProposal(accessor, operationToProposalInput(params));
		return { proposal, result: null, dryRun: false, proposed: true };
	}

	let preview: ApplyOntologyOperationResult | null = null;
	try {
		const result = await runWriteTxAsync(accessor, (db) => {
			assertOntologyOperationPartitionInTx(db, params);
			const inserted = insertProposalInTx(db, operationToProposalInput(params), now());
			const row = getProposalInTx(db, inserted.id, params.agentId);
			if (row === null) throw new OntologyProposalError("Proposal not found", 404);
			const operationResult = applyOperation(db, row, params.actor, params.author, params.writeCaps);
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

export async function applyOntologyOperationBatch(
	accessor: DbAccessor,
	params: ApplyOntologyOperationBatchParams,
): Promise<ApplyOntologyOperationBatchResult> {
	if (params.operations.length === 0) throw new OntologyProposalError("operations are required", 400);
	if (params.operations.length > 500)
		throw new OntologyProposalError("cannot apply more than 500 operations at once", 400);
	if (params.propose && params.dryRun) {
		throw new OntologyProposalError("--dry-run and --propose cannot be used together", 400);
	}

	if (params.propose) {
		const written = await createOntologyProposals(
			accessor,
			params.operations.map((operation) => ({
				agentId: params.agentId,
				passId: params.passId,
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
				author: requireWriteAuthor(params.author),
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
		return await runWriteTxAsync(accessor, (db) => applyOntologyOperationBatchInTx(db, params));
	}

	let preview: ApplyOntologyOperationBatchResult | null = null;
	try {
		const result = await runWriteTxAsync(accessor, (db) => {
			const items: ApplyOntologyOperationResult[] = [];
			const errors: OntologyOperationBatchError[] = [];
			for (const [index, operation] of params.operations.entries()) {
				try {
					const inserted = insertProposalInTx(
						db,
						{
							agentId: params.agentId,
							passId: params.passId,
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
							author: requireWriteAuthor(params.author),
						},
						now(),
					);
					const row = getProposalInTx(db, inserted.id, params.agentId);
					if (row === null) throw new OntologyProposalError("Proposal not found", 404);
					const operationResult = applyOperation(db, row, params.actor, params.author, params.writeCaps);
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

export async function rejectOntologyProposal(
	accessor: DbAccessor,
	params: RejectOntologyProposalParams,
): Promise<OntologyProposal> {
	return await runWriteTxAsync(accessor, (db) => {
		const proposal = getProposalInTx(db, params.id, params.agentId);
		if (proposal === null) throw new OntologyProposalError("Proposal not found", 404);
		if (proposal.status !== "pending") {
			throw new OntologyProposalError(`Proposal is ${proposal.status}, not pending`, 409);
		}

		const partition: DreamingPartition = ontologyPartitionInDb(
			db,
			params.agentId,
			params.passId ?? proposal.dreaming_pass_id ?? undefined,
		);
		assertDreamingMutationLabelInDb(db, "ontology_proposals", proposal.id, partition);
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
