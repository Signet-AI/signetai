import { SOURCE_NATIVE_TOPOLOGY_ENTITY_TYPES } from "@signet/core";
import type { DbAccessor, ReadDb, WriteDb } from "../db-accessor";
import { findEpisodicSourceAgentIds, readEpisodicSource } from "../episodic-sources";
import {
	type GraphWriteCaps,
	type OntologyOperationInput,
	applyOntologyOperationBatchInTx,
	createOntologyProposalsInTx,
} from "../ontology-proposals";
import { runWriteBatches } from "../yielding-writes";
import { type DreamingAttention, enqueueDreamingAttentionInTx, getDreamingAttentionById } from "./dreaming-attention";
import { type DreamingAgentEvidence, createDreamingAgentEvidence } from "./dreaming-evidence";
import { DREAMING_OPERATION_IDS } from "./dreaming-operation-contract";

export interface DreamingOperationRequest {
	readonly operation: string;
	readonly payload: Readonly<Record<string, unknown>>;
	readonly reason?: string;
	readonly evidence?: readonly unknown[];
	readonly provenance?: string;
	readonly confidence?: number;
	readonly risk?: string | null;
}

export interface DreamingOperationItem {
	readonly index: number;
	readonly ok: boolean;
	readonly proposal?: unknown;
	readonly result?: unknown;
	readonly error?: string;
}

export interface ApplyDreamingOperationsResult {
	readonly ok: boolean;
	readonly items: readonly DreamingOperationItem[];
	readonly error?: string;
	/** First original request index that did not commit after a retriable batch failure. */
	readonly retryFrom?: number;
	/** Retry only the uncommitted suffix. Replaying returned items duplicates audit/provenance. */
	readonly retryable?: boolean;
}

export interface ApplyDreamingOperationsParams {
	readonly accessor: DbAccessor;
	readonly agentId: string;
	readonly actor: string;
	readonly operations: readonly DreamingOperationRequest[];
	readonly passId?: string;
	readonly writeCaps?: GraphWriteCaps;
}

export const DREAMING_MAX_OPERATIONS_PER_REQUEST = 100;
const DREAMING_WRITE_MAX_OPERATIONS_PER_TX = 10;
const DREAMING_WRITE_MAX_TX_DURATION_MS = 50;

const FLAG_OP = "flag";
const DECLINE_ATTENTION_OP = "decline_attention";
const HYGIENE_ARCHIVE_OPS = new Set([
	"archive_entity",
	"archive_aspect",
	"archive_claim_value",
	"archive_link",
	"merge_entities",
	"merge_aspects",
]);

function citationRecord(value: unknown): {
	readonly sourceRef: string;
	readonly sourceKind: string;
	readonly sourceId: string;
	readonly sourcePath: string | null;
	readonly quote: string;
} | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	const citation = value as Record<string, unknown>;
	const sourceRef = typeof citation.source_ref === "string" ? citation.source_ref.trim() : "";
	const sourceKind = typeof citation.source_kind === "string" ? citation.source_kind.trim() : "";
	const sourceId = typeof citation.source_id === "string" ? citation.source_id.trim() : "";
	const sourcePath = typeof citation.source_path === "string" ? citation.source_path.trim() : null;
	const quote = typeof citation.quote === "string" ? citation.quote.trim() : "";
	// The canonical source_ref is "kind:id" (e.g. transcript:abc). When the
	// agent supplies only {quote, source_ref}, derive kind and id from it.
	let kind = sourceKind;
	let id = sourceId;
	const colon = sourceRef.indexOf(":");
	if (colon > 0) {
		if (!kind) kind = sourceRef.slice(0, colon);
		if (!id) id = sourceRef.slice(colon + 1);
	}
	return sourceRef && kind && id && quote ? { sourceRef, sourceKind: kind, sourceId: id, sourcePath, quote } : null;
}

/**
 * Resolve an exact-quote citation against the episodic source store itself.
 * The Dreaming pass no longer receives an injected evidence window: citations
 * validate against the same immutable store the search tools read, so an
 * agent can cite any in-scope source it found and quoted verbatim.
 */
interface CitationResolution {
	readonly evidence: DreamingAgentEvidence | null;
	readonly sourceAgentIds: readonly string[];
}

function citeEvidence(accessor: DbAccessor, agentId: string, citation: unknown): CitationResolution {
	const requested = citationRecord(citation);
	if (requested === null) return { evidence: null, sourceAgentIds: [] };
	const result = accessor.withReadDb((db) => {
		const source = readEpisodicSource(db, { agentId, from: requested.sourceRef });
		if (source !== null && (source.kind !== "transcript" || source.completed)) {
			return { evidence: createDreamingAgentEvidence([source]), sourceAgentIds: [] };
		}
		return { evidence: [], sourceAgentIds: findEpisodicSourceAgentIds(db, requested.sourceRef) };
	});
	return {
		evidence:
			result.evidence.find(
				(record) =>
					record.sourceRef === requested.sourceRef &&
					record.sourceKind === requested.sourceKind &&
					record.sourceId === requested.sourceId &&
					(requested.sourcePath === null || record.sourcePath === requested.sourcePath) &&
					record.content.includes(requested.quote),
			) ?? null,
		sourceAgentIds: result.sourceAgentIds,
	};
}

