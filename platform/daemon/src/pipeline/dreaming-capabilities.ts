import { type Entity, redactCredentialsDeep } from "@signet/core";
import { z } from "zod";
import { runDbOwnerDomainOperation } from "../db-owner-runtime";
import type {
	DbOwnerDreamingEvidenceSearch,
	DbOwnerDreamingEvidenceSource,
	DbOwnerDreamingReviewDue,
} from "../db-owner-protocol";
import type { DbAccessor, ReadDb } from "../db-accessor";
import { classifyEntityQuality } from "../entity-quality";
import type { EpisodicSourceRecord } from "../episodic-sources";
import { episodicQueryTerms, foldAsciiCase, readEpisodicSource, searchEpisodicSources } from "../episodic-sources";
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
import {
	deliveredOffsetForSource,
	extendDeliveredOffset,
	passDeliveredRanges,
	passFullyServedSourceRefs,
	pendingDreamingEvidenceContinuations,
} from "./dreaming-evidence-consumption";
import { DREAMING_ONTOLOGY_OPERATION_SCHEMA } from "./dreaming-operation-contract";
import {
	type ApplyDreamingOperationsResult,
	DREAMING_MAX_OPERATIONS_PER_REQUEST,
	type DreamingOperationRequest,
	applyDreamingOperations,
} from "./dreaming-operations";
import { dreamingScopeKey, zoomDreamingHistory } from "./dreaming-history";
import { writeDreamingRunbook } from "./dreaming-runbook";
import { collectReviewDueClaims } from "./memory-review-due";
import { readCuratedMemoryHead, type MemoryHeadCommitter } from "../memory-head";

const bounded = (value: number | undefined, fallback: number, max: number): number =>
	Math.min(Math.max(Math.floor(value ?? fallback), 1), max);

const MAX_EVIDENCE_EXCERPT_CHARS = 2_000;
const MAX_EVIDENCE_RESULT_CHARS = 16_000;
const MAX_EVIDENCE_PAGE_CHARS = 250_000;

export function dreamingEvidencePageChars(maxInputTokens: number): number {
	return evidencePageChars(Math.floor(maxInputTokens / 4));
}

function evidencePageChars(requested: number | undefined): number {
	const chars = Number.isFinite(requested) ? Math.floor(requested ?? 0) : 0;
	return Math.min(MAX_EVIDENCE_PAGE_CHARS, Math.max(MAX_EVIDENCE_RESULT_CHARS, chars));
}
const MAX_HYDRATED_ITEMS = 50;
const MAX_ENTITY_TEXT_CHARS = 2_000;

function boundedText(value: string | undefined, maxChars: number): string | undefined {
	if (value === undefined || value.length <= maxChars) return value;
	return value.slice(0, maxChars);
}

