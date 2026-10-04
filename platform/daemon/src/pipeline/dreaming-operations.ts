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
import { DREAMING_HYGIENE_ARCHIVE_OPERATIONS, DREAMING_OPERATION_IDS } from "./dreaming-operation-contract";

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
	readonly retryFrom?: number;
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

function citationRecord(value: unknown): {
	readonly sourceRef: string;
	readonly sourceKind: string | null;
	readonly sourceId: string | null;
	readonly sourcePath: string | null;
	readonly quote: string;
} | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	const citation = value as Record<string, unknown>;
	const sourceRef = typeof citation.source_ref === "string" ? citation.source_ref.trim() : "";
	const sourceKind =
		citation.source_kind === undefined
			? null
			: typeof citation.source_kind === "string"
				? citation.source_kind.trim()
				: "";
	const sourceId =
		citation.source_id === undefined ? null : typeof citation.source_id === "string" ? citation.source_id.trim() : "";
	const sourcePath = typeof citation.source_path === "string" ? citation.source_path.trim() : null;
	const quote = typeof citation.quote === "string" ? citation.quote.trim() : "";
	const separator = sourceRef.indexOf(":");
	const hasCanonicalIdentity = separator > 0 && separator < sourceRef.length - 1;
	return sourceRef && hasCanonicalIdentity && quote && sourceKind !== "" && sourceId !== ""
		? { sourceRef, sourceKind, sourceId, sourcePath, quote }
		: null;
}
interface CitationResolution {
	readonly evidence: DreamingAgentEvidence | null;
	readonly sourceAgentIds: readonly string[];
}

function citeEvidence(accessor: DbAccessor, agentId: string, citation: unknown): CitationResolution {
	const requested = citationRecord(citation);
	if (requested === null) return { evidence: null, sourceAgentIds: [] };
	const result: {
		readonly evidence: readonly DreamingAgentEvidence[];
		readonly sourceAgentIds: readonly string[];
	} =
		// @ts-expect-error LEGACY_SYNC_DB_ACCESS: withReadDb migration site
		accessor.withReadDb((db: import("../db-accessor").ReadDb) => {
			const source = readEpisodicSource(db, { agentId, from: requested.sourceRef });
			if (source !== null && (source.kind !== "transcript" || source.completed)) {
				return { evidence: createDreamingAgentEvidence([source]), sourceAgentIds: [] };
			}
			return { evidence: [], sourceAgentIds: findEpisodicSourceAgentIds(db, requested.sourceRef) };
		}, "db:dreaming.operations.cite-evidence.read");
	return {
		evidence:
			result.evidence.find(
				(record) =>
					record.sourceRef === requested.sourceRef &&
					(requested.sourceKind === null || record.sourceKind === requested.sourceKind) &&
					(requested.sourceId === null || record.sourceId === requested.sourceId) &&
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
	readonly decline?: boolean;
	readonly reviewOnly?: boolean;
};

function semanticDuplicateIds(accessor: DbAccessor, agentId: string, canonicalName: string): ReadonlySet<string> {
	const placeholders = SOURCE_NATIVE_TOPOLOGY_ENTITY_TYPES.map(() => "?").join(", ");
	// @ts-expect-error LEGACY_SYNC_DB_ACCESS: withReadDb migration site
	return accessor.withReadDb((db: import("../db-accessor").ReadDb) => {
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
	}, "db:dreaming.operations.duplicate-group.read");
}

function asStringRecord(value: unknown): Readonly<Record<string, string>> | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const record: Record<string, string> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (typeof entry === "string") record[key] = entry;
	}
	return Object.keys(record).length > 0 ? record : undefined;
}
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
			maxPerTx: DREAMING_MAX_OPERATIONS_PER_REQUEST,
		},
	);
	if (result.stopped === "failed") throw new Error(result.error ?? "Dreaming attention flag write failed");
	return new Map(
		result.items.flatMap((entry) => (entry.attentionId === null ? [] : [[entry.index, entry.attentionId] as const])),
	);
}
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
	if (!DREAMING_HYGIENE_ARCHIVE_OPERATIONS.has(operation.operation)) return null;
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
					source_root: "dreaming_attention",
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
const HYGIENE_PROVENANCE_ERROR =
	"Hygiene archives require attention provenance (attention:$<index> or attention:<uuid>)";