type DreamingOperationProvenance = {
	readonly evidence: readonly unknown[];
	readonly sourceKind: string;
	readonly sourceId: string;
	readonly sourcePath: string | null;
	readonly sourceRoot: string;
};

type ValidatedDreamingOperation = {
	readonly index: number;
	readonly input: OntologyOperationInput | null;
	readonly attentionId: string | null;
	/** Queue-only op that resolves its cited attention record instead of an ontology write. */
	readonly decline?: boolean;
	/** Content operation was escalated for an explicit user decision. */
	readonly reviewOnly?: boolean;
};

function semanticDuplicateIds(accessor: DbAccessor, agentId: string, canonicalName: string): ReadonlySet<string> {
	const placeholders = SOURCE_NATIVE_TOPOLOGY_ENTITY_TYPES.map(() => "?").join(", ");
	return accessor.withReadDb((db) => {
		const rows = db
			.prepare(
				`SELECT id FROM entities
				 WHERE agent_id = ? AND COALESCE(status, 'active') = 'active'
				   AND canonical_name = ?
				   AND COALESCE(pinned, 0) = 0
				   AND NOT (entity_type IN (${placeholders}) OR (entity_type = 'source' AND source_root IS NOT NULL))`,
			)
			.all(agentId, canonicalName, ...SOURCE_NATIVE_TOPOLOGY_ENTITY_TYPES) as Array<{ id: string }>;
		return new Set(rows.map((row) => row.id));
	});
}

function asStringRecord(value: unknown): Readonly<Record<string, string>> | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const record: Record<string, string> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (typeof entry === "string") record[key] = entry;
	}
	return Object.keys(record).length > 0 ? record : undefined;
}

/**
 * Mint hygiene attention for every flag op in the batch. Returns operation
 * index -> minted attention id, so later ops in the same batch can cite
 * provenance "attention:$<index>". All flags are minted in one bounded
 * request-level transaction: a flag prefix is unusable without the later
 * operations it authorizes, so this prelude must commit atomically or not at
 * all before the yielding ontology writer begins.
 */
async function mintFlags(
	accessor: DbAccessor,
	agentId: string,
	operations: readonly DreamingOperationRequest[],
): Promise<Map<number, string>> {
	const flagged = operations.flatMap((operation, index) =>
		operation.operation === FLAG_OP ? [{ index, operation }] : [],
	);
	const result = await runWriteBatches(
		accessor,
		flagged,
		(db, entry) => {
			const subjectRef =
				typeof entry.operation.payload.subjectRef === "string" ? entry.operation.payload.subjectRef.trim() : "";
			if (!subjectRef) return { index: entry.index, attentionId: null };
			const priority =
				typeof entry.operation.payload.priority === "number" ? entry.operation.payload.priority : undefined;
			const attentionId = enqueueDreamingAttentionInTx(db, {
				agentId,
				kind: "hygiene",
				subjectRef,
				details: asStringRecord(entry.operation.payload.details),
				priority,
			});
			return { index: entry.index, attentionId };
		},
		{
			label: "dreaming attention flags",
			// A request has at most 100 operations. Keep the flag prelude atomic
			// so an admission failure cannot leave a prefix that a retry re-mints.
			maxPerTx: DREAMING_MAX_OPERATIONS_PER_REQUEST,
		},
	);
	if (result.stopped === "failed") throw new Error(result.error ?? "Dreaming attention flag write failed");
	return new Map(
		result.items.flatMap((entry) => (entry.attentionId === null ? [] : [[entry.index, entry.attentionId] as const])),
	);
}

/**
 * Resolve attention provenance for a hygiene archive/merge op. The target
 * must be exactly the flagged row: the id match and subjectRef pin the target,
 * so the op cannot redirect to anything the flag did not name.
 */
