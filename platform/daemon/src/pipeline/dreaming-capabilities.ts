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
import { getDbOwnerForAccessor, runDbOwnerDomainOperation } from "../db-owner-runtime";
import { ownerReadAll, ownerReadOne } from "../db-owner-sql";
import type {
	DbOwnerDreamingEvidenceSearch,
	DbOwnerDreamingEvidenceSource,
	DbOwnerDreamingReviewDue,
} from "../db-owner-protocol";
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

import { getOntologyClaimEvidence } from "../ontology-claim-evidence";
import { listOntologyContradictions } from "../ontology-contradictions";
import { getOntologyLinkEvidence } from "../ontology-link-evidence";
import { type GraphWriteCaps, findDuplicateEntityMerges } from "../ontology-proposals";
import { detectProspectiveContradictionRisk } from "./antonyms";
import { getDreamingAttentionAcrossScopes, getDreamingAttentionScoped } from "./dreaming-attention";
import { nextDreamingEvidenceFragment, renderDreamingEvidence } from "./dreaming-evidence";
import { deliveredOffsetForSource, pendingDreamingEvidenceContinuations } from "./dreaming-evidence-consumption";
import { DREAMING_ONTOLOGY_OPERATION_SCHEMA } from "./dreaming-operation-contract";
import {
	type ApplyDreamingOperationsResult,
	DREAMING_MAX_OPERATIONS_PER_REQUEST,
	type DreamingOperationRequest,
	applyDreamingOperations,
} from "./dreaming-operations";
import { readDreamingRunbook, writeDreamingRunbook } from "./dreaming-runbook";
import { collectReviewDueClaims } from "./memory-review-due";
import { commitCuratedMemoryHead, readCuratedMemoryHead } from "../memory-head-curation";
import { curateMemoryHead } from "../memory-head";

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

async function filterDreamingAttributes(
	accessor: DbAccessor,
	agentId: string,
	attributes: readonly EntityAttribute[],
): Promise<readonly EntityAttribute[]> {
	const owner = await getDbOwnerForAccessor(accessor);
	const table = await ownerReadOne<{ readonly present: number }>(
		owner,
		"SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'memory_content_safety' LIMIT 1",
		[],
		{
			operation: "dreaming.capabilities.safety-schema",
			workloadClass: "foreground",
			estimatedWorkUnits: 1,
			deadlineMs: 5_000,
		},
	);
	if (table === null) return attributes.filter((attribute) => scanMemoryContent(attribute.content).contextEligible);
	const refs = attributes.flatMap((attribute) => {
		if (attribute.memoryId) return [{ kind: "memory", id: attribute.memoryId }];
		if (attribute.sourcePath || attribute.sourceId) {
			const sourceKind = attribute.sourceKind?.toLowerCase() ?? "";
			const kind = sourceKind.includes("transcript")
				? "transcript"
				: sourceKind.includes("summary")
					? "summary"
					: "artifact";
			return [{ kind, id: attribute.sourcePath ?? attribute.sourceId ?? attribute.id }];
		}
		return [];
	});
	const predicates = refs.map(() => "(source_kind = ? AND source_id = ?)").join(" OR ");
	const safetyRows =
		predicates.length === 0
			? []
			: await ownerReadAll<{
					readonly source_kind: string;
					readonly source_id: string;
					readonly status: string;
					readonly context_eligible: number;
				}>(
					owner,
					`SELECT source_kind, source_id, status, context_eligible
					 FROM memory_content_safety
					 WHERE agent_id = ? AND (${predicates})`,
					[agentId, ...refs.flatMap((ref) => [ref.kind, ref.id])],
					{
						operation: "dreaming.capabilities.safety-read",
						workloadClass: "foreground",
						estimatedWorkUnits: Math.min(200, refs.length),
						deadlineMs: 5_000,
					},
				);
	const safety = new Map(safetyRows.map((row) => [`${row.source_kind}:${row.source_id}`, row]));
	return attributes.filter((attribute) => {
		if (!scanMemoryContent(attribute.content).contextEligible) return false;
		const ref = attribute.memoryId
			? { kind: "memory", id: attribute.memoryId }
			: attribute.sourcePath || attribute.sourceId
				? {
						kind: (attribute.sourceKind?.toLowerCase().includes("transcript")
							? "transcript"
							: attribute.sourceKind?.toLowerCase().includes("summary")
								? "summary"
								: "artifact") as string,
						id: attribute.sourcePath ?? attribute.sourceId ?? attribute.id,
					}
				: null;
		if (ref === null) return true;
		const row = safety.get(`${ref.kind}:${ref.id}`);
		return row === undefined || (row.status === "clean" && row.context_eligible === 1);
	});
}

