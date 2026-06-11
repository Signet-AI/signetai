import type { EntityDependency } from "@signetai/core";
import type { DbAccessor } from "./db-accessor";
import { getEntityDependencyById } from "./knowledge-graph";
import {
	type OntologyEvidenceItem,
	type OntologyEvidenceRef,
	readOntologyEvidenceRef,
	resolveOntologyEvidenceRef,
	uniqueOntologyEvidenceRefs,
} from "./ontology-evidence";

export interface OntologyLinkEvidenceResult {
	readonly dependency: EntityDependency;
	readonly items: readonly OntologyEvidenceItem[];
	readonly count: number;
}

export interface GetOntologyLinkEvidenceParams {
	readonly agentId: string;
	readonly id: string;
}

export class OntologyLinkEvidenceError extends Error {
	constructor(
		message: string,
		readonly status: 404,
	) {
		super(message);
		this.name = "OntologyLinkEvidenceError";
	}
}

function linkEvidenceRefs(dependency: EntityDependency): OntologyEvidenceRef[] {
	const refs: OntologyEvidenceRef[] = [];
	if (dependency.proposalId !== null) {
		refs.push({
			sourceKind: "ontology_proposal",
			sourceId: dependency.proposalId,
			sourcePath: null,
			memoryId: null,
			quote: null,
			reference: {
				dependency_id: dependency.id,
				proposal_id: dependency.proposalId,
			},
		});
	}
	refs.push(
		...dependency.proposalEvidence
			.map(readOntologyEvidenceRef)
			.filter((ref): ref is OntologyEvidenceRef => ref !== null),
	);
	if (dependency.sourceKind !== null || dependency.sourceId !== null) {
		refs.push({
			sourceKind: dependency.sourceKind,
			sourceId: dependency.sourceId,
			sourcePath: null,
			memoryId: null,
			quote: null,
			reference: {
				dependency_id: dependency.id,
				source_kind: dependency.sourceKind,
				source_id: dependency.sourceId,
			},
		});
	}
	if (dependency.sourcePath !== null) {
		refs.push({
			sourceKind: dependency.sourceKind,
			sourceId: dependency.sourceId,
			sourcePath: dependency.sourcePath,
			memoryId: null,
			quote: null,
			reference: {
				dependency_id: dependency.id,
				source_kind: dependency.sourceKind,
				source_id: dependency.sourceId,
				source_path: dependency.sourcePath,
				source_root: dependency.sourceRoot,
			},
		});
	}
	return uniqueOntologyEvidenceRefs(refs);
}

export function getOntologyLinkEvidence(
	accessor: DbAccessor,
	params: GetOntologyLinkEvidenceParams,
): OntologyLinkEvidenceResult {
	const dependency = getEntityDependencyById(accessor, params);
	if (dependency === null) throw new OntologyLinkEvidenceError("Link not found", 404);
	const items = accessor.withReadDb((db) =>
		linkEvidenceRefs(dependency).map((ref) => resolveOntologyEvidenceRef(db, params.agentId, ref)),
	);
	return {
		dependency,
		items,
		count: items.length,
	};
}