function attentionProvenance(
	accessor: DbAccessor,
	agentId: string,
	operation: DreamingOperationRequest,
	mintedById: ReadonlyMap<number, string>,
	operations: readonly DreamingOperationRequest[],
	operationIndex: number,
): { readonly provenance: DreamingOperationProvenance; readonly attentionId: string } | null {
	const reference = operation.provenance?.trim();
	if (!reference?.startsWith("attention:")) return null;
	if (!HYGIENE_ARCHIVE_OPS.has(operation.operation)) return null;
	const payload = operation.payload;

	let attention: DreamingAttention | null = null;
	const sameBatch = reference.match(/^attention:\$(\d+)$/);
	if (sameBatch !== null) {
		const flagIndex = sameBatchFlagIndex(accessor, agentId, operations, operationIndex, operation);
		if (flagIndex === null) return null;
		const attentionId = mintedById.get(flagIndex);
		if (attentionId !== undefined) attention = getDreamingAttentionById(accessor, { agentId, id: attentionId });
	} else {
		const attentionId = reference.slice("attention:".length);
		if (attentionId) attention = getDreamingAttentionById(accessor, { agentId, id: attentionId });
	}
	if (attention === null || attention.kind !== "hygiene") return null;

	if (!hasExpectedAttentionTarget(accessor, agentId, operation, attention)) return null;

	return {
		provenance: {
			evidence: [
				{
					source_ref: reference,
					source_kind: "attention",
					source_id: attention.id,
					subject_ref: attention.subjectRef,
					details: attention.details,
				},
			],
			sourceKind: "attention",
			sourceId: attention.id,
			sourcePath: attention.subjectRef,
			sourceRoot: "dreaming_attention",
		},
		attentionId: attention.id,
	};
}

/** The row id a hygiene subjectRef pins: the kind prefix plus the id. */
function pinnedBySubjectRef(subjectRef: string, prefix: string): string | null {
	if (!subjectRef.startsWith(prefix)) return null;
	const id = subjectRef.slice(prefix.length);
	return id.length > 0 ? id : null;
}

/** Validate the exact target named by a hygiene attention record. */
function hasExpectedAttentionTarget(
	accessor: DbAccessor,
	agentId: string,
	operation: DreamingOperationRequest,
	attention: DreamingAttention,
): boolean {
	const payload = operation.payload;
	if (operation.operation === "archive_entity") {
		return pinnedTarget(payload, attention, "entity:", "entityId");
	}
	if (operation.operation === "archive_aspect") {
		return pinnedTarget(payload, attention, "aspect:", "aspectId");
	}
	if (operation.operation === "archive_claim_value") {
		return pinnedTarget(payload, attention, "attribute:", "attributeId");
	}
	if (operation.operation === "archive_link") {
		return pinnedTarget(payload, attention, "link:", "linkId");
	}
	if (operation.operation === "merge_entities") {
		const targets = Array.isArray(payload.targets)
			? payload.targets.filter((value): value is string => typeof value === "string")
			: [];
		const survivor = typeof payload.survivor === "string" ? payload.survivor : "";
		// The subjectRef is the canonical pin: agent-minted flags carry the
		// canonical name in `duplicate:<name>` and may omit details, while
		// daemon-enqueued flags repeat it in details.canonicalName (#1168).
		const canonicalName =
			attention.details.canonicalName ?? pinnedBySubjectRef(attention.subjectRef, "duplicate:") ?? "";
		const groupIds = semanticDuplicateIds(accessor, agentId, canonicalName);
		return (
			canonicalName.length > 0 &&
			attention.subjectRef === `duplicate:${canonicalName}` &&
			groupIds.size > 1 &&
			groupIds.has(survivor) &&
			targets.length >= 2 &&
			targets.every((id) => groupIds.has(id)) &&
			targets.includes(survivor) &&
			targets.some((id) => id !== survivor)
		);
	}
	if (operation.operation === "merge_aspects") {
		// The flag names the over-cap aspect; the merge must fold it into a
		// target. The subjectRef is the pin; details.aspectId is an optional
		// cross-check — a contradictory details id must reject, not redirect
		// the merge to a different aspect (#1168).
		const sources = Array.isArray(payload.sources)
			? payload.sources.filter((value): value is string => typeof value === "string")
			: [];
		const pinnedAspect = pinnedBySubjectRef(attention.subjectRef, "aspect:");
		const detailAgrees =
			pinnedAspect !== null &&
			(attention.details.aspectId === undefined || attention.details.aspectId === pinnedAspect);
		return (
			detailAgrees &&
			typeof payload.target === "string" &&
			sources.length >= 1 &&
			pinnedAspect !== null &&
			sources.includes(pinnedAspect)
		);
	}
	return false;
}

/**
 * Resolve a same-request flag reference. A retry keeps the source request's
 * `attention:$<index>` coordinate even though `operations.slice(retryFrom)`
 * rebases the local array. In that continuation form, only a preceding flag
 * that pins this exact hygiene target can stand in for the original index.
 */