function evidenceExcerptStart(content: string, query: string, maxChars: number): number {
	const folded = foldAsciiCase(content);
	for (const term of episodicQueryTerms(query)) {
		const match = folded.indexOf(foldAsciiCase(term));
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
	return sources.map((source) => {
		const rendered = renderDreamingEvidence(source);
		const offset = evidenceExcerptStart(rendered, query, MAX_EVIDENCE_EXCERPT_CHARS);
		const excerptLength = Math.min(MAX_EVIDENCE_EXCERPT_CHARS, remaining, rendered.length - offset);
		const content = excerptLength > 0 ? rendered.slice(offset, offset + excerptLength) : "";
		remaining = Math.max(0, remaining - content.length);
		return projectEvidenceItem(source, content, content.length > 0 ? offset : 0, rendered.length);
	});
}

function projectEvidenceFragment(
	source: EpisodicSourceRecord,
	offset: number,
	chunkSize: number,
): Record<string, unknown> | null {
	const fragment = nextDreamingEvidenceFragment(source, offset, chunkSize);
	return fragment === null
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
	"search_evidence",
	"validate_proposal",
	"zoom_history",
	"runbook_write",
	"attention_list",
	"apply_ontology_ops",
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
	readonly allowedScopes?: readonly string[];
	readonly actor: string;
	readonly memoryHeadCommitter?: MemoryHeadCommitter;
	readonly passId?: string;
	readonly evidenceDeliveryDeadline?: number;
	readonly evidenceChars?: number;
	readonly mode?: DreamingCapabilityMode;
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
				return { tool: id, ...redactCredentialsDeep(output) };
			} catch (error) {
				return { tool: id, ok: false, error: error instanceof Error ? error.message : String(error) };
			}
		},
	};
}
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
			Math.min(
				Math.max(Math.floor(input.chunkSize ?? MAX_EVIDENCE_EXCERPT_CHARS), 1),
				evidencePageChars(input.evidenceChars),
			),
		);
		return fragment === null
			? { ok: false, error: "Evidence fragment offset is outside the source" }
			: { ok: true, items: [fragment] };
	}
	const query = input.query?.trim() || undefined;
	if (query === undefined && input.since === undefined && input.before === undefined) {
		return drainDreamingEvidenceQueueInDb(db, input);
	}
	const sources = searchEpisodicSources(db, {
		agentId: scopeId,
		query: query ?? "",
		since: input.since,
		before: input.before,
		kind: input.kind,
		limit: input.limit,
	});
	return { ok: true, items: projectEvidence(sources, query ?? "") };
}

const DELIVERY_QUEUE_SCAN_LIMIT = 51;

