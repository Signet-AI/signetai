import {
	ATTRIBUTE_KINDS,
	ATTRIBUTE_STATUSES,
	type AttributeKind,
	type AttributeStatus,
	type Entity,
	type EntityAspect,
	type EntityAttribute,
} from "@signet/core";
import type { DbAccessor } from "./db-accessor";
import { listEntityAttributesByPath } from "./knowledge-graph";
import {
	type OntologyEvidenceItem,
	type OntologyEvidenceRef,
	readOntologyEvidenceRef,
	resolveOntologyEvidenceRef,
	uniqueOntologyEvidenceRefs,
} from "./ontology-evidence";

export interface OntologyClaimEvidenceValue {
	readonly attribute: EntityAttribute;
	readonly evidence: readonly OntologyEvidenceItem[];
	readonly evidenceCount: number;
}

export interface OntologyClaimEvidenceResult {
	readonly entity: Entity;
	readonly aspect: EntityAspect;
	readonly groupKey: string;
	readonly claimKey: string;
	readonly items: readonly OntologyClaimEvidenceValue[];
	readonly count: number;
}

export interface GetOntologyClaimEvidenceParams {
	readonly agentId: string;
	readonly entity: string;
	readonly aspect: string;
	readonly group: string;
	readonly claim: string;
	readonly kind?: AttributeKind;
	readonly status?: AttributeStatus | "all";
	readonly limit?: number;
	readonly offset?: number;
}

export class OntologyClaimEvidenceError extends Error {
	constructor(
		message: string,
		readonly status: 400 | 404,
	) {
		super(message);
		this.name = "OntologyClaimEvidenceError";
	}
}

export function parseOntologyClaimAttributeKind(value: string | undefined): AttributeKind | undefined {
	return ATTRIBUTE_KINDS.includes(value as AttributeKind) ? (value as AttributeKind) : undefined;
}

export function parseOntologyClaimAttributeStatus(value: string | undefined): AttributeStatus | "all" | undefined {
	return value === "all" || ATTRIBUTE_STATUSES.includes(value as AttributeStatus)
		? (value as AttributeStatus | "all")
		: undefined;
}

function attributeEvidenceRefs(attribute: EntityAttribute): OntologyEvidenceRef[] {
	const refs: OntologyEvidenceRef[] = [];
	if (attribute.proposalId !== null) {
		refs.push({
			sourceKind: "ontology_proposal",
			sourceId: attribute.proposalId,
			sourcePath: null,
			memoryId: null,
			quote: null,
			reference: {
				attribute_id: attribute.id,
				proposal_id: attribute.proposalId,
			},
		});
	}
	refs.push(
		...attribute.proposalEvidence
			.map(readOntologyEvidenceRef)
			.filter((ref): ref is OntologyEvidenceRef => ref !== null),
	);
	if (attribute.sourceKind !== null || attribute.sourceId !== null) {
		refs.push({
			sourceKind: attribute.sourceKind,
			sourceId: attribute.sourceId,
			sourcePath: null,
			memoryId: null,
			quote: null,
			reference: {
				attribute_id: attribute.id,
				source_kind: attribute.sourceKind,
				source_id: attribute.sourceId,
			},
		});
	}
	if (attribute.sourcePath !== null) {
		refs.push({
			sourceKind: attribute.sourceKind,
			sourceId: attribute.sourceId,
			sourcePath: attribute.sourcePath,
			memoryId: null,
			quote: null,
			reference: {
				attribute_id: attribute.id,
				source_kind: attribute.sourceKind,
				source_id: attribute.sourceId,
				source_path: attribute.sourcePath,
				source_root: attribute.sourceRoot,
			},
		});
	}
	if (attribute.memoryId !== null) {
		refs.push({
			sourceKind: null,
			sourceId: null,
			sourcePath: null,
			memoryId: attribute.memoryId,
			quote: null,
			reference: {
				attribute_id: attribute.id,
				memory_id: attribute.memoryId,
			},
		});
	}
	return uniqueOntologyEvidenceRefs(refs);
}

export function getOntologyClaimEvidence(
	accessor: DbAccessor,
	params: GetOntologyClaimEvidenceParams,
): OntologyClaimEvidenceResult {
	const limit = Math.min(Math.max(params.limit ?? 20, 1), 200);
	const offset = Math.max(params.offset ?? 0, 0);
	const result = listEntityAttributesByPath(accessor, {
		agentId: params.agentId,
		entity: params.entity,
		aspect: params.aspect,
		group: params.group,
		claim: params.claim,
		kind: params.kind,
		status: params.status,
		limit,
		offset,
	});
	if (result === null) throw new OntologyClaimEvidenceError("Claim path not found", 404);

	const items = accessor.withReadDb((db) =>
		result.items.map((attribute) => {
			const evidence = attributeEvidenceRefs(attribute).map((ref) =>
				resolveOntologyEvidenceRef(db, params.agentId, ref),
			);
			return {
				attribute,
				evidence,
				evidenceCount: evidence.length,
			};
		}),
	);

	return {
		entity: result.entity,
		aspect: result.aspect,
		groupKey: params.group,
		claimKey: params.claim,
		items,
		count: items.length,
	};
}