function sameBatchFlagIndex(
	accessor: DbAccessor,
	agentId: string,
	operations: readonly DreamingOperationRequest[],
	operationIndex: number,
	operation: DreamingOperationRequest,
): number | null {
	const reference = operation.provenance?.trim();
	const sameBatch = reference?.match(/^attention:\$(\d+)$/);
	if (sameBatch === undefined || sameBatch === null) return null;
	const indexText = sameBatch[1];
	if (indexText === undefined) return null;
	const referencedIndex = Number.parseInt(indexText, 10);
	const referenced = operations[referencedIndex];
	if (referencedIndex < operationIndex && referenced?.operation === FLAG_OP) {
		const subjectRef = stringField(referenced.payload, "subjectRef");
		if (subjectRef === null) return null;
		const attention: DreamingAttention = {
			id: `preflight:${referencedIndex}`,
			kind: "hygiene",
			subjectRef,
			details: asStringRecord(referenced.payload.details) ?? {},
			priority: 0,
			createdAt: "",
		};
		// A valid local coordinate is authoritative. If it names a flag for a
		// different target, do not let suffix recovery redirect the archive.
		return hasExpectedAttentionTarget(accessor, agentId, operation, attention) ? referencedIndex : null;
	}

	// A retry keeps the source request's coordinate even after slicing the
	// committed prefix away. The coordinate can still be in bounds in the
	// retained suffix, but it no longer identifies the original flag. Search
	// only preceding flags and keep the target-pinning check above intact.
	for (let index = operationIndex - 1; index >= 0; index -= 1) {
		const candidate = operations[index];
		if (candidate?.operation !== FLAG_OP) continue;
		const subjectRef = stringField(candidate.payload, "subjectRef");
		if (subjectRef === null) continue;
		const attention: DreamingAttention = {
			id: `continuation:${index}`,
			kind: "hygiene",
			subjectRef,
			details: asStringRecord(candidate.payload.details) ?? {},
			priority: 0,
			createdAt: "",
		};
		if (hasExpectedAttentionTarget(accessor, agentId, operation, attention)) return index;
	}
	return null;
}

/**
 * An archive op targets exactly the flagged row when the subjectRef pins the
 * same id. The details id fields are an optional cross-check: daemon-enqueued
 * attention repeats the id there, but agent-minted flags may omit it entirely
 * (#1168) — the subjectRef is mandatory and already pins the target, so a
 * missing details id must not reject the archive, while a contradictory one
 * (a redirect) must.
 */
function pinnedTarget(
	payload: Readonly<Record<string, unknown>>,
	attention: DreamingAttention,
	prefix: string,
	detailKey: keyof DreamingAttention["details"],
): boolean {
	const target = typeof payload.target === "string" ? payload.target : null;
	const pinned = target !== null ? pinnedBySubjectRef(attention.subjectRef, prefix) : null;
	if (pinned === null || target !== pinned) return false;
	const detail = attention.details[detailKey];
	return detail === undefined || detail === target;
}

function provenanceForEvidence(
	accessor: DbAccessor,
	agentId: string,
	operation: DreamingOperationRequest,
): { readonly provenance: DreamingOperationProvenance | null; readonly scopeMismatch: string | null } {
	const citations = operation.evidence ?? [];
	if (citations.length === 0) return { provenance: null, scopeMismatch: null };
	const matched: DreamingAgentEvidence[] = [];
	for (const citation of citations) {
		const resolution = citeEvidence(accessor, agentId, citation);
		if (resolution.evidence === null) {
			if (resolution.sourceAgentIds.length > 0) {
				const scopes = resolution.sourceAgentIds.map((sourceAgentId) => `'${sourceAgentId}'`).join(", ");
				return {
					provenance: null,
					scopeMismatch: `Cited evidence belongs to scope${resolution.sourceAgentIds.length === 1 ? "" : "s"} ${scopes} but this operation targets '${agentId}'. Search evidence in the target scope before applying the operation.`,
				};
			}
			return { provenance: null, scopeMismatch: null };
		}
		matched.push(resolution.evidence);
	}
	const provenance = matched.find((source) => source.sourceEntryId !== null) ?? matched[0];
	if (!provenance) return { provenance: null, scopeMismatch: null };
	return {
		provenance: {
			evidence: citations,
			sourceKind: provenance.sourceKind,
			sourceId: provenance.sourceEntryId ?? provenance.sourceId,
			sourcePath: provenance.sourcePath,
			sourceRoot: "dreaming",
		},
		scopeMismatch: null,
	};
}

// --- model payload -> shared applicator payload mapping --------------------

function lookupString(db: ReadDb, sql: string, ...params: unknown[]): string | null {
	const row = db.prepare(sql).get(...params) as { value: string | null } | undefined;
	return row?.value ?? null;
}

function lookupEntityName(accessor: DbAccessor, agentId: string, entityId: string): string | null {
	return accessor.withReadDb((db) =>
		lookupString(
			db,
			"SELECT name AS value FROM entities WHERE id = ? AND agent_id = ? AND COALESCE(status,'active') = 'active'",
			entityId,
			agentId,
		),
	);
}