function drainDreamingEvidenceQueueInDb(db: ReadDb, input: DbOwnerDreamingEvidenceSearch): DreamingCapabilityOutput {
	const scopeId = input.agentId;
	const limit = Math.max(1, Math.min(Math.floor(input.limit ?? 20), 50));
	const servedInPass = input.passId ? passDeliveredRanges(db, input.passId, scopeId) : new Map();
	const pageChars = evidencePageChars(input.evidenceChars);
	let budgetExhausted = false;
	const fresh = searchEpisodicSources(db, {
		agentId: scopeId,
		query: "",
		kind: input.kind,
		excludeDelivered: true,
		excludeSourceRefs: input.passId ? passFullyServedSourceRefs(db, input.passId, scopeId) : [],
		limit: DELIVERY_QUEUE_SCAN_LIMIT,
	});
	const page = (sources: readonly EpisodicSourceRecord[], max: number, skip = new Set<string>()) => {
		const items: Record<string, unknown>[] = [];
		let remaining = pageChars;
		for (const source of sources) {
			const ref = `${source.kind}:${source.id}`;
			if (skip.has(ref)) continue;
			if (items.length > 0 && remaining < MAX_EVIDENCE_EXCERPT_CHARS) {
				budgetExhausted = true;
				break;
			}
			skip.add(ref);
			const offset = extendDeliveredOffset(deliveredOffsetForSource(db, scopeId, source), servedInPass.get(ref));
			const fragment = projectEvidenceFragment(source, offset, Math.max(remaining, MAX_EVIDENCE_EXCERPT_CHARS));
			if (fragment !== null) {
				items.push(fragment);
				remaining -= typeof fragment.content === "string" ? fragment.content.length : 0;
			}
			if (items.length >= max) break;
		}
		return items;
	};
	const continuationRefs = new Set<string>();
	const continuations = page(
		pendingDreamingEvidenceContinuations(db, scopeId, 50, input.kind),
		limit + 1,
		continuationRefs,
	);
	if (continuations.length > 0) {
		const returned = continuations.slice(0, limit);
		return {
			ok: true,
			items: returned,
			hasMore:
				continuations.length > limit ||
				budgetExhausted ||
				returned.some((item) => item.contentHasNext === true) ||
				page(fresh, 1, continuationRefs).length > 0,
		};
	}
	const items = page(fresh, limit + 1);
	const returned = items.slice(0, limit);
	return {
		ok: true,
		items: returned,
		hasMore:
			items.length > limit ||
			budgetExhausted ||
			returned.some((item) => item.contentHasNext === true) ||
			(items.length > 0 && fresh.length >= DELIVERY_QUEUE_SCAN_LIMIT),
	};
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

export async function listDreamingAttention(
	accessor: DbAccessor,
	params: {
		readonly agentId?: string;
		readonly kind?: string;
		readonly status?: "pending" | "resolved";
		readonly limit?: number;
	},
): Promise<readonly unknown[]> {
	const { agentId: scopeId, kind, status, limit } = params;
	if (kind === "review_due") {
		if (status === "resolved") return [];
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
		return [
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
		];
	}
	return scopeId !== undefined
		? await getDreamingAttentionScoped(accessor, scopeId, {
				kind,
				status: status ?? "pending",
				limit: bounded(limit, 20, 100),
			})
		: getDreamingAttentionAcrossScopes(accessor, {
				kind,
				status: status ?? "pending",
				limit: bounded(limit, 50, 200),
			});
}

export function createDreamingCapabilities(params: CreateDreamingCapabilitiesParams): readonly DreamingCapability[] {
	const { accessor, agentId, actor } = params;
	return [
		capability(
			"memory_head_read",
			"Read curated memory head",
			"Read the scoped Dreaming-curated MEMORY.md head. During a content pass, committedEntries lists the last published entries with their support, even when the head is stale.",
			true,
			z.object({ agentId: z.string().min(1) }),
			async ({ agentId: scopeId }) =>
				scopeId === agentId
					? {
							ok: true,
							head: await (params.memoryHeadCommitter
								? params.memoryHeadCommitter.read(scopeId)
								: readCuratedMemoryHead(scopeId)),
						}
					: { ok: false, error: "Head scope must match the active agent" },
		),
		capability(
			"memory_head_commit",
			"Commit curated memory head",
			"Stage the complete retained MEMORY.md entry set for atomic application with a running content pass's finalization. Start from the committedEntries memory_head_read returns (the last published entries with their support) and give exact source/quote support for each entry; omitted entries are removed. A staged head is not durable until the pass finalizes successfully. Every content pass must stage exactly one commit, even when nothing changed: resubmit the committedEntries whose support still holds, or an empty entry set when there are none. Record deferrals and no-change reasons with runbook_write.",
			false,
			z.object({
				agentId: z.string().min(1),
				entries: z.array(
					z.object({
						entryId: z.string().min(1),
						text: z.string().min(1),
						support: z.array(z.object({ source_ref: z.string().min(1), quote: z.string().min(1) })).min(1),
					}),
				),
			}),
			async (input) =>
				params.passId && params.memoryHeadCommitter
					? params.memoryHeadCommitter.commit({ ...input, passId: params.passId })
					: {
							ok: false,
							code: "PASS_NOT_AUTHORIZED",
							error: "Head commit requires the active scoped Dreaming pass finalizer",
						},
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
			"List active claim attributes for one entity aspect in one agent scope by stable ids, each with its evidence quote and source_ref. include contradictions to add the aspect's active contradiction observations: advisory state alongside competing claim evidence, not a truth choice.",
			true,
			z.object({
				agentId: z.string().min(1),
				entityId: z.string().min(1),
				aspectId: z.string().min(1),
				include: z.array(z.enum(["contradictions"])).optional(),
				...pagination,
			}),
			async ({ agentId: scopeId, entityId, aspectId, include, limit, offset }) => {
				const result: MutableCapabilityOutput = {
					ok: true,
					items: await getAttributesForAspectFiltered(accessor, {
						entityId,
						aspectId,
						agentId: scopeId,
						kind: "attribute",
						status: "active",
						limit: bounded(limit, 50, 200),
						offset: Math.max(0, Math.floor(offset ?? 0)),
					}),
				};
				if (include?.includes("contradictions")) {
					result.contradictions = listOntologyContradictions(accessor, {
						agentId: scopeId,
						entityId,
						aspectId,
						status: "active",
					});
				}
				return result;
			},
		),
		capability(
			"search_evidence",
			"Search episodic evidence",
			"Search immutable episodic memories, artifacts, and transcripts in one agent scope across their full history. A query is split on whitespace into words that match independently as substrings (ASCII case-insensitive; unspaced text such as CJK matches as one phrase); sources matching more words rank first, then newer sources. since and before are optional explicit time bounds. Historical summary records can be requested explicitly with kind=summary, but are not part of the default Dreaming delivery path. Results contain exact bounded excerpts of the rendered evidence with contentOffset/contentLength; use sourceRef for citations, which are validated against the complete canonical source. Each record carries completed: memory, artifact, and summary records are settled captures (true); a transcript is true only after the session-end machinery writes its completion marker, and false while the session is still running — do not file claims from a still-growing transcript, since its states may be contradicted by the session's end. When you look up a specific source and contentTruncated is true, page exact fragments with the same sourceRef and chunkSize: start at offset=0 when contentHasPrevious is true, then use offset=contentOffset+content.length from the fragment just returned until contentHasNext is false. Omit query, since, and before to drain the durable delivery queue: it returns up to limit incomplete source revisions, each resuming at its delivered offset (including fragments already served earlier in this pass), regardless of time watermark. hasMore is true while more of the queue remains. A queued source that is only partly read continues on a later queue page, so do not page it yourself. File what each page establishes before calling again without a query for the next one, and stop when hasMore is false. Partway through a pass the queue closes (deliveryClosed: true): stop reading new sources, file what you have read, and finish so your progress is recorded. Narrow with a query if the list is large; pass an explicit earlier since only when you need older history. Artifacts are deduped by content hash: content-identical files across vault paths collapse to one canonical entry.",
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
				if (
					params.evidenceDeliveryDeadline !== undefined &&
					Date.now() >= params.evidenceDeliveryDeadline &&
					(query === undefined || query.trim() === "") &&
					since === undefined &&
					before === undefined &&
					sourceRef === undefined
				) {
					return {
						ok: true,
						items: [],
						hasMore: false,
						deliveryClosed: true,
						note: "This pass has used its time for new evidence. File what you have read, write the runbook, and finish; the rest of the queue is delivered to the next pass.",
					};
				}
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
					...(params.passId === undefined ? {} : { passId: params.passId }),
					...(params.evidenceChars === undefined ? {} : { evidenceChars: params.evidenceChars }),
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
						await getAttributesForAspectFiltered(accessor, {
							entityId,
							aspectId,
							agentId: scopeId,
							kind: "attribute",
							status: "active",
							limit: 200,
							offset: 0,
						})
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
			"zoom_history",
			"Zoom pass history",
			"Open line id+n of the pass history into the two lines of n/2 passes it was made from; n = 1 returns that pass's full record (runbook note, operation counts and failures, evidence window, quarantines).",
			true,
			z.object({
				agentId: z.string().min(1),
				id: z.number().int().min(0).describe("The first pass of the line, as shown before the +."),
				n: z.number().int().min(1).describe("How many passes the line covers, as shown after the +."),
				scopes: z
					.string()
					.min(1)
					.describe("The scopes= value of the history section the line is in. Omit for this pass's own history.")
					.optional(),
			}),
			async ({ agentId: scopeId, id, n, scopes }) => {
				const allowedScopes = params.allowedScopes ?? [scopeId];
				return await zoomDreamingHistory(accessor, {
					agentId,
					scopeKey: scopes ?? dreamingScopeKey(allowedScopes),
					allowedScopes,
					id,
					n,
				});
			},
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
			async ({ agentId: scopeId, kind, status, limit }) => ({
				ok: true,
				items: await listDreamingAttention(accessor, { agentId: scopeId, kind, status, limit }),
			}),
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
					contentPassId: params.memoryHeadCommitter ? params.passId : undefined,
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
	];
}

export function getDreamingCapability(
	params: CreateDreamingCapabilitiesParams,
	id: string,
): DreamingCapability | undefined {
	return createDreamingCapabilities(params).find((candidate) => candidate.id === id);
}
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
