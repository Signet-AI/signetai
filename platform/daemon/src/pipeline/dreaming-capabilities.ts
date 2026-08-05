/**
 * Canonical Dreaming capability registry.
 *
 * Pi sessions invoke these handlers in-process; MCP and CLI invoke the daemon
 * capability route. The registry is therefore the one owner of capability
 * names, schemas, scope, validation, and graph/evidence reads. The surface is
 * deliberately bounded: the agent can only do what these methods define
 * (search, validate, apply, log) — no open-ended escape hatches.
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
import { getDreamingAttentionAcrossScopes, getDreamingAttentionScoped } from "./dreaming-attention";
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

export const DREAMING_CAPABILITY_IDS = [
	"search_entities",
	"get_entity",
	"list_aspect_claims",
	"walk_links",
	"get_evidence",
	"search_evidence",
	"validate_proposal",
	"runbook_read",
	"runbook_write",
	"attention_list",
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

/** Mutable build-time variant of the capability output (registry handlers). */
type MutableCapabilityOutput = {
	ok: boolean;
	error?: string;
	[key: string]: unknown;
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
	return [
		capability(
			"search_entities",
			"Search entities",
			"Search the knowledge graph for one agent scope by entity name fragment and optional type. Pass the agentId of the scope you are addressing.",
			true,
			z.object({
				agentId: z.string().min(1),
				query: z.string().optional(),
				type: z.string().optional(),
				...pagination,
			}),
			async ({ agentId: scopeId, query, type, limit, offset }) => ({
				ok: true,
				items: listKnowledgeEntities(accessor, {
					agentId: scopeId,
					query,
					type,
					limit: bounded(limit, 20, 100),
					offset: Math.max(0, Math.floor(offset ?? 0)),
				}).map((item) => ({
					id: item.entity.id,
					name: item.entity.name,
					entityType: item.entity.entityType,
					pinned: item.entity.pinned,
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
			"Fetch one entity in one agent scope with attribute/constraint counts and pinned status, optionally hydrated with its aspect claims and/or dependency links in the same call.",
			true,
			z.object({
				agentId: z.string().min(1),
				entityId: z.string().min(1),
				include: z.array(z.enum(["aspects", "links"])).optional(),
				direction: z.enum(["incoming", "outgoing", "both"]).optional(),
			}),
			async ({ agentId: scopeId, entityId, include, direction }) => {
				const detail = getKnowledgeEntityDetail(accessor, entityId, scopeId);
				if (!detail) return { ok: false, error: "Entity not found" };
				const result: MutableCapabilityOutput = {
					ok: true,
					entity: detail.entity,
					pinned: detail.entity.pinned === true,
					aspectCount: detail.aspectCount,
					attributeCount: detail.attributeCount,
					constraintCount: detail.constraintCount,
					dependencyCount: detail.dependencyCount,
				};
				if (include?.includes("aspects")) {
					result.aspects = getEntityAspectsWithCounts(accessor, entityId, scopeId).map((aspect) => ({
						id: aspect.aspect.id,
						name: aspect.aspect.name,
						attributeCount: aspect.attributeCount,
						constraintCount: aspect.constraintCount,
					}));
				}
				if (include?.includes("links")) {
					result.links = getEntityDependenciesDetailed(accessor, {
						entityId,
						agentId: scopeId,
						direction: direction ?? "both",
					});
				}
				return result;
			},
		),
		capability(
			"list_aspect_claims",
			"List aspect claims",
			"List active claim attributes for one entity aspect in one agent scope by stable ids.",
			true,
			z.object({ agentId: z.string().min(1), entityId: z.string().min(1), aspectId: z.string().min(1), ...pagination }),
			async ({ agentId: scopeId, entityId, aspectId, limit, offset }) => ({
				ok: true,
				items: getAttributesForAspectFiltered(accessor, {
					entityId,
					aspectId,
					agentId: scopeId,
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
			"Walk incoming and/or outgoing dependency links for an entity in one agent scope.",
			true,
			z.object({
				agentId: z.string().min(1),
				entityId: z.string().min(1),
				direction: z.enum(["incoming", "outgoing", "both"]).optional(),
			}),
			async ({ agentId: scopeId, entityId, direction }) => ({
				ok: true,
				items: getEntityDependenciesDetailed(accessor, { entityId, agentId: scopeId, direction: direction ?? "both" }),
			}),
		),
		capability(
			"get_evidence",
			"Get evidence",
			"Resolve provenance for a claim path in one agent scope (entity/aspect by stable id or name) or a dependency link by stable id.",
			true,
			z.object({
				agentId: z.string().min(1),
				ref: z.union([
					z.object({
						type: z.literal("claim"),
						entity: z.string().min(1),
						aspect: z.string().min(1),
						group: z.string().min(1),
						claim: z.string().min(1),
					}),
					z.object({ type: z.literal("link"), id: z.string().min(1) }),
				]),
				...pagination,
			}),
			async ({ agentId: scopeId, ref, limit, offset }) => {
				if (ref.type === "claim") {
					let entityName = ref.entity;
					let aspectName = ref.aspect;
					// Accept stable ids as well as names for the claim path:
					// search results surface ids, and the path resolver is
					// name-based.
					const detail = getKnowledgeEntityDetail(accessor, ref.entity, scopeId);
					if (detail) {
						entityName = detail.entity.name;
						const aspect = getEntityAspectsWithCounts(accessor, ref.entity, scopeId).find(
							(candidate) => candidate.aspect.id === ref.aspect || candidate.aspect.name === ref.aspect,
						);
						if (aspect) aspectName = aspect.aspect.name;
					}
					return {
						ok: true,
						result: getOntologyClaimEvidence(accessor, {
							agentId: scopeId,
							entity: entityName,
							aspect: aspectName,
							group: ref.group,
							claim: ref.claim,
							limit,
							offset,
						}),
					};
				}
				return { ok: true, result: getOntologyLinkEvidence(accessor, { agentId: scopeId, id: ref.id }) };
			},
		),
		capability(
			"search_evidence",
			"Search episodic evidence",
			"Full-text search immutable episodic memories, artifacts, transcripts, and summaries in one agent scope. Omit the query to list the most recent sources (e.g. with since as a cutoff). Artifacts are deduped by content hash: content-identical files across vault paths collapse to one canonical entry.",
			true,
			z.object({
				agentId: z.string().min(1),
				query: z.string().optional(),
				since: z.string().optional(),
				before: z.string().optional(),
				kind: z.enum(["memory", "artifact", "transcript", "summary"]).optional(),
				limit: z.number().finite().optional(),
			}),
			async ({ agentId: scopeId, query, since, before, kind, limit }) => ({
				ok: true,
				items: accessor.withReadDb((db) =>
					searchEpisodicSources(db, { agentId: scopeId, query: query ?? "", since, before, kind, limit }),
				),
			}),
		),
		capability(
			"validate_proposal",
			"Validate proposal",
			"Run the daemon's deterministic pre-write guards in one pass for one agent scope: entity-label gate, duplicate-entity check, and/or contradiction check against active aspect values.",
			true,
			z.object({
				agentId: z.string().min(1),
				name: z.string().optional(),
				type: z.string().optional(),
				entityId: z.string().optional(),
				aspectId: z.string().optional(),
				value: z.string().optional(),
			}),
			async ({ agentId: scopeId, name, type, entityId, aspectId, value }) => {
				const result: MutableCapabilityOutput = { ok: true };
				if (name !== undefined) {
					result.label = classifyEntityQuality(name, type);
					result.duplicates = findDuplicateEntityMerges(accessor, { agentId: scopeId, name });
				}
				if (entityId !== undefined && aspectId !== undefined && value !== undefined) {
					result.contradiction = getAttributesForAspectFiltered(accessor, {
						entityId,
						aspectId,
						agentId: scopeId,
						kind: "attribute",
						status: "active",
						limit: 200,
						offset: 0,
					}).map((attribute) => ({
						attributeId: attribute.id,
						content: attribute.content,
						...detectProspectiveContradictionRisk(value, attribute.content),
					}));
				}
				return result;
			},
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
			"attention_list",
			"List attention",
			"List attention records (the hygiene queue) by kind and resolution status. Omit agentId to see the whole install's queue (each record carries its owning agentId); pass agentId to narrow to one scope.",
			true,
			z.object({
				agentId: z.string().optional(),
				kind: z.string().optional(),
				status: z.enum(["pending", "resolved"]).optional(),
				limit: z.number().finite().optional(),
			}),
			async ({ agentId: scopeId, kind, status, limit }) => ({
				ok: true,
				items:
					scopeId !== undefined
						? getDreamingAttentionScoped(accessor, scopeId, {
								kind,
								status: status ?? "pending",
								limit: bounded(limit, 20, 100),
							})
						: getDreamingAttentionAcrossScopes(accessor, {
								kind,
								status: status ?? "pending",
								limit: bounded(limit, 50, 200),
							}),
			}),
		),
		capability(
			"apply_ontology_ops",
			"Apply ontology operations",
			'Apply every semantic write through the daemon audit seam in one batch, in one agent scope (pass the agentId whose graph you are maintaining — hygiene attention records belong to the agent that flagged them). Ops are processed in array order. Hygiene ops (flag, archive_*, merge_entities) cite provenance: "attention:$<index>" for a flag earlier in the same batch, or "attention:<uuid>" from a prior batch. Content-bearing ops cite evidence with exact quotes from canonical episodic evidence in that scope.',
			false,
			z.object({
				agentId: z.string().min(1),
				operations: z.array(DREAMING_ONTOLOGY_OPERATION_SCHEMA).min(1).max(100),
			}),
			async ({ agentId: scopeId, operations }) => {
				const result = applyDreamingOperations({
					accessor,
					agentId: scopeId,
					actor,
					operations,
					passId: params.passId,
				});
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