function lookupAspectName(accessor: DbAccessor, agentId: string, entityId: string, aspectId: string): string | null {
	return accessor.withReadDb((db) =>
		lookupString(
			db,
			"SELECT name AS value FROM entity_aspects WHERE id = ? AND entity_id = ? AND agent_id = ? AND COALESCE(status,'active') = 'active'",
			aspectId,
			entityId,
			agentId,
		),
	);
}

function lookupAspectEntityId(accessor: DbAccessor, agentId: string, aspectId: string): string | null {
	return accessor.withReadDb((db) =>
		lookupString(
			db,
			"SELECT entity_id AS value FROM entity_aspects WHERE id = ? AND agent_id = ? AND COALESCE(status,'active') = 'active'",
			aspectId,
			agentId,
		),
	);
}

function lookupActiveClaimAttributeId(
	accessor: DbAccessor,
	agentId: string,
	aspectId: string,
	claimKey: string,
): string | null {
	return accessor.withReadDb((db) =>
		lookupString(
			db,
			"SELECT id AS value FROM entity_attributes WHERE aspect_id = ? AND agent_id = ? AND claim_key = ? AND status = 'active' ORDER BY created_at DESC, id ASC LIMIT 1",
			aspectId,
			agentId,
			claimKey,
		),
	);
}

