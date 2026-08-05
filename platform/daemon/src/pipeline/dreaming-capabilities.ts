/**
 * Canonical Dreaming capability registry.
 *
 * Pi sessions invoke these handlers in-process; MCP and CLI invoke the daemon
 * capability route. The registry is therefore the one owner of capability
 * names, schemas, scope, validation, and graph/evidence reads.
 */
import { z } from "zod";
import type { DbAccessor } from "../db-accessor";
import { classifyEntityQuality } from "../entity-quality";
import { searchEpisodicSources } from "../episodic-sources";
import {
	getAttributesForAspectFiltered,
	getEntityAspectsWithCounts,
	getEntityDependenciesDetailed,
	getKnowledgeEntityDetail,
	listKnowledgeEntities,
} from "../knowledge-graph";
import { getOntologyClaimEvidence } from "../ontology-claim-evidence";
import { getOntologyLinkEvidence } from "../ontology-link-evidence";
import { findDuplicateEntityMerges } from "../ontology-proposals";
import { detectProspectiveContradictionRisk } from "./antonyms";
import { enqueueDreamingAttentionInTx } from "./dreaming-attention";
import type { DreamingAgentEvidence } from "./dreaming-evidence";
import { DREAMING_ONTOLOGY_OPERATION_SCHEMA } from "./dreaming-operation-contract";
import {
	type ApplyDreamingOperationsResult,
	type DreamingOperationRequest,
	applyDreamingOperations,
} from "./dreaming-operations";
import { readDreamingRunbook, writeDreamingRunbook } from "./dreaming-runbook";

const bounded = (value: number | undefined, fallback: number, max: number): number =>
	Math.min(Math.max(Math.floor(value ?? fallback), 1), max);

const pagination = {
	limit: z.number().finite().optional(),
	offset: z.number().finite().optional(),
};

/** Required details keys per hygiene subjectRef prefix, matching the apply gate. */
const HYGIENE_SUBJECT_DETAIL_KEYS: Readonly<Record<string, readonly string[]>> = {
	entity: ["entityId"],
	aspect: ["entityId", "aspectId"],
	attribute: ["attributeId"],
	link: ["linkId"],
	duplicate: ["canonicalName"],
};

export const DREAMING_CAPABILITY_IDS = [
	"search_entities",
	"get_entity",
	"list_aspect_claims",
	"walk_links",
	"get_claim_evidence",
	"get_link_evidence",
	"search_evidence",
	"check_entity_label",
	"find_duplicate_entities",
	"check_contradiction",
	"runbook_read",
	"runbook_write",
	"record_hygiene_attention",
	"apply_ontology_ops",
] as const;

export type DreamingCapabilityId = (typeof DREAMING_CAPABILITY_IDS)[number];

export interface DreamingCapabilityResult {
	readonly tool: DreamingCapabilityId;
	readonly ok: boolean;
	readonly error?: string;
	readonly [key: string]: unknown;
}

type DreamingCapabilityOutput = {
	readonly ok: boolean;
	readonly error?: string;
	readonly [key: string]: unknown;
};

export interface DreamingToolCallTrace {
	readonly toolCallId: string;
	readonly tool: DreamingCapabilityId;
	readonly input: unknown;
	readonly output: DreamingCapabilityResult;
	readonly latencyMs: number;
}

export interface DreamingCapability {
	readonly id: DreamingCapabilityId;
	readonly title: string;
	readonly description: string;
	readonly readOnly: boolean;
	readonly inputSchema: z.ZodType;
	invoke(input: unknown): Promise<DreamingCapabilityResult>;
}

export interface CreateDreamingCapabilitiesParams {
	readonly accessor: DbAccessor;
	readonly agentId: string;
	readonly actor: string;
	/** Present only for a live Dreaming pass; protects runbook writes. */
	readonly passId?: string;
	readonly evidence?: readonly DreamingAgentEvidence[];
	readonly onOperationsApplied?: (
		result: ApplyDreamingOperationsResult,
		operations: readonly DreamingOperationRequest[],
	) => void;
	readonly onToolCall?: (trace: DreamingToolCallTrace) => void;
}

export interface DreamingCapabilityManifestEntry {
	readonly id: DreamingCapabilityId;
	readonly title: string;
	readonly description: string;
	readonly readOnly: boolean;
	readonly inputSchema: Record<string, unknown>;
}

function capability<T extends z.ZodType>(
	id: DreamingCapabilityId,
	title: string,
	description: string,
	readOnly: boolean,
	inputSchema: T,
	run: (input: z.output<T>) => Promise<DreamingCapabilityOutput>,
): DreamingCapability {
	return {
		id,
		title,
		description,
		readOnly,
		inputSchema,
		async invoke(input): Promise<DreamingCapabilityResult> {
			const parsed = inputSchema.safeParse(input);
			if (!parsed.success) {
				return {
					tool: id,
					ok: false,
					error: parsed.error.issues
						.map((issue) => `${issue.path.length > 0 ? `${issue.path.join(".")}: ` : ""}${issue.message}`)
						.join("; "),
				};
			}
			try {
				const output = await run(parsed.data);
				return { tool: id, ...output };
			} catch (error) {
				return { tool: id, ok: false, error: error instanceof Error ? error.message : String(error) };
			}
		},
	};
}