function hygieneProvenanceError(accessor: DbAccessor, agentId: string, operation: DreamingOperationRequest): string {
	const reference = operation.provenance?.trim() ?? "";
	if (!reference.startsWith("attention:") || /^attention:\$\d+$/.test(reference)) return HYGIENE_PROVENANCE_ERROR;
	const id = reference.slice("attention:".length);
	const attention = id ? getDreamingAttentionById(accessor, { agentId, id }) : null;
	if (attention === null || attention.kind !== "hygiene") {
		return `${HYGIENE_PROVENANCE_ERROR}: ${id} is not a pending hygiene attention in this agent (already resolved, or the id is mistyped); copy a pending id from attention_list`;
	}
	const mismatch = attentionTargetMismatch(accessor, agentId, operation, attention);
	return mismatch === null ? HYGIENE_PROVENANCE_ERROR : `${HYGIENE_PROVENANCE_ERROR}: ${mismatch}`;
}
function pinnedBySubjectRef(subjectRef: string, prefix: string): string | null {
	if (!subjectRef.startsWith(prefix)) return null;
	const id = subjectRef.slice(prefix.length);
	return id.length > 0 ? id : null;
}
function hasExpectedAttentionTarget(
	accessor: DbAccessor,
	agentId: string,
	operation: DreamingOperationRequest,
	attention: DreamingAttention,
): boolean {
	return attentionTargetMismatch(accessor, agentId, operation, attention) === null;
}

function attentionTargetMismatch(
	accessor: DbAccessor,
	agentId: string,
	operation: DreamingOperationRequest,
	attention: DreamingAttention,
): string | null {
	const payload = operation.payload;
	if (operation.operation === "archive_entity") {
		return pinnedTargetMismatch(payload, attention, "entity:", "entityId");
	}
	if (operation.operation === "archive_aspect") {
		return pinnedTargetMismatch(payload, attention, "aspect:", "aspectId");
	}
	if (operation.operation === "archive_claim_value") {
		return pinnedTargetMismatch(payload, attention, "attribute:", "attributeId");
	}
	if (operation.operation === "archive_link") {
		return pinnedTargetMismatch(payload, attention, "link:", "linkId");
	}
	if (operation.operation === "merge_entities") {
		const targets = Array.isArray(payload.targets)
			? payload.targets.filter((value): value is string => typeof value === "string")
			: [];
		const survivor = typeof payload.survivor === "string" ? payload.survivor : "";
		const canonicalName =
			attention.details.canonicalName ?? pinnedBySubjectRef(attention.subjectRef, "duplicate:") ?? "";
		if (canonicalName.length === 0 || attention.subjectRef !== `duplicate:${canonicalName}`) {
			return `attention ${attention.id} flags ${attention.subjectRef}, not a duplicate group`;
		}
		const groupIds = semanticDuplicateIds(accessor, agentId, canonicalName);
		if (groupIds.size <= 1) {
			return `no duplicate group named "${canonicalName}" remains; decline_attention if the flag no longer applies`;
		}
		const outside = targets.filter((id) => !groupIds.has(id));
		if (outside.length > 0) {
			return `targets ${outside.join(", ")} are not in the "${canonicalName}" duplicate group (${[...groupIds].join(", ")}); merge only that group, or decline_attention if the flag is wrong`;
		}
		if (
			!groupIds.has(survivor) ||
			targets.length < 2 ||
			!targets.includes(survivor) ||
			!targets.some((id) => id !== survivor)
		) {
			return "targets must list the survivor and at least one other member of the duplicate group";
		}
		return null;
	}
	if (operation.operation === "merge_aspects") {
		const sources = Array.isArray(payload.sources)
			? payload.sources.filter((value): value is string => typeof value === "string")
			: [];
		const pinnedAspect = pinnedBySubjectRef(attention.subjectRef, "aspect:");
		if (pinnedAspect === null) return `attention ${attention.id} flags ${attention.subjectRef}, not an aspect`;
		if (attention.details.aspectId !== undefined && attention.details.aspectId !== pinnedAspect) {
			return `attention ${attention.id} details disagree with its subjectRef`;
		}
		if (typeof payload.target !== "string" || !sources.includes(pinnedAspect)) {
			return `payload.sources must include the flagged aspect ${pinnedAspect} and payload.target must name the surviving aspect`;
		}
		return null;
	}
	return `${operation.operation} cannot resolve a hygiene attention`;
}
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
	if (referencedIndex < 0 || referencedIndex >= operations.length) return null;
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
		return hasExpectedAttentionTarget(accessor, agentId, operation, attention) ? referencedIndex : null;
	}
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
function pinnedTargetMismatch(
	payload: Readonly<Record<string, unknown>>,
	attention: DreamingAttention,
	prefix: string,
	detailKey: keyof DreamingAttention["details"],
): string | null {
	const pinned = pinnedBySubjectRef(attention.subjectRef, prefix);
	if (pinned === null) {
		return `attention ${attention.id} flags ${attention.subjectRef}, not ${prefix.slice(0, -1)}; cite an attention for this target`;
	}
	const target = typeof payload.target === "string" ? payload.target : null;
	if (target !== pinned) return `payload.target must be ${pinned}, the ${prefix.slice(0, -1)} this attention flags`;
	const detail = attention.details[detailKey];
	return detail === undefined || detail === target
		? null
		: `attention ${attention.id} details disagree with its subjectRef`;
}

