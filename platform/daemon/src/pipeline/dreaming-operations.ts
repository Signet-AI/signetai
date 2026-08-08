import { SOURCE_NATIVE_TOPOLOGY_ENTITY_TYPES } from "@signet/core";
import type { DbAccessor, ReadDb } from "../db-accessor";
import { findEpisodicSourceAgentIds, readEpisodicSource } from "../episodic-sources";
import {
	type GraphWriteCaps,
	type OntologyOperationInput,
	applyOntologyOperationBatchInTx,
} from "../ontology-proposals";
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
}

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
		if (source !== null) return { evidence: createDreamingAgentEvidence([source]), sourceAgentIds: [] };
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
 * Mint hygiene attention for every flag op in the batch, in one write tx.
 * Returns operation index -> minted attention id, so later ops in the same
 * batch can cite provenance "attention:$<index>".
 */
function mintFlags(
	accessor: DbAccessor,
	agentId: string,
	operations: readonly DreamingOperationRequest[],
): Map<number, string> {
	const minted = new Map<number, string>();
	accessor.withWriteTx((db) => {
		for (let index = 0; index < operations.length; index += 1) {
			const operation = operations[index]!;
			if (operation.operation !== FLAG_OP) continue;
			const subjectRef = typeof operation.payload.subjectRef === "string" ? operation.payload.subjectRef.trim() : "";
			if (!subjectRef) continue;
			const priority = typeof operation.payload.priority === "number" ? operation.payload.priority : undefined;
			const attentionId = enqueueDreamingAttentionInTx(db, {
				agentId,
				kind: "hygiene",
				subjectRef,
				details: asStringRecord(operation.payload.details),
				priority,
			});
			minted.set(index, attentionId);
		}
	});
	return minted;
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
): { readonly provenance: DreamingOperationProvenance; readonly attentionId: string } | null {
	const reference = operation.provenance?.trim();
	if (!reference?.startsWith("attention:")) return null;
	if (!HYGIENE_ARCHIVE_OPS.has(operation.operation)) return null;
	const payload = operation.payload;

	let attention: DreamingAttention | null = null;
	const sameBatch = reference.match(/^attention:\$(\d+)$/);
	if (sameBatch !== null) {
		const attentionId = mintedById.get(Number.parseInt(sameBatch[1]!, 10));
		if (attentionId !== undefined) attention = getDreamingAttentionById(accessor, { agentId, id: attentionId });
	} else {
		const attentionId = reference.slice("attention:".length);
		if (attentionId) attention = getDreamingAttentionById(accessor, { agentId, id: attentionId });
	}
	if (attention === null || attention.kind !== "hygiene") return null;

	let expectedTarget = false;
	if (operation.operation === "archive_entity") {
		expectedTarget = pinnedTarget(payload, attention, "entity:", "entityId");
	} else if (operation.operation === "archive_aspect") {
		expectedTarget = pinnedTarget(payload, attention, "aspect:", "aspectId");
	} else if (operation.operation === "archive_claim_value") {
		expectedTarget = pinnedTarget(payload, attention, "attribute:", "attributeId");
	} else if (operation.operation === "archive_link") {
		expectedTarget = pinnedTarget(payload, attention, "link:", "linkId");
	} else if (operation.operation === "merge_entities") {
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
		expectedTarget =
			canonicalName.length > 0 &&
			attention.subjectRef === `duplicate:${canonicalName}` &&
			groupIds.size > 1 &&
			groupIds.has(survivor) &&
			targets.length >= 2 &&
			targets.every((id) => groupIds.has(id)) &&
			targets.includes(survivor) &&
			targets.some((id) => id !== survivor);
	} else if (operation.operation === "merge_aspects") {
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
		expectedTarget =
			detailAgrees &&
			typeof payload.target === "string" &&
			sources.length >= 1 &&
			pinnedAspect !== null &&
			sources.includes(pinnedAspect);
	}
	if (!expectedTarget) return null;

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
 * The sole daemon-owned apply seam for Dreaming agents. Flag ops mint hygiene
 * attention in-batch; hygiene archives/merges cite attention provenance;
 * content ops cite exact quotes resolved against the episodic store. Payloads
 * are mapped to the shared applicator contracts; every write is audited.
 */
export function applyDreamingOperations(params: {
	readonly accessor: DbAccessor;
	readonly agentId: string;
	readonly actor: string;
	readonly operations: readonly DreamingOperationRequest[];
	readonly passId?: string;
	readonly writeCaps?: GraphWriteCaps;
}): ApplyDreamingOperationsResult {
	if (params.operations.length === 0) return { ok: false, items: [], error: "operations are required" };
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

	const minted = mintFlags(params.accessor, params.agentId, params.operations);

	const validated: Array<{
		readonly input: OntologyOperationInput | null;
		readonly attentionId: string | null;
		/** Queue-only op that resolves its cited attention record instead of an ontology write. */
		readonly decline?: boolean;
	}> = [];
	for (let index = 0; index < params.operations.length; index += 1) {
		const operation = params.operations[index]!;
		if (operation.operation === FLAG_OP) {
			const attentionId = minted.get(index) ?? null;
			validated.push({ input: null, attentionId });
			continue;
		}
		if (operation.operation === DECLINE_ATTENTION_OP) {
			const attentionId = stringField(operation.payload, "attentionId");
			if (attentionId === null) {
				return { ok: false, items: [], error: "decline_attention requires payload.attentionId" };
			}
			validated.push({ input: null, attentionId, decline: true });
			continue;
		}
		let provenance: DreamingOperationProvenance | null = null;
		let attentionId: string | null = null;
		if (HYGIENE_ARCHIVE_OPS.has(operation.operation)) {
			const resolved = attentionProvenance(params.accessor, params.agentId, operation, minted);
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
		});
	}

	const items: DreamingOperationItem[] = [];
	params.accessor.withWriteTx((db) => {
		for (let index = 0; index < validated.length; index += 1) {
			const entry = validated[index]!;
			if (entry.input === null) {
				if (entry.decline === true && entry.attentionId !== null) {
					// Decline resolves the cited record in this tx: it must
					// still be pending in the named agent's scope and is
					// one-use, exactly like a flag consumed by an archive.
					const pending = db
						.prepare(
							`SELECT 1 FROM dreaming_attention
							 WHERE id = ? AND agent_id = ? AND resolved_at IS NULL`,
						)
						.get(entry.attentionId, params.agentId);
					if (pending == null) {
						items.push({
							index,
							ok: false,
							error: "Attention record is not pending in this agent scope",
						});
						continue;
					}
					db.prepare(
						`UPDATE dreaming_attention
						 SET resolved_at = datetime('now'), resolved_by_pass_id = ?
						 WHERE id = ? AND agent_id = ? AND resolved_at IS NULL`,
					).run(params.passId ?? null, entry.attentionId, params.agentId);
					items.push({ index, ok: true, result: { attentionId: entry.attentionId } });
					continue;
				}
				// flag op: nothing to apply; surface the minted attention id
				items.push({ index, ok: true, result: { attentionId: entry.attentionId } });
				continue;
			}
			if (entry.attentionId !== null) {
				// A flag is one-use: an earlier op in this batch may have
				// already consumed it, so a second op citing the same
				// attention must not apply. Resolved flags (from a prior
				// batch) were already rejected by the provenance pin.
				const pending = db
					.prepare(
						`SELECT 1 FROM dreaming_attention
						 WHERE id = ? AND agent_id = ? AND resolved_at IS NULL`,
					)
					.get(entry.attentionId, params.agentId);
				if (pending == null) {
					items.push({
						index,
						ok: false,
						error: "Attention already consumed by an earlier operation in this batch",
					});
					continue;
				}
			}
			const savepoint = `signet_dream_op_${index}`;
			db.exec(`SAVEPOINT ${savepoint}`);
			try {
				const batch = applyOntologyOperationBatchInTx(db, {
					agentId: params.agentId,
					actor: params.actor,
					operations: [entry.input],
					writeCaps: params.writeCaps,
				});
				db.exec(`RELEASE SAVEPOINT ${savepoint}`);
				if (entry.attentionId !== null) {
					// The flag was consumed: resolve it in the same tx so the
					// queue does not re-surface a handled target next pass.
					db.prepare(
						`UPDATE dreaming_attention
						 SET resolved_at = datetime('now'), resolved_by_pass_id = ?
						 WHERE id = ? AND agent_id = ? AND resolved_at IS NULL`,
					).run(params.passId ?? null, entry.attentionId, params.agentId);
				}
				items.push({ index, ok: true, proposal: batch.items[0]?.proposal, result: batch.items[0]?.result });
			} catch (error) {
				db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
				db.exec(`RELEASE SAVEPOINT ${savepoint}`);
				items.push({ index, ok: false, error: error instanceof Error ? error.message : String(error) });
			}
		}
	});
	const ok = items.some((item) => item.ok);
	return { ok, items, ...(ok ? {} : { error: "No ontology operations applied" }) };
}