/**
 * The scope's evidence watermark (`dreaming_state.last_pass_at`): the
 * frontier the last pass actually surfaced. It limits historical searches
 * that omit `since`; scan-first delivery deliberately ignores it and drains
 * source revisions from their durable delivered offsets (#1430). Missing on
 * first run, an old workspace, or a scope that never passed: returns null so
 * historical searches fall back to unbounded.
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
		sourceRevision: source.sourceRevision ?? source.capturedAt,
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
	"memory_head_read",
	"memory_head_commit",
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
	"curate_memory_head",
] as const;

export type DreamingCapabilityId = (typeof DREAMING_CAPABILITY_IDS)[number];
export type DreamingCapabilityMode = "incremental" | "compact" | "incremental-hygiene" | "incremental-content";

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
	/** Focus mode gates content-only capabilities structurally. */
	readonly mode?: DreamingCapabilityMode;
	/** Write-path caps forwarded to applyDreamingOperations. */
	readonly writeCaps?: GraphWriteCaps;
	readonly onOperationsApplied?: (
		result: ApplyDreamingOperationsResult,
		operations: readonly DreamingOperationRequest[],
		agentId: string,
	) => void | PromiseLike<void>;
	readonly onOperationsAboutToApply?: (
		operations: readonly DreamingOperationRequest[],
		agentId: string,
	) => void | PromiseLike<void>;
	readonly onToolCall?: (trace: DreamingToolCallTrace) => void | PromiseLike<void>;
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
export function searchDreamingEvidenceInDb(db: ReadDb, input: DbOwnerDreamingEvidenceSearch): DreamingCapabilityOutput {
	const scopeId = input.agentId;
	if (input.sourceRef !== undefined) {
		const source = readEpisodicSource(db, { agentId: scopeId, from: input.sourceRef });
		if (source === null) return { ok: false, error: "Evidence source not found" };
		if (source.kind === "transcript" && !source.completed)
			return { ok: false, error: "Transcript is still in progress" };
		const fragment = projectEvidenceFragment(
			source,
			Math.max(0, Math.floor(input.offset ?? 0)),
			Math.min(Math.max(Math.floor(input.chunkSize ?? MAX_EVIDENCE_EXCERPT_CHARS), 1), MAX_EVIDENCE_EXCERPT_CHARS),
		);
		return fragment === null
			? { ok: false, error: "Evidence fragment offset is outside the source" }
			: { ok: true, items: [fragment] };
	}
	const scanFirst = input.query === undefined && input.since === undefined && input.before === undefined;
	const watermark = (() => {
		if (scanFirst) return undefined;
		return readEvidenceWatermark(db, scopeId) ?? undefined;
	})();
	const continuations = scanFirst
		? pendingDreamingEvidenceContinuations(db, scopeId, input.limit ?? 20, input.kind)
		: [];
	const sources =
		continuations.length > 0
			? continuations
			: searchEpisodicSources(db, {
					agentId: scopeId,
					query: input.query ?? "",
					since: input.since ?? watermark,
					before: input.before,
					kind: input.kind,
					excludeDelivered: scanFirst,
					limit: input.limit,
				});
	const items = scanFirst
		? sources.flatMap((source) => {
				const fragment = projectEvidenceFragment(
					source,
					deliveredOffsetForSource(db, scopeId, source),
					MAX_EVIDENCE_EXCERPT_CHARS,
				);
				return fragment === null ? [] : [fragment];
			})
		: projectEvidence(sources, input.query ?? "");
	return { ok: true, items };
}

