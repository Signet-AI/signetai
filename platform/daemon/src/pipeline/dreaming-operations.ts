import { SOURCE_NATIVE_TOPOLOGY_ENTITY_TYPES } from "@signet/core";
import type { DbAccessor, ReadDb } from "../db-accessor";
import { readEpisodicSource } from "../episodic-sources";
import { type OntologyOperationInput, applyOntologyOperationBatchInTx } from "../ontology-proposals";
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
const HYGIENE_ARCHIVE_OPS = new Set([
	"archive_entity",
	"archive_aspect",
	"archive_claim_value",
	"archive_link",
	"merge_entities",
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
function citeEvidence(accessor: DbAccessor, agentId: string, citation: unknown): DreamingAgentEvidence | null {
	const requested = citationRecord(citation);
	if (requested === null) return null;
	const evidence = accessor.withReadDb((db) => {
		const source = readEpisodicSource(db, { agentId, from: requested.sourceRef });
		return source === null ? [] : createDreamingAgentEvidence([source]);
	});
	return (
		evidence.find(
			(record) =>
				record.sourceRef === requested.sourceRef &&
				record.sourceKind === requested.sourceKind &&
				record.sourceId === requested.sourceId &&
				(requested.sourcePath === null || record.sourcePath === requested.sourcePath) &&
				record.content.includes(requested.quote),
		) ?? null
	);
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
		expectedTarget =
			typeof payload.target === "string" &&
			payload.target === attention.details.entityId &&
			attention.subjectRef === `entity:${payload.target}`;
	} else if (operation.operation === "archive_aspect") {
		expectedTarget =
			typeof payload.target === "string" &&
			payload.target === attention.details.aspectId &&
			attention.subjectRef === `aspect:${payload.target}`;
	} else if (operation.operation === "archive_claim_value") {
		expectedTarget =
			typeof payload.target === "string" &&
			payload.target === attention.details.attributeId &&
			attention.subjectRef === `attribute:${payload.target}`;
	} else if (operation.operation === "archive_link") {
		expectedTarget =
			typeof payload.target === "string" &&
			payload.target === attention.details.linkId &&
			attention.subjectRef === `link:${payload.target}`;
	} else if (operation.operation === "merge_entities") {
		const targets = Array.isArray(payload.targets)
			? payload.targets.filter((value): value is string => typeof value === "string")
			: [];
		const survivor = typeof payload.survivor === "string" ? payload.survivor : "";
		const groupIds = semanticDuplicateIds(accessor, agentId, attention.details.canonicalName ?? "");
		expectedTarget =
			attention.subjectRef === `duplicate:${attention.details.canonicalName}` &&
			groupIds.size > 1 &&
			groupIds.has(survivor) &&
			targets.length >= 2 &&
			targets.every((id) => groupIds.has(id)) &&
			targets.includes(survivor) &&
			targets.some((id) => id !== survivor);
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

function provenanceForEvidence(
	accessor: DbAccessor,
	agentId: string,
	operation: DreamingOperationRequest,
): DreamingOperationProvenance | null {
	const citations = operation.evidence ?? [];
	if (citations.length === 0) return null;
	const matched: DreamingAgentEvidence[] = [];
	for (const citation of citations) {
		const record = citeEvidence(accessor, agentId, citation);
		if (record === null) return null;
		matched.push(record);
	}
	const provenance = matched.find((source) => source.sourceEntryId !== null) ?? matched[0];
	if (!provenance) return null;
	return {
		evidence: citations,
		sourceKind: provenance.sourceKind,
		sourceId: provenance.sourceEntryId ?? provenance.sourceId,
		sourcePath: provenance.sourcePath,
		sourceRoot: "dreaming",
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
			return name === null || aspect === null ? null : { entity: name, aspect, claim_key: claimKey, value };
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
	}> = [];
	for (let index = 0; index < params.operations.length; index += 1) {
		const operation = params.operations[index]!;
		if (operation.operation === FLAG_OP) {
			const attentionId = minted.get(index) ?? null;
			validated.push({ input: null, attentionId });
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
			provenance = provenanceForEvidence(params.accessor, params.agentId, operation);
			if (provenance === null) {
				return {
					ok: false,
					items: [],
					error: "Every operation must cite an exact quote from scoped episodic evidence",
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
				// flag op: nothing to apply; surface the minted attention id
				items.push({ index, ok: true, result: { attentionId: entry.attentionId } });
				continue;
			}
			const savepoint = `signet_dream_op_${index}`;
			db.exec(`SAVEPOINT ${savepoint}`);
			try {
				const batch = applyOntologyOperationBatchInTx(db, {
					agentId: params.agentId,
					actor: params.actor,
					operations: [entry.input],
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
