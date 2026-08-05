/**
 * Model-facing contract for the daemon-owned ontology apply seam.
 *
 * The Dreaming surface presents a fixed vocabulary (per the dreaming prompt
 * spec): hygiene ops target flagged rows by id and cite attention provenance;
 * content ops target existing rows by id and cite exact quotes from episodic
 * evidence. Payloads are mapped to the shared applicator contracts inside
 * applyDreamingOperations — the applicators in ontology-proposals.ts are used
 * by MCP/CLI too and are not reshaped here.
 *
 * Ops not listed here (restore_claim_version, attach_interface) are not part
 * of the Dreaming vocabulary: the agent can only do what the surface defines.
 */
import { ATTRIBUTE_KINDS, DEPENDENCY_TYPES, ENTITY_TYPES, ONTOLOGY_PROPOSAL_OPERATIONS } from "@signet/core";
import { z } from "zod";

const text = z.string().min(1);
const score = z.number().finite();
const entityType = z
	.enum(ENTITY_TYPES)
	.describe("The entity's ontology type. Choose the most specific supported type.");
const entityName = text.describe("A stable, human-readable entity name.");
const entityId = text.describe("The stable id of an existing entity.");
const aspectName = text.describe("The specific domain of knowledge this claim belongs to.");
const aspectId = text.describe("The stable id of an existing aspect.");
const claimValue = text.describe("A complete atomic assertion that is understandable on its own.");
const claimKey = text.describe("A stable semantic slot key for versions of the same claim.");
const linkType = z.enum(DEPENDENCY_TYPES).describe("The dependency type between the two entities.");

function payload<T extends z.ZodRawShape>(shape: T) {
	return z.object(shape).passthrough();
}

const reasonField = { reason: text.describe("Why this operation is being applied.").optional() };

/**
 * Model-facing payload shapes. Keyed by the Dreaming vocabulary: the 18 ops
 * the agent may emit. Hygiene ops require provenance (attention); content ops
 * require evidence (exact quotes).
 */
export const DREAMING_ONTOLOGY_PAYLOAD_SCHEMAS = {
	// --- hygiene ops: no episodic evidence required; provenance required ---
	flag: payload({
		subjectRef: text.describe(
			"The flagged target, e.g. entity:<id>, aspect:<id>, attribute:<id>, link:<id>, or duplicate:<canonical name>.",
		),
		details: z.record(z.string(), z.string()).describe("Inspection facts about the flagged target.").optional(),
		priority: z.number().finite().min(0).max(100).describe("Priority of the flag (0-100).").optional(),
	}),
	archive_entity: payload({ target: entityId, ...reasonField }),
	archive_aspect: payload({ target: aspectId, ...reasonField }),
	archive_claim_value: payload({ target: text.describe("The stable id of the claim attribute."), ...reasonField }),
	archive_link: payload({ target: text.describe("The stable id of the dependency link."), ...reasonField }),
	merge_entities: payload({
		targets: z.array(entityId).min(2).describe("All entities in the duplicate group."),
		survivor: entityId.describe("The entity that survives the merge."),
		...reasonField,
	}),

	// --- content-bearing ops: require evidence with exact quotes ---
	create_entity: payload({ name: entityName, type: entityType }),
	add_claim_value: payload({ entityId, aspectId, claimKey, value: claimValue }),
	set_claim_value: payload({ entityId, aspectId, claimKey, value: claimValue }),
	supersede_claim_value: payload({
		entityId,
		aspectId,
		claimKey,
		value: claimValue.describe("The new value that supersedes the current one."),
		attributeId: text
			.describe("The stable id of the claim to supersede. Omit to supersede the current active claim for the key.")
			.optional(),
	}),
	rename_entity: payload({ entityId, newName: entityName }),
	create_aspect: payload({ entityId, name: aspectName }),
	rename_aspect: payload({ entityId, aspectId, newName: aspectName }),
	create_link: payload({ fromEntityId: entityId, toEntityId: entityId, linkType }),
	update_link: payload({
		linkId: text.describe("The stable id of the dependency link."),
		linkType: linkType.optional(),
		...reasonField,
	}),
	create_policy: payload({
		entityId: text.describe("The entity the policy applies to."),
		name: text.describe("The policy kind."),
		definition: text.describe("The policy content."),
	}),
	create_action_type: payload({ name: entityName }),
	create_interface: payload({ name: entityName }),
} as const satisfies Record<string, z.ZodType>;

export const DREAMING_OPERATION_IDS = [
	...ONTOLOGY_PROPOSAL_OPERATIONS.filter((op) => op !== "restore_claim_version" && op !== "attach_interface"),
	"flag",
] as const;

const operationBase = {
	reason: z.string().optional(),
	evidence: z
		.array(z.unknown())
		.describe(
			"Content-bearing ops only: exact-quote citations from canonical episodic evidence, each {quote, source_ref}.",
		)
		.optional(),
	provenance: z
		.string()
		.min(1)
		.describe(
			'Hygiene ops only: "attention:$<index>" referencing a flag op earlier in the same batch, or "attention:<uuid>" from a prior batch.',
		)
		.optional(),
	confidence: z.number().finite().min(0).max(1).optional(),
	risk: z.string().nullable().optional(),
};

function operation<T extends (typeof DREAMING_OPERATION_IDS)[number]>(id: T) {
	return z.object({ operation: z.literal(id), payload: DREAMING_ONTOLOGY_PAYLOAD_SCHEMAS[id], ...operationBase });
}

export const DREAMING_ONTOLOGY_OPERATION_SCHEMA = z.discriminatedUnion("operation", [
	operation("create_entity"),
	operation("add_claim_value"),
	operation("set_claim_value"),
	operation("rename_entity"),
	operation("archive_entity"),
	operation("create_aspect"),
	operation("rename_aspect"),
	operation("archive_aspect"),
	operation("archive_claim_value"),
	operation("create_link"),
	operation("update_link"),
	operation("archive_link"),
	operation("merge_entities"),
	operation("supersede_claim_value"),
	operation("create_policy"),
	operation("create_action_type"),
	operation("create_interface"),
	operation("flag"),
]);