function provenanceForEvidence(
	accessor: DbAccessor,
	agentId: string,
	operation: DreamingOperationRequest,
): {
	readonly provenance: DreamingOperationProvenance | null;
	readonly scopeMismatch: string | null;
	readonly unmatched?: string;
} {
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
			const cited = citationRecord(citation);
			if (cited === null) return { provenance: null, scopeMismatch: null };
			const quote = cited.quote.length > 120 ? `${cited.quote.slice(0, 120)}…` : cited.quote;
			return { provenance: null, scopeMismatch: null, unmatched: `${cited.sourceRef}: "${quote}"` };
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

function lookupString(db: ReadDb, sql: string, ...params: unknown[]): string | null {
	const row = db.prepare(sql).get(...params) as { value: string | null } | undefined;
	return row?.value ?? null;
}

function lookupEntityName(accessor: DbAccessor, agentId: string, entityId: string): string | null {
	// @ts-expect-error LEGACY_SYNC_DB_ACCESS: withReadDb migration site
	return accessor.withReadDb(
		(db: import("../db-accessor").ReadDb) =>
			lookupString(
				db,
				"SELECT name AS value FROM entities WHERE id = ? AND agent_id = ? AND COALESCE(status,'active') = 'active'",
				entityId,
				agentId,
			),
		"db:dreaming.operations.entity-name.read",
	);
}

function lookupAspectName(accessor: DbAccessor, agentId: string, entityId: string, aspectId: string): string | null {
	// @ts-expect-error LEGACY_SYNC_DB_ACCESS: withReadDb migration site
	return accessor.withReadDb(
		(db: import("../db-accessor").ReadDb) =>
			lookupString(
				db,
				"SELECT name AS value FROM entity_aspects WHERE id = ? AND entity_id = ? AND agent_id = ? AND COALESCE(status,'active') = 'active'",
				aspectId,
				entityId,
				agentId,
			),
		"db:dreaming.operations.aspect-name.read",
	);
}

function lookupAspectEntityId(accessor: DbAccessor, agentId: string, aspectId: string): string | null {
	// @ts-expect-error LEGACY_SYNC_DB_ACCESS: withReadDb migration site
	return accessor.withReadDb(
		(db: import("../db-accessor").ReadDb) =>
			lookupString(
				db,
				"SELECT entity_id AS value FROM entity_aspects WHERE id = ? AND agent_id = ? AND COALESCE(status,'active') = 'active'",
				aspectId,
				agentId,
			),
		"db:dreaming.operations.aspect-entity.read",
	);
}

function lookupActiveClaimAttributeId(
	accessor: DbAccessor,
	agentId: string,
	aspectId: string,
	claimKey: string,
): string | null {
	// @ts-expect-error LEGACY_SYNC_DB_ACCESS: withReadDb migration site
	return accessor.withReadDb(
		(db: import("../db-accessor").ReadDb) =>
			lookupString(
				db,
				"SELECT id AS value FROM entity_attributes WHERE aspect_id = ? AND agent_id = ? AND claim_key = ? AND status = 'active' ORDER BY created_at DESC, id ASC LIMIT 1",
				aspectId,
				agentId,
				claimKey,
			),
		"db:dreaming.operations.active-claim.read",
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
type ApplicatorPayload = { readonly payload: Readonly<Record<string, unknown>> } | { readonly error: string };

function missingFields(
	payload: Readonly<Record<string, unknown>>,
	fields: readonly string[],
): ApplicatorPayload | null {
	const missing = fields.filter((field) => stringField(payload, field) === null);
	return missing.length === 0 ? null : { error: `missing ${missing.map((field) => `payload.${field}`).join(", ")}` };
}

function notFound(kind: string, id: string, scope: string): ApplicatorPayload {
	return { error: `${kind} ${id} not found ${scope}; read it back with get_entity before retrying` };
}

function toApplicatorPayload(
	accessor: DbAccessor,
	agentId: string,
	operation: string,
	payload: Readonly<Record<string, unknown>>,
): ApplicatorPayload {
	const target = stringField(payload, "target");
	const reason = stringField(payload, "reason") ?? undefined;
	const inAgent = "in this agent";
	switch (operation) {
		case "archive_entity":
			return target === null ? { error: "missing payload.target" } : { payload: { entity_id: target, reason } };
		case "archive_aspect": {
			if (target === null) return { error: "missing payload.target" };
			const entityId = lookupAspectEntityId(accessor, agentId, target);
			return entityId === null
				? notFound("aspect", target, inAgent)
				: { payload: { entity_id: entityId, aspect_id: target, reason } };
		}
		case "archive_claim_value":
			return target === null ? { error: "missing payload.target" } : { payload: { attribute_id: target, reason } };
		case "archive_link":
			return target === null ? { error: "missing payload.target" } : { payload: { id: target, reason } };
		case "merge_entities": {
			const targets = stringArrayField(payload, "targets");
			const survivor = stringField(payload, "survivor");
			if (targets === null || survivor === null) return { error: "missing payload.targets or payload.survivor" };
			const sourceIds = targets.filter((id) => id !== survivor);
			return { payload: { target_entity_id: survivor, source_entity_ids: sourceIds } };
		}
		case "merge_aspects": {
			const entityId = stringField(payload, "entityId");
			const mergeTarget = stringField(payload, "target");
			const sources = stringArrayField(payload, "sources");
			if (entityId === null || mergeTarget === null || sources === null || sources.length === 0) {
				return { error: "missing payload.entityId, payload.target, or payload.sources" };
			}
			const name = lookupEntityName(accessor, agentId, entityId);
			return name === null
				? notFound("entity", entityId, inAgent)
				: {
						payload: {
							entity: name,
							target: mergeTarget,
							sources,
							new_name: stringField(payload, "newName") ?? undefined,
						},
					};
		}
		case "create_entity": {
			const missing = missingFields(payload, ["name", "type"]);
			if (missing !== null) return missing;
			return { payload: { name: stringField(payload, "name"), entity_type: stringField(payload, "type") } };
		}
		case "add_claim_value":
		case "set_claim_value":
		case "supersede_claim_value": {
			const missing = missingFields(payload, ["entityId", "aspectId", "claimKey", "value"]);
			if (missing !== null) return missing;
			const entityId = stringField(payload, "entityId") ?? "";
			const aspectId = stringField(payload, "aspectId") ?? "";
			const claimKey = stringField(payload, "claimKey") ?? "";
			const value = stringField(payload, "value") ?? "";
			const name = lookupEntityName(accessor, agentId, entityId);
			if (name === null) return notFound("entity", entityId, inAgent);
			const aspect = lookupAspectName(accessor, agentId, entityId, aspectId);
			if (aspect === null) return notFound("aspect", aspectId, `on entity ${entityId}`);
			if (operation !== "supersede_claim_value") {
				return {
					payload: {
						entity: name,
						aspect,
						claim_key: claimKey,
						value,
						...(stringField(payload, "reviewAfter") ? { review_after: stringField(payload, "reviewAfter") } : {}),
					},
				};
			}
			const attributeId =
				stringField(payload, "attributeId") ?? lookupActiveClaimAttributeId(accessor, agentId, aspectId, claimKey);
			return attributeId === null
				? { error: `no active claim ${claimKey} on aspect ${aspectId} to supersede` }
				: { payload: { entity: name, aspect, claim_key: claimKey, attribute_id: attributeId, new_value: value } };
		}
		case "rename_entity": {
			const missing = missingFields(payload, ["entityId", "newName"]);
			if (missing !== null) return missing;
			return { payload: { entity_id: stringField(payload, "entityId"), new_name: stringField(payload, "newName") } };
		}
		case "create_aspect": {
			const missing = missingFields(payload, ["entityId", "name"]);
			if (missing !== null) return missing;
			return { payload: { entity_id: stringField(payload, "entityId"), name: stringField(payload, "name") } };
		}
		case "rename_aspect": {
			const missing = missingFields(payload, ["entityId", "aspectId", "newName"]);
			if (missing !== null) return missing;
			return {
				payload: {
					entity_id: stringField(payload, "entityId"),
					aspect_id: stringField(payload, "aspectId"),
					new_name: stringField(payload, "newName"),
				},
			};
		}
		case "create_link": {
			const missing = missingFields(payload, ["fromEntityId", "toEntityId", "linkType"]);
			if (missing !== null) return missing;
			return {
				payload: {
					source_entity_id: stringField(payload, "fromEntityId"),
					target_entity_id: stringField(payload, "toEntityId"),
					link_type: stringField(payload, "linkType"),
				},
			};
		}
		case "update_link": {
			const linkId = stringField(payload, "linkId");
			const linkType = stringField(payload, "linkType") ?? undefined;
			return linkId === null
				? { error: "missing payload.linkId" }
				: { payload: { id: linkId, link_type: linkType, reason } };
		}
		case "create_policy": {
			const missing = missingFields(payload, ["entityId", "name", "definition"]);
			if (missing !== null) return missing;
			return {
				payload: {
					entity_id: stringField(payload, "entityId"),
					kind: stringField(payload, "name"),
					content: stringField(payload, "definition"),
				},
			};
		}
		case "create_action_type":
		case "create_interface": {
			const name = stringField(payload, "name");
			return name === null ? { error: "missing payload.name" } : { payload: { name } };
		}
		default:
			return { payload };
	}
}
const EVIDENCE_ERROR = "Every operation must cite an exact quote from scoped episodic evidence";

function evidenceError(index: number, unmatched: string | undefined): string {
	if (unmatched === undefined) return EVIDENCE_ERROR;
	return `${EVIDENCE_ERROR}: operation ${index} quotes text not found verbatim in ${unmatched}; copy the source exactly, typos included`;
}

function unresolvedTarget(index: number, operation: string, detail: string): string {
	return `Could not resolve operation ${index} target (${operation}): ${detail}`;
}

function validateRequestBeforeWrites(params: ApplyDreamingOperationsParams): string | null {
	for (const [index, operation] of params.operations.entries()) {
		if (operation.operation === FLAG_OP) {
			if (stringField(operation.payload, "subjectRef") === null) return "flag requires payload.subjectRef";
			continue;
		}
		if (operation.operation === DECLINE_ATTENTION_OP) {
			const attentionId = stringField(operation.payload, "attentionId");
			if (attentionId === null) return "decline_attention requires payload.attentionId";
			// @ts-expect-error LEGACY_SYNC_DB_ACCESS: withReadDb migration site
			const pending = params.accessor.withReadDb(
				(db: import("../db-accessor").ReadDb) =>
					db
						.prepare(
							`SELECT 1 FROM dreaming_attention
						 WHERE id = ? AND agent_id = ? AND resolved_at IS NULL`,
						)
						.get(attentionId, params.agentId),
				"db:dreaming.operations.pending-attention.read",
			);
			if (pending == null) return "Attention record is not pending in this agent scope";
			continue;
		}

		const applicator = toApplicatorPayload(params.accessor, params.agentId, operation.operation, operation.payload);
		if ("error" in applicator) return unresolvedTarget(index, operation.operation, applicator.error);
		if (DREAMING_HYGIENE_ARCHIVE_OPERATIONS.has(operation.operation)) {
			const reference = operation.provenance?.trim();
			const sameBatch = reference?.match(/^attention:\$(\d+)$/);
			if (sameBatch) {
				if (sameBatchFlagIndex(params.accessor, params.agentId, params.operations, index, operation) === null) {
					return HYGIENE_PROVENANCE_ERROR;
				}
				continue;
			}
			if (
				attentionProvenance(params.accessor, params.agentId, operation, new Map(), params.operations, index) === null
			) {
				return hygieneProvenanceError(params.accessor, params.agentId, operation);
			}
			continue;
		}

		const evidenceResult = provenanceForEvidence(params.accessor, params.agentId, operation);
		if (evidenceResult.provenance === null) {
			return evidenceResult.scopeMismatch ?? evidenceError(index, evidenceResult.unmatched);
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
		if (DREAMING_HYGIENE_ARCHIVE_OPERATIONS.has(operation.operation)) {
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
				return { ok: false, items: [], error: hygieneProvenanceError(params.accessor, params.agentId, operation) };
			}
		} else {
			const evidenceResult = provenanceForEvidence(params.accessor, params.agentId, operation);
			provenance = evidenceResult.provenance;
			if (provenance === null) {
				return {
					ok: false,
					items: [],
					error: evidenceResult.scopeMismatch ?? evidenceError(index, evidenceResult.unmatched),
				};
			}
		}
		const applicator = toApplicatorPayload(params.accessor, params.agentId, operation.operation, operation.payload);
		if ("error" in applicator) {
			return { ok: false, items: [], error: unresolvedTarget(index, operation.operation, applicator.error) };
		}
		const payload = applicator.payload;
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
			reviewOnly: operation.risk === "review_required" && !DREAMING_HYGIENE_ARCHIVE_OPERATIONS.has(operation.operation),
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
