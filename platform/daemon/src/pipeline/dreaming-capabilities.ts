/**
 * Canonical Dreaming capability registry.
 *
 * Pi sessions invoke these handlers in-process; MCP and CLI invoke the daemon
 * capability route. The registry is therefore the one owner of capability
 * names, schemas, scope, validation, and graph/evidence reads. The surface is
 * deliberately bounded: the agent can only do what these methods define
 * (search, validate, apply, log) — no open-ended escape hatches.
 */
import { type Entity, type EntityAttribute, MEMORY_CONTENT_WITHHELD_NOTICE, scanMemoryContent } from "@signet/core";
import { z } from "zod";
import type { DbAccessor, ReadDb } from "../db-accessor";
import { classifyEntityQuality } from "../entity-quality";
import type { EpisodicSourceRecord } from "../episodic-sources";
import { readEpisodicSource, searchEpisodicSources } from "../episodic-sources";
import {
	getAttributesForAspectFiltered,
	getEntityAspectsWithCounts,
	getEntityDependenciesDetailed,
	getKnowledgeEntityDetail,
	listKnowledgeEntities,
} from "../knowledge-graph";
import { isMemoryContentContextEligible } from "../memory-content-safety";
import { getOntologyClaimEvidence } from "../ontology-claim-evidence";
import { listOntologyContradictions } from "../ontology-contradictions";
import { getOntologyLinkEvidence } from "../ontology-link-evidence";
import { type GraphWriteCaps, findDuplicateEntityMerges } from "../ontology-proposals";
import { detectProspectiveContradictionRisk } from "./antonyms";
import { getDreamingAttentionAcrossScopes, getDreamingAttentionScoped } from "./dreaming-attention";
import { nextDreamingEvidenceFragment, renderDreamingEvidence } from "./dreaming-evidence";
import type { DreamingAgentEvidence } from "./dreaming-evidence";
import { DREAMING_ONTOLOGY_OPERATION_SCHEMA } from "./dreaming-operation-contract";
import {
	type ApplyDreamingOperationsResult,
	type DreamingOperationRequest,
	applyDreamingOperations,
} from "./dreaming-operations";
import { readDreamingRunbook, writeDreamingRunbook } from "./dreaming-runbook";
import { collectReviewDueClaims } from "./memory-review-due";

const bounded = (value: number | undefined, fallback: number, max: number): number =>
	Math.min(Math.max(Math.floor(value ?? fallback), 1), max);

const MAX_EVIDENCE_EXCERPT_CHARS = 2_000;
const MAX_EVIDENCE_RESULT_CHARS = 16_000;
const MAX_HYDRATED_ITEMS = 50;
const MAX_ENTITY_TEXT_CHARS = 2_000;

function boundedText(value: string | undefined, maxChars: number): string | undefined {
	if (value === undefined || value.length <= maxChars) return value;
	return value.slice(0, maxChars);
}

function filterDreamingAttributes(
	accessor: DbAccessor,
	agentId: string,
	attributes: readonly EntityAttribute[],
): readonly EntityAttribute[] {
	return accessor.withReadDb((db) =>
		attributes.filter((attribute) => {
			if (attribute.memoryId) {
				return isMemoryContentContextEligible(db, {
					agentId,
					sourceKind: "memory",
					sourceId: attribute.memoryId,
					content: attribute.content,
				});
			}
			if (attribute.sourcePath || attribute.sourceId) {
				const sourceKind = attribute.sourceKind?.toLowerCase() ?? "";
				const kind = sourceKind.includes("transcript")
					? "transcript"
					: sourceKind.includes("summary")
						? "summary"
						: "artifact";
				return isMemoryContentContextEligible(db, {
					agentId,
					sourceKind: kind,
					sourceId: attribute.sourcePath ?? attribute.sourceId ?? attribute.id,
					content: attribute.content,
				});
			}
			return scanMemoryContent(attribute.content).contextEligible;
		}),
	);
}

