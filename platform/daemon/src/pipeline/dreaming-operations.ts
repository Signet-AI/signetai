import { ONTOLOGY_PROPOSAL_OPERATIONS, SOURCE_NATIVE_TOPOLOGY_ENTITY_TYPES } from "@signet/core";
import type { DbAccessor } from "../db-accessor";
import { readEpisodicSource } from "../episodic-sources";
import { type OntologyOperationInput, applyOntologyOperationBatchInTx } from "../ontology-proposals";
import { type DreamingAttention, getDreamingAttentionById } from "./dreaming-attention";
import { type DreamingAgentEvidence, createDreamingAgentEvidence } from "./dreaming-evidence";

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
	return sourceRef && sourceKind && sourceId && quote ? { sourceRef, sourceKind, sourceId, sourcePath, quote } : null;
}

function citeEvidence(
	accessor: DbAccessor,
	agentId: string,
	citation: unknown,
	allowedEvidence: readonly DreamingAgentEvidence[] | undefined,
): DreamingAgentEvidence | null {
	const requested = citationRecord(citation);
	if (requested === null) return null;
	const evidence =
		allowedEvidence ??
		accessor.withReadDb((db) => {
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

function noSelectors(payload: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
	return keys.every((key) => payload[key] === undefined || payload[key] === null);
}

/** Accepted selector values that denote the flagged entity itself. */
function acceptedTargetValues(attention: DreamingAttention, ...keys: readonly string[]): string[] {
	return keys
		.map((key) => attention.details[key])
		.filter((value): value is string => typeof value === "string" && value.length > 0);
}

/**
 * True when every present selector field names the flagged target itself.
 * Downstream selector resolution prefers `selector`/`entity`/`name` over
 * `entity_id`, so a stray selector naming a different row would hit the wrong
 * target despite a matching id. Accept only the target's id or the name the
 * attention record captured; anything else is rejected.
 */
function selectorsNameFlaggedTarget(
	payload: Readonly<Record<string, unknown>>,
	fields: readonly { readonly key: string; readonly accepted: readonly string[] }[],
): boolean {
	for (const { key, accepted } of fields) {
		const value = payload[key];
		if (typeof value !== "string" || value.length === 0) continue;
		if (!accepted.includes(value)) return false;
	}
	return true;
}

function forceRequested(value: unknown): boolean {
	return value === true || value === 1 || value === "1" || value === "true";
}

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

function attentionProvenance(
	accessor: DbAccessor,
	agentId: string,
	operation: DreamingOperationRequest,
): DreamingOperationProvenance | null {
	const reference = operation.provenance?.trim();
	if (!reference?.startsWith("attention:")) return null;
	if (
		!new Set(["archive_entity", "archive_aspect", "archive_claim_value", "archive_link", "merge_entities"]).has(
			operation.operation,
		)
	)
		return null;
	const attentionId = reference.slice("attention:".length);
	if (!attentionId) return null;
	const attention = getDreamingAttentionById(accessor, { agentId, id: attentionId });
	if (attention?.kind !== "hygiene") return null;
	const payload = operation.payload;
	if (forceRequested(payload.force)) return null;
	let expectedTarget = false;
	if (operation.operation === "archive_entity") {
		// Redundant selectors are tolerated only when they name the flagged
		// entity itself (the agent echoes the name from attention details);
		// a selector naming a different row still cannot ride along.
		const entityValues = acceptedTargetValues(attention, "entityId", "name");
		expectedTarget =
			typeof payload.entity_id === "string" &&
			payload.entity_id === attention.details.entityId &&
			attention.subjectRef === `entity:${payload.entity_id}` &&
			selectorsNameFlaggedTarget(payload, [
				{ key: "selector", accepted: entityValues },
				{ key: "entity", accepted: entityValues },
				{ key: "name", accepted: entityValues },
			]);
	} else if (operation.operation === "archive_aspect") {
		const entityValues = acceptedTargetValues(attention, "entityId", "name");
		const aspectValues = acceptedTargetValues(attention, "aspectId", "aspectName");
		expectedTarget =
			typeof payload.entity_id === "string" &&
			typeof payload.aspect_id === "string" &&
			payload.entity_id === attention.details.entityId &&
			payload.aspect_id === attention.details.aspectId &&
			attention.subjectRef === `aspect:${payload.aspect_id}` &&
			selectorsNameFlaggedTarget(payload, [
				{ key: "selector", accepted: entityValues },
				{ key: "entity", accepted: entityValues },
				{ key: "name", accepted: entityValues },
				{ key: "aspect", accepted: aspectValues },
			]);
	} else if (operation.operation === "archive_claim_value") {
		expectedTarget =
			typeof payload.attribute_id === "string" &&
			payload.attribute_id === attention.details.attributeId &&
			attention.subjectRef === `attribute:${payload.attribute_id}`;
	} else if (operation.operation === "archive_link") {
		const linkId = payload.id ?? payload.dependency_id ?? payload.link_id;
		expectedTarget =
			typeof linkId === "string" && linkId === attention.details.linkId && attention.subjectRef === `link:${linkId}`;
	} else if (operation.operation === "merge_entities") {
		const targetId = payload.target_entity_id;
		const sourceIds = payload.source_entity_ids;
		const groupIds = semanticDuplicateIds(accessor, agentId, attention.details.canonicalName ?? "");
		expectedTarget =
			attention.subjectRef === `duplicate:${attention.details.canonicalName}` &&
			typeof targetId === "string" &&
			noSelectors(payload, [
				"target_entity",
				"target",
				"target_id",
				"source_entities",
				"sources",
				"source_entity",
				"source",
				"source_ids",
				"source_entity_id",
				"source_id",
			]) &&
			groupIds.size > 1 &&
			groupIds.has(targetId) &&
			Array.isArray(sourceIds) &&
			sourceIds.length > 0 &&
			sourceIds.every((id) => typeof id === "string" && groupIds.has(id) && id !== targetId);
	}
	if (!expectedTarget) return null;
	return {
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
	};
}

function provenanceForEvidence(
	accessor: DbAccessor,
	agentId: string,
	operation: DreamingOperationRequest,
	allowedEvidence: readonly DreamingAgentEvidence[] | undefined,
): DreamingOperationProvenance | null {
	const citations = operation.evidence ?? [];
	if (citations.length === 0) return null;
	const matched: DreamingAgentEvidence[] = [];
	for (const citation of citations) {
		const record = citeEvidence(accessor, agentId, citation, allowedEvidence);
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

/**
 * The sole daemon-owned apply seam for Dreaming agents. Pi passes the bounded
 * evidence window it gave the session; MCP/CLI callers resolve citations back
 * through the canonical episodic selector. Neither executor writes SQLite.
 */
export function applyDreamingOperations(params: {
	readonly accessor: DbAccessor;
	readonly agentId: string;
	readonly actor: string;
	readonly operations: readonly DreamingOperationRequest[];
	readonly allowedEvidence?: readonly DreamingAgentEvidence[];
}): ApplyDreamingOperationsResult {
	if (params.operations.length === 0) return { ok: false, items: [], error: "operations are required" };
	const allowedOperations = new Set<string>(ONTOLOGY_PROPOSAL_OPERATIONS);
	const validated: OntologyOperationInput[] = [];
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
		const provenance = provenanceForEvidence(params.accessor, params.agentId, operation, params.allowedEvidence);
		const resolvedProvenance = provenance ?? attentionProvenance(params.accessor, params.agentId, operation);
		if (resolvedProvenance === null) {
			return {
				ok: false,
				items: [],
				error: "Every operation must cite an exact quote from scoped episodic evidence",
			};
		}
		validated.push({
			operation: operation.operation,
			payload: operation.payload,
			reason: operation.reason,
			evidence: resolvedProvenance.evidence,
			confidence: operation.confidence,
			risk: operation.risk ?? null,
			sourceKind: resolvedProvenance.sourceKind,
			sourceId: resolvedProvenance.sourceId,
			sourcePath: resolvedProvenance.sourcePath,
			sourceRoot: resolvedProvenance.sourceRoot,
		});
	}

	const items: DreamingOperationItem[] = [];
	params.accessor.withWriteTx((db) => {
		for (let index = 0; index < validated.length; index += 1) {
			const savepoint = `signet_dream_op_${index}`;
			db.exec(`SAVEPOINT ${savepoint}`);
			try {
				const batch = applyOntologyOperationBatchInTx(db, {
					agentId: params.agentId,
					actor: params.actor,
					operations: [validated[index]!],
				});
				db.exec(`RELEASE SAVEPOINT ${savepoint}`);
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