export function readDreamingEvidenceSourceInDb(
	db: ReadDb,
	input: DbOwnerDreamingEvidenceSource,
): EpisodicSourceRecord | null {
	return readEpisodicSource(db, { agentId: input.agentId, from: input.sourceRef });
}

export function collectDreamingReviewDueInDb(
	db: ReadDb,
	input: DbOwnerDreamingReviewDue,
): ReturnType<typeof collectReviewDueClaims> {
	return collectReviewDueClaims(
		{ all: <T>(sql: string, ...params: unknown[]) => db.prepare(sql).all(...params) as T[] },
		new Date(input.nowMs),
		{ agentId: input.agentId, limit: input.limit },
	);
}

export function createDreamingCapabilities(params: CreateDreamingCapabilitiesParams): readonly DreamingCapability[] {
	const { accessor, agentId, actor } = params;
	return [
		capability(
			"memory_head_read",
			"Read curated memory head",
			"Read the scoped Dreaming-curated MEMORY.md head.",
			true,
			z.object({ agentId: z.string().min(1) }),
			async ({ agentId: scopeId }) =>
				scopeId === agentId
					? { ok: true, head: await readCuratedMemoryHead(scopeId) }
					: { ok: false, error: "Head scope must match the active agent" },
		),
		capability(
			"memory_head_commit",
			"Commit curated memory head",
			"Commit a bounded, evidence-backed MEMORY.md head from a running content pass.",
			false,
			z.object({
				agentId: z.string().min(1),
				passId: z.string().min(1),
				baseRevision: z.number().int().nonnegative(),
				baseHash: z.string(),
				entries: z.array(
					z.object({
						entryId: z.string().min(1),
						text: z.string().min(1),
						support: z.array(z.object({ source_ref: z.string().min(1), quote: z.string().min(1) })).min(1),
					}),
				),
			}),
			async (input) =>
				input.agentId === agentId && input.passId === params.passId
					? commitCuratedMemoryHead(input)
					: { ok: false, code: "PASS_NOT_AUTHORIZED", error: "Head commit requires the active scoped Dreaming pass" },
		),
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
				items: (
					await listKnowledgeEntities(accessor, {
						agentId: scopeId,
						query,
						type,
						limit: bounded(limit, 20, 100),
						offset: Math.max(0, Math.floor(offset ?? 0)),
					})
				).map((item) => ({
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
				const detail = await getKnowledgeEntityDetail(accessor, entityId, scopeId);
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
					const aspects = await getEntityAspectsWithCounts(accessor, entityId, scopeId);
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
					const links = await getEntityDependenciesDetailed(accessor, {
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
				items: await filterDreamingAttributes(
					accessor,
					scopeId,
					await getAttributesForAspectFiltered(accessor, {
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
				items: await getEntityDependenciesDetailed(accessor, {
					entityId,
					agentId: scopeId,
					direction: direction ?? "both",
				}),
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
					const detail = await getKnowledgeEntityDetail(accessor, ref.entity, scopeId);
					if (detail) {
						entityName = detail.entity.name;
						const aspect = (await getEntityAspectsWithCounts(accessor, ref.entity, scopeId)).find(
							(candidate) => candidate.aspect.id === ref.aspect || candidate.aspect.name === ref.aspect,
						);
						if (aspect) aspectName = aspect.aspect.name;
					}
					const result = await getOntologyClaimEvidence(accessor, {
						agentId: scopeId,
						entity: entityName,
						aspect: aspectName,
						group: ref.group,
						claim: ref.claim,
						limit,
						offset,
					});
					const safeIds = new Set(
						(
							await filterDreamingAttributes(
								accessor,
								scopeId,
								result.items.map((item) => item.attribute),
							)
						).map((attribute) => attribute.id),
					);
					const items = result.items.filter((item) => safeIds.has(item.attribute.id));
					return { ok: true, result: { ...result, items, count: items.length } };
				}
				return { ok: true, result: await getOntologyLinkEvidence(accessor, { agentId: scopeId, id: ref.id }) };
			},
		),
		capability(
			"search_evidence",
			"Search episodic evidence",
			"Full-text search immutable episodic memories, artifacts, and transcripts in one agent scope. Historical summary records can be requested explicitly with kind=summary, but are not part of the default Dreaming delivery path. Results contain exact bounded excerpts of the rendered evidence with contentOffset/contentLength; use sourceRef for citations, which are validated against the complete canonical source. Each record carries completed: memory, artifact, and summary records are settled captures (true); a transcript is true only after the session-end machinery writes its completion marker, and false while the session is still running — do not file claims from a still-growing transcript, since its states may be contradicted by the session's end. If contentTruncated is true, page exact fragments with the same sourceRef and chunkSize: start at offset=0 when contentHasPrevious is true, then use offset=contentOffset+content.length from the fragment just returned until contentHasNext is false. Omit query, since, and before to drain the durable delivery queue: it lists every incomplete source revision and resumes at its delivered offset, regardless of time watermark. Narrow with a query if the list is large; pass an explicit earlier since only when you need older history. Artifacts are deduped by content hash: content-identical files across vault paths collapse to one canonical entry.",
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
			async ({ agentId: scopeId, query, since, before, kind, limit, sourceRef, offset, chunkSize }) => {
				const input: DbOwnerDreamingEvidenceSearch = {
					agentId: scopeId,
					...(query === undefined ? {} : { query }),
					...(since === undefined ? {} : { since }),
					...(before === undefined ? {} : { before }),
					...(kind === undefined ? {} : { kind }),
					...(limit === undefined ? {} : { limit }),
					...(sourceRef === undefined ? {} : { sourceRef }),
					...(offset === undefined ? {} : { offset }),
					...(chunkSize === undefined ? {} : { chunkSize }),
				};
				return await runDbOwnerDomainOperation(accessor, {
					runWithOwner: async (owner) => {
						const handle = owner.submit<DreamingCapabilityOutput>(
							{
								kind: "dreaming_evidence_search",
								input,
							},
							{
								operation: "dreaming.capabilities.search-evidence",
								lane: "read",
								workloadClass: "foreground",
								deadlineMs: 30_000,
								estimatedWorkUnits: 200,
							},
						);
						return await handle.result;
					},
					runInline: ({ read }) => read((db) => searchDreamingEvidenceInDb(db, input)),
				});
			},
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
					result.duplicates = await findDuplicateEntityMerges(accessor, { agentId: scopeId, name });
				}
				if (entityId !== undefined && aspectId !== undefined && value !== undefined) {
					result.contradiction = (
						await filterDreamingAttributes(
							accessor,
							scopeId,
							await getAttributesForAspectFiltered(accessor, {
								entityId,
								aspectId,
								agentId: scopeId,
								kind: "attribute",
								status: "active",
								limit: 200,
								offset: 0,
							}),
						)
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
			"Before finishing a Dreaming pass, store one short structured note for future passes to review. Deferred evidence in another scope must include its agentId. Reviewed exclusions must include the agentId of the scope that owns the sourceRef. Use reviewedExcludedEvidence only after inspecting an entire source revision and deciding it contains no durable fact; temporary blockers belong in deferredEvidence.",
			false,
			z.object({
				summary: z.string().trim().min(1).max(2_000),
				openQuestions: z.array(z.string().trim().min(1).max(500)).max(20).default([]),
				deferred: z.array(z.string().trim().min(1).max(500)).max(20).default([]),
				deferredEvidence: z
					.array(
						z.union([
							z.string().regex(/^(memory|artifact|transcript|summary):.+$/),
							z.object({
								agentId: z.string().trim().min(1),
								sourceRef: z.string().regex(/^(memory|artifact|transcript|summary):.+$/),
							}),
						]),
					)
					.max(20)
					.default([]),
				reviewedExcludedEvidence: z
					.array(
						z.object({
							agentId: z.string().trim().min(1),
							sourceRef: z.string().regex(/^(memory|artifact|transcript|summary):.+$/),
							reason: z.string().trim().min(1).max(500),
						}),
					)
					.max(20)
					.default([]),
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
					const input: DbOwnerDreamingReviewDue = {
						agentId: scopeId,
						nowMs: Date.now(),
						limit: bounded(limit, scopeId ? 50 : 100, scopeId ? 100 : 200),
					};
					const due = await runDbOwnerDomainOperation(accessor, {
						runWithOwner: async (owner) => {
							const handle = owner.submit<ReturnType<typeof collectReviewDueClaims>>(
								{
									kind: "dreaming_review_due",
									input,
								},
								{
									operation: "dreaming.capabilities.review-due",
									lane: "read",
									workloadClass: "foreground",
									deadlineMs: 30_000,
									estimatedWorkUnits: 100,
								},
							);
							return await handle.result;
						},
						runInline: ({ read }) => read((db) => collectDreamingReviewDueInDb(db, input)),
					});
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
			'Apply every semantic write through the daemon audit seam in one ordered request, in one agent scope (pass the agentId whose graph you are maintaining — hygiene attention records belong to the agent that flagged them). The daemon validates every input, citation, and resolvable target before creating flags or applying bounded, yielding writer transactions; each operation and its provenance resolution remains atomic, while an individual operation failure does not block later operations. If a writer transaction fails after earlier transactions committed, the result has `retryable: true` and `retryFrom`; retry only the uncommitted suffix. Do not replay returned items, and replace any earlier `attention:$<index>` references with `attention:<uuid>` built from the flag result `result.attentionId` before retrying. Hygiene ops (flag, archive_*, merge_entities) cite provenance: "attention:$<index>" for a flag earlier in the request, or "attention:<uuid>" from a prior request. decline_attention closes a pending attention record you inspected and judged to keep. Content-bearing ops cite evidence with exact quotes from canonical episodic evidence in that scope.',
			false,
			z.object({
				agentId: z.string().min(1),
				operations: z.array(DREAMING_ONTOLOGY_OPERATION_SCHEMA).min(1).max(DREAMING_MAX_OPERATIONS_PER_REQUEST),
			}),
			async ({ agentId: scopeId, operations }) => {
				await params.onOperationsAboutToApply?.(operations, scopeId);
				const result = await applyDreamingOperations({
					accessor,
					agentId: scopeId,
					actor,
					operations,
					passId: params.passId,
					writeCaps: params.writeCaps,
				});
				await params.onOperationsApplied?.(result, operations, scopeId);
				return {
					ok: result.ok,
					...(result.error ? { error: result.error } : {}),
					...(result.retryable === true ? { retryable: true } : {}),
					...(result.retryFrom !== undefined ? { retryFrom: result.retryFrom } : {}),
					items: result.items,
				};
			},
		),
		...(params.mode !== "incremental-content"
			? []
			: [
					capability(
						"curate_memory_head",
						"Curate MEMORY.md head",
						"Content-pass-only audited MEMORY.md curation; hygiene passes cannot invoke this capability.",
						false,
						z.object({
							passId: z.string().min(1),
							agentId: z.string().min(1),
							baseRevision: z.number().int().nonnegative(),
							baseHash: z.union([z.literal(""), z.string().length(64)]),
							content: z.string().trim().min(1),
							entries: z
								.array(
									z.object({
										id: z.string().trim().min(1),
										text: z.string().trim().min(1),
										operation: z.enum(["added", "updated", "removed", "deferred", "no-op"]),
										sourceRefs: z.array(z.string()),
										supportingQuotes: z.array(z.string()),
									}),
								)
								.max(200),
						}),
						async (input) => {
							if (!params.passId || input.passId !== params.passId || input.agentId !== agentId)
								return { ok: false, error: "Head curation requires the active Dreaming pass" };
							return await curateMemoryHead(input);
						},
					),
				]),
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
		mode: "incremental-content",
	}).map((capability) => ({
		id: capability.id,
		title: capability.title,
		description: capability.description,
		readOnly: capability.readOnly,
		inputSchema: z.toJSONSchema(capability.inputSchema) as Record<string, unknown>,
	}));
}