function stringField(payload: Readonly<Record<string, unknown>>, key: string): string | null {
	const value = payload[key];
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function stringArrayField(payload: Readonly<Record<string, unknown>>, key: string): string[] | null {
	const value = payload[key];
	if (!Array.isArray(value)) return null;
	const items = value
		.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
		.map((s) => s.trim());
	return items.length > 0 ? items : null;
}

/**
 * Convert a model-facing payload to the shared applicator shape. Returns null
 * when a referenced row cannot be resolved — the caller rejects the op rather
 * than letting name-based applicators implicitly create rows from raw ids.
 */
function toApplicatorPayload(
	accessor: DbAccessor,
	agentId: string,
	operation: string,
	payload: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> | null {
	const target = stringField(payload, "target");
	const reason = stringField(payload, "reason") ?? undefined;
	switch (operation) {
		case "archive_entity":
			return target === null ? null : { entity_id: target, reason };
		case "archive_aspect": {
			if (target === null) return null;
			const entityId = lookupAspectEntityId(accessor, agentId, target);
			return entityId === null ? null : { entity_id: entityId, aspect_id: target, reason };
		}
		case "archive_claim_value":
			return target === null ? null : { attribute_id: target, reason };
		case "archive_link":
			return target === null ? null : { id: target, reason };
		case "merge_entities": {
			const targets = stringArrayField(payload, "targets");
			const survivor = stringField(payload, "survivor");
			if (targets === null || survivor === null) return null;
			const sourceIds = targets.filter((id) => id !== survivor);
			return { target_entity_id: survivor, source_entity_ids: sourceIds };
		}
		case "merge_aspects": {
			const entityId = stringField(payload, "entityId");
			const target = stringField(payload, "target");
			const sources = stringArrayField(payload, "sources");
			if (entityId === null || target === null || sources === null || sources.length === 0) return null;
			const name = lookupEntityName(accessor, agentId, entityId);
			return name === null
				? null
				: { entity: name, target, sources, new_name: stringField(payload, "newName") ?? undefined };
		}
		case "create_entity": {
			const name = stringField(payload, "name");
			const type = stringField(payload, "type");
			return name === null || type === null ? null : { name, entity_type: type };
		}
		case "add_claim_value":
		case "set_claim_value": {
			const entityId = stringField(payload, "entityId");
			const aspectId = stringField(payload, "aspectId");
			const claimKey = stringField(payload, "claimKey");
			const value = stringField(payload, "value");
			if (entityId === null || aspectId === null || claimKey === null || value === null) return null;
			const name = lookupEntityName(accessor, agentId, entityId);
			const aspect = lookupAspectName(accessor, agentId, entityId, aspectId);
			return name === null || aspect === null
				? null
				: {
						entity: name,
						aspect,
						claim_key: claimKey,
						value,
						...(stringField(payload, "reviewAfter") ? { review_after: stringField(payload, "reviewAfter") } : {}),
					};
		}
		case "supersede_claim_value": {
			const entityId = stringField(payload, "entityId");
			const aspectId = stringField(payload, "aspectId");
			const claimKey = stringField(payload, "claimKey");
			const value = stringField(payload, "value");
			if (entityId === null || aspectId === null || claimKey === null || value === null) return null;
			const name = lookupEntityName(accessor, agentId, entityId);
			const aspect = lookupAspectName(accessor, agentId, entityId, aspectId);
			const attributeId =
				stringField(payload, "attributeId") ?? lookupActiveClaimAttributeId(accessor, agentId, aspectId, claimKey);
			return name === null || aspect === null || attributeId === null
				? null
				: { entity: name, aspect, claim_key: claimKey, attribute_id: attributeId, new_value: value };
		}
		case "rename_entity": {
			const entityId = stringField(payload, "entityId");
			const newName = stringField(payload, "newName");
			return entityId === null || newName === null ? null : { entity_id: entityId, new_name: newName };
		}
		case "create_aspect": {
			const entityId = stringField(payload, "entityId");
			const name = stringField(payload, "name");
			return entityId === null || name === null ? null : { entity_id: entityId, name };
		}
		case "rename_aspect": {
			const entityId = stringField(payload, "entityId");
			const aspectId = stringField(payload, "aspectId");
			const newName = stringField(payload, "newName");
			return entityId === null || aspectId === null || newName === null
				? null
				: { entity_id: entityId, aspect_id: aspectId, new_name: newName };
		}
		case "create_link": {
			const fromEntityId = stringField(payload, "fromEntityId");
			const toEntityId = stringField(payload, "toEntityId");
			const linkType = stringField(payload, "linkType");
			return fromEntityId === null || toEntityId === null || linkType === null
				? null
				: { source_entity_id: fromEntityId, target_entity_id: toEntityId, link_type: linkType };
		}
		case "update_link": {
			const linkId = stringField(payload, "linkId");
			const linkType = stringField(payload, "linkType") ?? undefined;
			return linkId === null ? null : { id: linkId, link_type: linkType, reason };
		}
		case "create_policy": {
			const entityId = stringField(payload, "entityId");
			const name = stringField(payload, "name");
			const definition = stringField(payload, "definition");
			return entityId === null || name === null || definition === null
				? null
				: { entity_id: entityId, kind: name, content: definition };
		}
		case "create_action_type": {
			const name = stringField(payload, "name");
			return name === null ? null : { name };
		}
		case "create_interface": {
			const name = stringField(payload, "name");
			return name === null ? null : { name };
		}
		default:
			return payload;
	}
}

/**
 * Validate every request-level input that can be resolved without creating
 * attention rows. This must run before mintFlags: otherwise a bad citation or
 * target leaves durable flag records behind even though the request is refused.
 */
function validateRequestBeforeWrites(params: ApplyDreamingOperationsParams): string | null {
	for (const [index, operation] of params.operations.entries()) {
		if (operation.operation === FLAG_OP) {
			if (stringField(operation.payload, "subjectRef") === null) return "flag requires payload.subjectRef";
			continue;
		}
		if (operation.operation === DECLINE_ATTENTION_OP) {
			const attentionId = stringField(operation.payload, "attentionId");
			if (attentionId === null) return "decline_attention requires payload.attentionId";
			const pending = params.accessor.withReadDb((db) =>
				db
					.prepare(
						`SELECT 1 FROM dreaming_attention
						 WHERE id = ? AND agent_id = ? AND resolved_at IS NULL`,
					)
					.get(attentionId, params.agentId),
			);
			if (pending == null) return "Attention record is not pending in this agent scope";
			continue;
		}

		if (toApplicatorPayload(params.accessor, params.agentId, operation.operation, operation.payload) === null) {
			return `Could not resolve operation target: ${operation.operation}`;
		}
		if (HYGIENE_ARCHIVE_OPS.has(operation.operation)) {
			const reference = operation.provenance?.trim();
			const sameBatch = reference?.match(/^attention:\$(\d+)$/);
			if (sameBatch) {
				if (sameBatchFlagIndex(params.accessor, params.agentId, params.operations, index, operation) === null) {
					return "Hygiene archives require attention provenance (attention:$<index> or attention:<uuid>)";
				}
				continue;
			}
			if (
				attentionProvenance(params.accessor, params.agentId, operation, new Map(), params.operations, index) === null
			) {
				return "Hygiene archives require attention provenance (attention:$<index> or attention:<uuid>)";
			}
			continue;
		}

		const evidenceResult = provenanceForEvidence(params.accessor, params.agentId, operation);
		if (evidenceResult.provenance === null) {
			return evidenceResult.scopeMismatch ?? "Every operation must cite an exact quote from scoped episodic evidence";
		}
	}
	return null;
}

function existingReviewProposalId(
	db: WriteDb,
	params: {
		readonly agentId: string;
		readonly operation: string;
		readonly payload: Readonly<Record<string, unknown>>;
		readonly evidence: readonly unknown[];
	},
): string | null {
	const row = db
		.prepare(
			`SELECT id FROM ontology_proposals
			 WHERE agent_id = ? AND operation = ? AND status IN ('pending', 'applied', 'rejected')
			   AND payload = ? AND evidence = ?
			 ORDER BY updated_at DESC LIMIT 1`,
		)
		.get(params.agentId, params.operation, JSON.stringify(params.payload), JSON.stringify(params.evidence)) as
		| { id?: unknown }
		| undefined;
	return typeof row?.id === "string" ? row.id : null;
}

function applyValidatedOperationBody(
	db: WriteDb,
	entry: ValidatedDreamingOperation,
	params: ApplyDreamingOperationsParams,
): DreamingOperationItem {
	if (entry.input === null) {
		if (entry.decline === true && entry.attentionId !== null) {
			// Decline resolves the cited record in this tx: it must still be
			// pending in the named agent's scope and is one-use, exactly like a
			// flag consumed by an archive.
			const pending = db
				.prepare(
					`SELECT 1 FROM dreaming_attention
					 WHERE id = ? AND agent_id = ? AND resolved_at IS NULL`,
				)
				.get(entry.attentionId, params.agentId);
			if (pending == null) {
				return {
					index: entry.index,
					ok: false,
					error: "Attention record is not pending in this agent scope",
				};
			}
			db.prepare(
				`UPDATE dreaming_attention
				 SET resolved_at = datetime('now'), resolved_by_pass_id = ?
				 WHERE id = ? AND agent_id = ? AND resolved_at IS NULL`,
			).run(params.passId ?? null, entry.attentionId, params.agentId);
			return { index: entry.index, ok: true, result: { attentionId: entry.attentionId } };
		}
		// Flag ops are already persisted by mintFlags; this result only
		// surfaces the id for same-batch provenance and callers.
		return { index: entry.index, ok: true, result: { attentionId: entry.attentionId } };
	}

	if (entry.reviewOnly) {
		const existingId = existingReviewProposalId(db, {
			agentId: params.agentId,
			operation: entry.input.operation,
			payload: entry.input.payload,
			evidence: entry.input.evidence ?? [],
		});
		if (existingId !== null) {
			return {
				index: entry.index,
				ok: true,
				result: { reviewRequired: true, deduped: true, proposalId: existingId },
			};
		}
		const created = createOntologyProposalsInTx(db, [
			{
				agentId: params.agentId,
				operation: entry.input.operation,
				payload: entry.input.payload,
				confidence: entry.input.confidence,
				rationale: entry.input.reason,
				evidence: entry.input.evidence,
				risk: entry.input.risk,
				sourceKind: entry.input.sourceKind,
				sourceId: entry.input.sourceId,
				sourcePath: entry.input.sourcePath,
				sourceRoot: entry.input.sourceRoot,
				createdBy: params.actor,
			},
		]);
		return {
			index: entry.index,
			ok: true,
			proposal: created.items[0],
			result: { reviewRequired: true },
		};
	}

	if (entry.attentionId !== null) {
		// A flag is one-use: an earlier op in this batch may have already
		// consumed it, so a second op citing the same attention must not apply.
		// Resolved flags from a prior batch were already rejected by the
		// provenance pin.
		const pending = db
			.prepare(
				`SELECT 1 FROM dreaming_attention
				 WHERE id = ? AND agent_id = ? AND resolved_at IS NULL`,
			)
			.get(entry.attentionId, params.agentId);
		if (pending == null) {
			return {
				index: entry.index,
				ok: false,
				error: "Attention already consumed by an earlier operation in this batch",
			};
		}
	}

	const batch = applyOntologyOperationBatchInTx(db, {
		agentId: params.agentId,
		actor: params.actor,
		operations: [entry.input],
		writeCaps: params.writeCaps,
	});
	if (entry.attentionId !== null) {
		// The flag was consumed: resolve it in the same tx so the queue does
		// not re-surface a handled target next pass.
		db.prepare(
			`UPDATE dreaming_attention
			 SET resolved_at = datetime('now'), resolved_by_pass_id = ?
			 WHERE id = ? AND agent_id = ? AND resolved_at IS NULL`,
		).run(params.passId ?? null, entry.attentionId, params.agentId);
	}
	return {
		index: entry.index,
		ok: true,
		proposal: batch.items[0]?.proposal,
		result: batch.items[0]?.result,
	};
}

function applyValidatedOperationInTx(
	db: WriteDb,
	entry: ValidatedDreamingOperation,
	params: ApplyDreamingOperationsParams,
): DreamingOperationItem {
	const savepoint = `signet_dream_op_${entry.index}`;
	db.exec(`SAVEPOINT ${savepoint}`);
	try {
		const result = applyValidatedOperationBody(db, entry, params);
		db.exec(`RELEASE SAVEPOINT ${savepoint}`);
		return result;
	} catch (error) {
		db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
		db.exec(`RELEASE SAVEPOINT ${savepoint}`);
		return {
			index: entry.index,
			ok: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

/**
 * The sole daemon-owned apply seam for Dreaming agents. Flag ops mint hygiene
 * attention in-batch; hygiene archives/merges cite attention provenance;
 * content ops cite exact quotes resolved against the episodic store. Payloads
 * are mapped to the shared applicator contracts; every write is audited.
 */
export async function applyDreamingOperations(
	params: ApplyDreamingOperationsParams,
): Promise<ApplyDreamingOperationsResult> {
	if (params.operations.length === 0) return { ok: false, items: [], error: "operations are required" };
	if (params.operations.length > DREAMING_MAX_OPERATIONS_PER_REQUEST) {
		return {
			ok: false,
			items: [],
			error: `operations cannot exceed ${DREAMING_MAX_OPERATIONS_PER_REQUEST} items`,
		};
	}
	const allowedOperations = new Set<string>(DREAMING_OPERATION_IDS);
	for (const operation of params.operations) {
		if (!allowedOperations.has(operation.operation)) {
			return { ok: false, items: [], error: `Unsupported ontology proposal operation: ${operation.operation}` };
		}
		if (
			operation.confidence !== undefined &&
			(!Number.isFinite(operation.confidence) || operation.confidence < 0 || operation.confidence > 1)
		) {
			return { ok: false, items: [], error: "confidence must be a finite number between 0 and 1" };
		}
	}

	const validationError = validateRequestBeforeWrites(params);
	if (validationError !== null) return { ok: false, items: [], error: validationError };

	const minted = await mintFlags(params.accessor, params.agentId, params.operations);

	const validated: ValidatedDreamingOperation[] = [];
	for (const [index, operation] of params.operations.entries()) {
		if (operation.operation === FLAG_OP) {
			const attentionId = minted.get(index) ?? null;
			validated.push({ index, input: null, attentionId });
			continue;
		}
		if (operation.operation === DECLINE_ATTENTION_OP) {
			const attentionId = stringField(operation.payload, "attentionId");
			if (attentionId === null) {
				return { ok: false, items: [], error: "decline_attention requires payload.attentionId" };
			}
			validated.push({ index, input: null, attentionId, decline: true });
			continue;
		}
		let provenance: DreamingOperationProvenance | null = null;
		let attentionId: string | null = null;
		if (HYGIENE_ARCHIVE_OPS.has(operation.operation)) {
			const resolved = attentionProvenance(
				params.accessor,
				params.agentId,
				operation,
				minted,
				params.operations,
				index,
			);
			if (resolved !== null) {
				provenance = resolved.provenance;
				attentionId = resolved.attentionId;
			}
			if (provenance === null) {
				return {
					ok: false,
					items: [],
					error: "Hygiene archives require attention provenance (attention:$<index> or attention:<uuid>)",
				};
			}
		} else {
			const evidenceResult = provenanceForEvidence(params.accessor, params.agentId, operation);
			provenance = evidenceResult.provenance;
			if (provenance === null) {
				return {
					ok: false,
					items: [],
					error:
						evidenceResult.scopeMismatch ?? "Every operation must cite an exact quote from scoped episodic evidence",
				};
			}
		}
		const payload = toApplicatorPayload(params.accessor, params.agentId, operation.operation, operation.payload);
		if (payload === null) {
			return { ok: false, items: [], error: `Could not resolve operation target: ${operation.operation}` };
		}
		validated.push({
			index,
			input: {
				operation: operation.operation,
				payload,
				reason: operation.reason,
				evidence: provenance.evidence,
				confidence: operation.confidence,
				risk: operation.risk ?? null,
				sourceKind: provenance.sourceKind,
				sourceId: provenance.sourceId,
				sourcePath: provenance.sourcePath,
				sourceRoot: provenance.sourceRoot,
			},
			attentionId,
			reviewOnly: operation.risk === "review_required" && !HYGIENE_ARCHIVE_OPS.has(operation.operation),
		});
	}

	const result = await runWriteBatches(
		params.accessor,
		validated,
		(db, entry) => applyValidatedOperationInTx(db, entry, params),
		{
			label: "dreaming ontology operations",
			maxPerTx: DREAMING_WRITE_MAX_OPERATIONS_PER_TX,
			maxTxDurationMs: DREAMING_WRITE_MAX_TX_DURATION_MS,
		},
	);
	const items = result.items;
	if (result.stopped === "failed") {
		return {
			ok: false,
			items,
			error: result.error ?? "Dreaming ontology write batch failed",
			retryFrom: result.processed,
			retryable: true,
		};
	}
	const ok = items.some((item) => item.ok);
	return { ok, items, ...(ok ? {} : { error: "No ontology operations applied" }) };
}