/**
 * The scope's evidence watermark (`dreaming_state.last_pass_at`): the
 * frontier the last pass actually surfaced. `search_evidence` anchors its
 * scan-first listing here (when the agent omits `since`) so the unprocessed
 * window is listed instead of pass-start (#1149). Missing on first run, an
 * old workspace, or a scope that never passed: returns null so the listing
 * falls back to unbounded.
 */
function readEvidenceWatermark(db: ReadDb, agentId: string): string | null {
	try {
		const row = db.prepare("SELECT last_pass_at AS lastPassAt FROM dreaming_state WHERE agent_id = ?").get(agentId) as
			| { lastPassAt: string | null }
			| undefined;
		return row?.lastPassAt ?? null;
	} catch {
		return null;
	}
}

function evidenceExcerptStart(content: string, query: string, maxChars: number): number {
	const terms = query
		.toLowerCase()
		.split(/\W+/)
		.filter((term) => term.length >= 3)
		.slice(0, 8);
	const lower = content.toLowerCase();
	for (const term of terms) {
		const match = lower.indexOf(term);
		if (match >= 0) return Math.max(0, match - Math.floor(maxChars * 0.35));
	}
	return 0;
}

function projectEvidenceItem(
	source: EpisodicSourceRecord,
	content: string,
	contentOffset: number,
	contentLength: number,
): Record<string, unknown> {
	return {
		sourceRef: `${source.kind}:${source.id}`,
		kind: source.kind,
		id: source.id,
		content,
		contentOffset,
		contentLength,
		contentTruncated: contentOffset > 0 || contentOffset + content.length < contentLength,
		contentHasPrevious: contentOffset > 0,
		contentHasNext: contentOffset + content.length < contentLength,
		completed: source.completed,
		sourceKind: source.sourceKind,
		sourceId: source.sourceId,
		sourcePath: source.sourcePath,
		sourceEntryId: source.sourceEntryId,
		project: source.project,
		harness: source.harness,
		capturedAt: source.capturedAt,
	};
}

function projectEvidence(sources: readonly EpisodicSourceRecord[], query: string): readonly Record<string, unknown>[] {
	let remaining = MAX_EVIDENCE_RESULT_CHARS;
	return sources.flatMap((source) => {
		const rendered = renderDreamingEvidence(source);
		if (rendered === MEMORY_CONTENT_WITHHELD_NOTICE) return [];
		const offset = evidenceExcerptStart(rendered, query, MAX_EVIDENCE_EXCERPT_CHARS);
		const excerptLength = Math.min(MAX_EVIDENCE_EXCERPT_CHARS, remaining, rendered.length - offset);
		const content = excerptLength > 0 ? rendered.slice(offset, offset + excerptLength) : "";
		remaining = Math.max(0, remaining - content.length);
		return [projectEvidenceItem(source, content, content.length > 0 ? offset : 0, rendered.length)];
	});
}

function projectEvidenceFragment(
	source: EpisodicSourceRecord,
	offset: number,
	chunkSize: number,
): Record<string, unknown> | null {
	const fragment = nextDreamingEvidenceFragment(source, offset, chunkSize);
	return fragment === null || fragment.content === MEMORY_CONTENT_WITHHELD_NOTICE
		? null
		: projectEvidenceItem(source, fragment.content, fragment.start, fragment.sourceLength);
}