/** The one scope-bound handler registry used by Pi, daemon HTTP, MCP, and CLI. */
export function createDreamingCapabilities(params: CreateDreamingCapabilitiesParams): readonly DreamingCapability[] {
	const { accessor, agentId, actor } = params;
	const evidence = params.evidence ?? [];
	return [
		capability(
			"search_entities",
			"Search entities",
			"Search the scoped knowledge graph by entity name fragment and optional type.",
			true,
			z.object({ query: z.string().optional(), type: z.string().optional(), ...pagination }),
			async ({ query, type, limit, offset }) => ({
				ok: true,
				items: listKnowledgeEntities(accessor, {
					agentId,
					query,
					type,
					limit: bounded(limit, 20, 100),
					offset: Math.max(0, Math.floor(offset ?? 0)),
				}).map((item) => ({
					id: item.entity.id,
					name: item.entity.name,
					entityType: item.entity.entityType,
					aspectCount: item.aspectCount,
					attributeCount: item.attributeCount,
					constraintCount: item.constraintCount,
					dependencyCount: item.dependencyCount,
				})),
			}),
		),
		capability(
			"get_entity",
			"Get entity detail",
			"Fetch one scoped entity and its aspects with attribute and constraint counts.",
			true,
			z.object({ entityId: z.string().min(1) }),
			async ({ entityId }) => {
				const detail = getKnowledgeEntityDetail(accessor, entityId, agentId);
				if (!detail) return { ok: false, error: "Entity not found" };
				return {
					ok: true,
					entity: detail.entity,
					aspectCount: detail.aspectCount,
					attributeCount: detail.attributeCount,
					constraintCount: detail.constraintCount,
					dependencyCount: detail.dependencyCount,
					aspects: getEntityAspectsWithCounts(accessor, entityId, agentId).map((aspect) => ({
						id: aspect.aspect.id,
						name: aspect.aspect.name,
						attributeCount: aspect.attributeCount,
						constraintCount: aspect.constraintCount,
					})),
				};
			},
		),
		capability(
			"list_aspect_claims",
			"List aspect claims",
			"List active claim attributes for one scoped entity aspect by stable ids.",
			true,
			z.object({ entityId: z.string().min(1), aspectId: z.string().min(1), ...pagination }),
			async ({ entityId, aspectId, limit, offset }) => ({
				ok: true,
				items: getAttributesForAspectFiltered(accessor, {
					entityId,
					aspectId,
					agentId,
					kind: "attribute",
					status: "active",
					limit: bounded(limit, 50, 200),
					offset: Math.max(0, Math.floor(offset ?? 0)),
				}),
			}),
		),
		capability(
			"walk_links",
			"Walk dependency links",
			"Walk incoming and/or outgoing scoped dependency links for an entity.",
			true,
			z.object({ entityId: z.string().min(1), direction: z.enum(["incoming", "outgoing", "both"]).optional() }),
			async ({ entityId, direction }) => ({
				ok: true,
				items: getEntityDependenciesDetailed(accessor, { entityId, agentId, direction: direction ?? "both" }),
			}),
		),
		capability(
			"get_claim_evidence",
			"Get claim evidence",
			"Resolve provenance for a scoped claim path.",
			true,
			z.object({
				entity: z.string().min(1),
				aspect: z.string().min(1),
				group: z.string().min(1),
				claim: z.string().min(1),
				...pagination,
			}),
			async ({ entity, aspect, group, claim, limit, offset }) => ({
				ok: true,
				result: getOntologyClaimEvidence(accessor, { agentId, entity, aspect, group, claim, limit, offset }),
			}),
		),
		capability(
			"get_link_evidence",
			"Get link evidence",
			"Resolve provenance for a scoped dependency link by stable id.",
			true,
			z.object({ id: z.string().min(1) }),
			async ({ id }) => ({ ok: true, result: getOntologyLinkEvidence(accessor, { agentId, id }) }),
		),
		capability(
			"search_evidence",
			"Search episodic evidence",
			"Full-text search immutable episodic memories, artifacts, transcripts, and summaries in this scope.",
			true,
			z.object({ query: z.string().min(1), limit: z.number().finite().optional() }),
			async ({ query, limit }) => ({
				ok: true,
				items: accessor.withReadDb((db) => searchEpisodicSources(db, { agentId, query, limit })),
			}),
		),
		capability(
			"check_entity_label",
			"Check entity label",
			"Run the daemon's deterministic entity-label gate before proposing an entity name.",
			true,
			z.object({ name: z.string(), type: z.string().optional() }),
			async ({ name, type }) => ({ ok: true, result: classifyEntityQuality(name, type) }),
		),
		capability(
			"find_duplicate_entities",
			"Find duplicate entities",
			"Find exact-canonical duplicate entity merge candidates in this agent scope without writing a proposal.",
			true,
			z.object({ name: z.string().min(1) }),
			async ({ name }) => ({ ok: true, items: findDuplicateEntityMerges(accessor, { agentId, name }) }),
		),
		capability(
			"check_contradiction",
			"Check claim contradiction",
			"Compare a proposed claim value with active values in one scoped aspect using the daemon's conservative deterministic guard.",
			true,
			z.object({ entityId: z.string().min(1), aspectId: z.string().min(1), value: z.string().min(1) }),
			async ({ entityId, aspectId, value }) => ({
				ok: true,
				items: getAttributesForAspectFiltered(accessor, {
					entityId,
					aspectId,
					agentId,
					kind: "attribute",
					status: "active",
					limit: 200,
					offset: 0,
				}).map((attribute) => ({
					attributeId: attribute.id,
					content: attribute.content,
					...detectProspectiveContradictionRisk(value, attribute.content),
				})),
			}),
		),
		capability(
			"runbook_read",
			"Read Dreaming runbook",
			"Read recent scoped pass outcomes, evidence windows, quarantines, and structured runbook notes.",
			true,
			z.object({ limit: z.number().finite().optional() }),
			async ({ limit }) => ({ ok: true, items: readDreamingRunbook(accessor, agentId, bounded(limit, 5, 20)) }),
		),
		capability(
			"runbook_write",
			"Write Dreaming runbook",
			"Before finishing a Dreaming pass, store one short structured note for future passes to review.",
			false,
			z.object({
				summary: z.string().trim().min(1).max(2_000),
				openQuestions: z.array(z.string().trim().min(1).max(500)).max(20).default([]),
				deferred: z.array(z.string().trim().min(1).max(500)).max(20).default([]),
			}),
			async (entry) => {
				if (!params.passId) return { ok: false, error: "Runbook writes require a live Dreaming pass" };
				if (!writeDreamingRunbook(accessor, { agentId, passId: params.passId, entry })) {
					return { ok: false, error: "Dreaming pass is not running in this agent scope" };
				}
				return { ok: true, passId: params.passId };
			},
		),
		capability(
			"record_hygiene_attention",
			"Record hygiene attention",
			'Record that an inspected scoped entity, aspect, claim attribute, link, or duplicate group was flagged for hygiene. The returned id is valid provenance (provenance: "attention:<id>") for archive_entity, archive_aspect, archive_claim_value, archive_link, and merge_entities on the flagged target — no episodic source text required. Content-bearing writes still require exact episodic quotes.',
			false,
			z
				.object({
					subjectRef: z.string().trim().min(1).max(512),
					details: z.record(z.string(), z.string()).optional(),
					priority: z.number().finite().min(0).max(100).optional(),
				})
				.refine((value) => {
					const prefix = value.subjectRef.split(":")[0];
					const required = HYGIENE_SUBJECT_DETAIL_KEYS[prefix];
					if (!required) return false;
					const details = value.details ?? {};
					return required.every((key) => typeof details[key] === "string" && details[key].trim().length > 0);
				}, "subjectRef must start with entity:, aspect:, attribute:, link:, or duplicate: and details must include the matching target id (entityId, aspectId, attributeId, linkId, or canonicalName)"),
			async ({ subjectRef, details, priority }) => {
				const id = accessor.withWriteTx((db) =>
					enqueueDreamingAttentionInTx(db, { agentId, kind: "hygiene", subjectRef, details, priority }),
				);
				return { ok: true, id, subjectRef, kind: "hygiene" };
			},
		),
		capability(
			"apply_ontology_ops",
			"Apply ontology operations",
			'Apply every semantic write through the daemon audit seam. Inspect relevant scoped graph state first. Content-bearing writes need an exact quote and source_ref from canonical episodic evidence. Hygiene archives/merges of inspected targets may instead cite provenance: "attention:<id>" using an id from <semantic_attention> or from record_hygiene_attention.',
			false,
			z.object({ operations: z.array(DREAMING_ONTOLOGY_OPERATION_SCHEMA).min(1).max(100) }),
			async ({ operations }) => {
				const result = applyDreamingOperations({ accessor, agentId, actor, operations, allowedEvidence: evidence });
				params.onOperationsApplied?.(result, operations);
				return { ok: result.ok, ...(result.error ? { error: result.error } : {}), items: result.items };
			},
		),
	];
}

export function getDreamingCapability(
	params: CreateDreamingCapabilitiesParams,
	id: string,
): DreamingCapability | undefined {
	return createDreamingCapabilities(params).find((candidate) => candidate.id === id);
}

/** Public metadata lets CLI and MCP discover the exact registry without a second list. */
export function getDreamingCapabilityManifest(): readonly DreamingCapabilityManifestEntry[] {
	return createDreamingCapabilities({
		accessor: undefined as never,
		agentId: "manifest",
		actor: "manifest",
	}).map((capability) => ({
		id: capability.id,
		title: capability.title,
		description: capability.description,
		readOnly: capability.readOnly,
		inputSchema: z.toJSONSchema(capability.inputSchema) as Record<string, unknown>,
	}));
}