function projectEntity(entity: Entity): Record<string, unknown> {
	return {
		id: entity.id,
		name: entity.name,
		canonicalName: entity.canonicalName,
		entityType: entity.entityType,
		agentId: entity.agentId,
		description: boundedText(entity.description, MAX_ENTITY_TEXT_CHARS),
		mentions: entity.mentions,
		pinned: entity.pinned,
		pinnedAt: entity.pinnedAt,
		status: entity.status,
		archivedAt: entity.archivedAt,
		archivedBy: entity.archivedBy,
		archiveReason: boundedText(entity.archiveReason ?? undefined, MAX_ENTITY_TEXT_CHARS),
		proposalId: entity.proposalId,
		proposalEvidenceCount: entity.proposalEvidence?.length ?? 0,
		createdAt: entity.createdAt,
		updatedAt: entity.updatedAt,
	};
}

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
	"list_contradictions",
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
	/** Write-path caps forwarded to applyDreamingOperations. */
	readonly writeCaps?: GraphWriteCaps;
	readonly onOperationsApplied?: (
		result: ApplyDreamingOperationsResult,
		operations: readonly DreamingOperationRequest[],
		agentId: string,
	) => void;
	readonly onOperationsAboutToApply?: (operations: readonly DreamingOperationRequest[], agentId: string) => void;
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
			"Fetch one entity in one agent scope with attribute/constraint counts and pinned status, optionally hydrated with bounded aspect summaries and/or dependency links. Use limit and offset to page hydrated items; the response reports when a hydration list is truncated.",
			true,
			z.object({
				agentId: z.string().min(1),
				entityId: z.string().min(1),
				include: z.array(z.enum(["aspects", "links"])).optional(),
				direction: z.enum(["incoming", "outgoing", "both"]).optional(),
				limit: z.number().finite().optional(),
				offset: z.number().finite().optional(),
			}),
			async ({ agentId: scopeId, entityId, include, direction, limit, offset }) => {
				const detail = getKnowledgeEntityDetail(accessor, entityId, scopeId);
				if (!detail) return { ok: false, error: "Entity not found" };
				const hydrationLimit = bounded(limit, 50, MAX_HYDRATED_ITEMS);
				const hydrationOffset = Math.max(0, Math.floor(offset ?? 0));
				const result: MutableCapabilityOutput = {
					ok: true,
					entity: projectEntity(detail.entity),
					pinned: detail.entity.pinned === true,
					aspectCount: detail.aspectCount,
					attributeCount: detail.attributeCount,
					constraintCount: detail.constraintCount,
					dependencyCount: detail.dependencyCount,
				};
				if (include?.includes("aspects")) {
					const aspects = getEntityAspectsWithCounts(accessor, entityId, scopeId);
					const hydratedAspects = aspects.slice(hydrationOffset, hydrationOffset + hydrationLimit).map((aspect) => ({
						id: aspect.aspect.id,
						name: boundedText(aspect.aspect.name, MAX_ENTITY_TEXT_CHARS),
						attributeCount: aspect.attributeCount,
						constraintCount: aspect.constraintCount,
					}));
					result.aspects = hydratedAspects;
					result.aspectsOffset = hydrationOffset;
					result.aspectsTruncated = hydrationOffset + hydratedAspects.length < aspects.length;
				}
				if (include?.includes("links")) {
					const links = getEntityDependenciesDetailed(accessor, {
						entityId,
						agentId: scopeId,
						direction: direction ?? "both",
					});
					const hydratedLinks = links.slice(hydrationOffset, hydrationOffset + hydrationLimit).map((link) => ({
						...link,
						reason: boundedText(link.reason ?? undefined, MAX_ENTITY_TEXT_CHARS) ?? null,
					}));
					result.links = hydratedLinks;
					result.linksOffset = hydrationOffset;
					result.linksTruncated = hydrationOffset + hydratedLinks.length < links.length;
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
				items: filterDreamingAttributes(
					accessor,
					scopeId,
					getAttributesForAspectFiltered(accessor, {
						entityId,
						aspectId,
						agentId: scopeId,
						kind: "attribute",
						status: "active",
						limit: bounded(limit, 50, 200),
						offset: Math.max(0, Math.floor(offset ?? 0)),
					}),
				),
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
					const result = getOntologyClaimEvidence(accessor, {
						agentId: scopeId,
						entity: entityName,
						aspect: aspectName,
						group: ref.group,
						claim: ref.claim,
						limit,
						offset,
					});
					const safeIds = new Set(
						filterDreamingAttributes(
							accessor,
							scopeId,
							result.items.map((item) => item.attribute),
						).map((attribute) => attribute.id),
					);
					const items = result.items.filter((item) => safeIds.has(item.attribute.id));
					return { ok: true, result: { ...result, items, count: items.length } };
				}
				return { ok: true, result: getOntologyLinkEvidence(accessor, { agentId: scopeId, id: ref.id }) };
			},
		),
		capability(
			"search_evidence",
			"Search episodic evidence",
			"Full-text search immutable episodic memories, artifacts, and transcripts in one agent scope. Historical summary records can be requested explicitly with kind=summary, but are not part of the default Dreaming delivery path. Results contain exact bounded excerpts of the rendered evidence with contentOffset/contentLength; use sourceRef for citations, which are validated against the complete canonical source. Each record carries completed: memory, artifact, and summary records are settled captures (true); a transcript is true only after the session-end machinery writes its completion marker, and false while the session is still running — do not file claims from a still-growing transcript, since its states may be contradicted by the session's end. If contentTruncated is true, page exact fragments with the same sourceRef and chunkSize: start at offset=0 when contentHasPrevious is true, then use offset=contentOffset+content.length from the fragment just returned until contentHasNext is false. Omit the query AND since to list the unprocessed window: the listing starts at the scope's evidence watermark (the last pass's surfaced frontier), so the newest unseen sources come first. Narrow with a query if the list is large; pass an explicit earlier since only when you need older history. Artifacts are deduped by content hash: content-identical files across vault paths collapse to one canonical entry.",
			true,
			z.object({
				agentId: z.string().min(1),
				query: z.string().optional(),
				since: z.string().optional(),
				before: z.string().optional(),
				kind: z.enum(["memory", "artifact", "transcript", "summary"]).optional(),
				limit: z.number().finite().optional(),
				sourceRef: z.string().min(1).optional(),
				offset: z.number().finite().optional(),
				chunkSize: z.number().finite().optional(),
			}),
			async ({ agentId: scopeId, query, since, before, kind, limit, sourceRef, offset, chunkSize }) =>
				accessor.withReadDb((db) => {
					if (sourceRef !== undefined) {
						const source = readEpisodicSource(db, { agentId: scopeId, from: sourceRef });
						if (source === null) return { ok: false, error: "Evidence source not found" };
						if (source.kind === "transcript" && !source.completed) {
							return { ok: false, error: "Transcript is still in progress" };
						}
						const fragment = projectEvidenceFragment(
							source,
							Math.max(0, Math.floor(offset ?? 0)),
							Math.min(Math.max(Math.floor(chunkSize ?? MAX_EVIDENCE_EXCERPT_CHARS), 1), MAX_EVIDENCE_EXCERPT_CHARS),
						);
						return fragment === null
							? { ok: false, error: "Evidence fragment offset is outside the source" }
							: { ok: true, items: [fragment] };
					}
					// The scan-first listing omits `since`; anchor it to the
					// scope's evidence watermark instead of pass-start so the
					// unprocessed window [last surfaced frontier -> now] is
					// listed, never the fresh minutes after pass start only
					// (#1149).
					const effectiveSince = since ?? readEvidenceWatermark(db, scopeId);
					const sources = searchEpisodicSources(db, {
						agentId: scopeId,
						query: query ?? "",
						since: effectiveSince ?? undefined,
						before,
						kind,
						limit,
					});
					return { ok: true, items: projectEvidence(sources, query ?? "") };
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
					result.contradiction = filterDreamingAttributes(
						accessor,
						scopeId,
						getAttributesForAspectFiltered(accessor, {
							entityId,
							aspectId,
							agentId: scopeId,
							kind: "attribute",
							status: "active",
							limit: 200,
							offset: 0,
						}),
					).map((attribute) => ({
						attributeId: attribute.id,
						content: attribute.content,
						...detectProspectiveContradictionRisk(value, attribute.content),
					}));
				}
				return result;
			},
		),
		capability(
			"list_contradictions",
			"List contradiction observations",
			"Read persisted, agent-scoped contradiction observations alongside competing claim evidence. Contradictions are advisory state, not a truth choice; use governed ontology operations for any correction.",
			true,
			z.object({
				agentId: z.string().min(1),
				entityId: z.string().min(1).optional(),
				aspectId: z.string().min(1).optional(),
				groupKey: z.string().min(1).optional(),
				claimKey: z.string().min(1).optional(),
				sourceId: z.string().min(1).optional(),
				status: z.enum(["active", "resolved", "all"]).optional(),
				...pagination,
			}),
			async ({ agentId: scopeId, entityId, aspectId, groupKey, claimKey, sourceId, status, limit, offset }) => ({
				ok: true,
				...listOntologyContradictions(accessor, {
					agentId: scopeId,
					entityId,
					aspectId,
					groupKey,
					claimKey,
					sourceId,
					status,
					limit,
					offset,
				}),
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
			"attention_list",
			"List attention",
			"List attention records by kind and resolution status. Use kind hygiene for structural queue work, kind surprisal for bounded exploration hints, or review_due for expired and approaching temporal claims. Omit agentId to see the whole install; pass agentId to narrow to one scope.",
			true,
			z.object({
				agentId: z.string().optional(),
				kind: z.string().optional(),
				status: z.enum(["pending", "resolved"]).optional(),
				limit: z.number().finite().optional(),
			}),
			async ({ agentId: scopeId, kind, status, limit }) => {
				if (kind === "review_due") {
					if (status === "resolved") return { ok: true, items: [] };
					const due = accessor.withReadDb((db) =>
						collectReviewDueClaims(
							{ all: <T>(sql: string, ...params: unknown[]) => db.prepare(sql).all(...params) as T[] },
							new Date(),
							{ agentId: scopeId, limit: bounded(limit, scopeId ? 50 : 100, scopeId ? 100 : 200) },
						),
					);
					return {
						ok: true,
						items: [
							...due.expired.map((item) => ({
								id: item.id,
								kind: "review_due",
								status: "pending",
								subjectRef: `memory:${item.id}`,
								details: { phase: "expired", ...item },
								priority: "high",
								createdAt: item.createdAt,
								agentId: item.agentId,
							})),
							...due.approaching.map((item) => ({
								id: item.id,
								kind: "review_due",
								status: "pending",
								subjectRef: `memory:${item.id}`,
								details: { phase: "approaching", ...item },
								priority: "normal",
								createdAt: item.createdAt,
								agentId: item.agentId,
							})),
						],
					};
				}
				return {
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
				};
			},
		),
		capability(
			"apply_ontology_ops",
			"Apply ontology operations",
			'Apply every semantic write through the daemon audit seam in one batch, in one agent scope (pass the agentId whose graph you are maintaining — hygiene attention records belong to the agent that flagged them). Ops are processed in array order. Hygiene ops (flag, archive_*, merge_entities) cite provenance: "attention:$<index>" for a flag earlier in the same batch, or "attention:<uuid>" from a prior batch. decline_attention closes a pending attention record you inspected and judged to keep. Content-bearing ops cite evidence with exact quotes from canonical episodic evidence in that scope.',
			false,
			z.object({
				agentId: z.string().min(1),
				operations: z.array(DREAMING_ONTOLOGY_OPERATION_SCHEMA).min(1).max(100),
			}),
			async ({ agentId: scopeId, operations }) => {
				params.onOperationsAboutToApply?.(operations, scopeId);
				const result = applyDreamingOperations({
					accessor,
					agentId: scopeId,
					actor,
					operations,
					passId: params.passId,
					writeCaps: params.writeCaps,
				});
				params.onOperationsApplied?.(result, operations, scopeId);
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
