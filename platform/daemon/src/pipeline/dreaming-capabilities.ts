import { attempt, redactCredentialsDeep } from "@signet/core";
import { prepareTypedStatement } from "../db-accessor";
import { readScopeSql } from "../read-scope";
import { classifyEntityQuality } from "../entity-quality";
import { detectProspectiveContradictionRisk } from "./antonyms";
import { z } from "zod";
import { getDbOwnerForAccessor, runDbOwnerDomainOperation } from "../db-owner-runtime";
import { ownerQueryAll } from "../db-owner-maintenance";
import { countTokens } from "./tokenizer";
import { dreamingReadPredicate } from "./dreaming-read-scope";
import type {
	DbOwnerDreamingGraphRead,
	DbOwnerDreamingEvidenceSearch,
	DbOwnerDreamingEvidencePreparation,
	DbOwnerDreamingEvidenceSource,
	DbOwnerDreamingReviewDue,
} from "../db-owner-protocol";
import type { DbAccessor, ReadDb, WriteDb } from "../db-accessor";
import type { ReadScope } from "../read-scope";
import { dreamingPassPartitionInDb, dreamingReadScopeInDb } from "../classification-owner";
import { enrichDreamingSpeakersInTx } from "./dreaming-speakers";
import { evidenceLeasedByOtherPasses, leaseDreamingEvidenceInTx } from "./dreaming-evidence-leases";

import type { EpisodicSourceRecord } from "../episodic-sources";
import { episodicQueryTerms, foldAsciiCase, readEpisodicSource, searchEpisodicSources } from "../episodic-sources";

import type { GraphWriteCaps } from "../ontology-proposals";

import { getDreamingAttentionAcrossScopes, getDreamingAttentionScoped } from "./dreaming-attention";
import { dreamingEvidenceResumeStart, nextDreamingEvidenceFragment, renderDreamingEvidence } from "./dreaming-evidence";
import {
	DREAMING_EVIDENCE_STALL_PASSES,
	type DreamingEvidenceCursor,
	type DreamingEvidenceReviewRequest,
	evidenceCursorForSource,
	extendDeliveredOffset,
	passDeliveredRanges,
	passFullyServedSourceRefs,
	pendingDreamingEvidenceContinuations,
	reviewDreamingEvidenceInDb,
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
import { MEMORY_HEAD_MAX_TOKENS, readCuratedMemoryHead, type MemoryHeadCommitter } from "../memory-head";

async function readScopedCuratedMemoryHead(
	accessor: DbAccessor,
	agentId: string,
	readScope: ReadScope,
): Promise<Record<string, unknown>> {
	const predicate = dreamingReadPredicate("e", readScope);
	const entries = await ownerQueryAll<{ entry_id: string; canonical_text: string; status: string }>(
		await getDbOwnerForAccessor(accessor),
		"dreaming.memory-head.scoped",
		`SELECT e.entry_id, e.canonical_text, e.status FROM memory_head_entries e
 WHERE e.agent_id = ? AND e.status = 'active' ${predicate.sql} ORDER BY e.entry_id LIMIT 200`,
		[agentId, ...predicate.args],
		{ deadlineMs: 30_000, estimatedWorkUnits: 200 },
	);
	const content = entries.map((entry) => `- ${entry.canonical_text.trim()}`).join("\n");
	return {
		agentId,
		content,
		status: "scoped",
		entries,
		maxTokens: MEMORY_HEAD_MAX_TOKENS,
		tokens: countTokens(content),
	};
}

const bounded = (value: number | undefined, fallback: number, max: number): number =>
	Math.min(Math.max(Math.floor(value ?? fallback), 1), max);

const MAX_EVIDENCE_EXCERPT_CHARS = 2_000;
const EVIDENCE_RESUME_OVERLAP_CHARS = Math.floor(MAX_EVIDENCE_EXCERPT_CHARS / 10);
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
		...((source.kind === "transcript" || source.sourceEntryId === null) && source.speakerUserId
			? { speakerUserId: source.speakerUserId }
			: {}),
		...(source.speaker === undefined ? {} : { speaker: source.speaker }),
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
	"review_evidence",
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
	readonly readScope?: ReadScope;
	readonly accessor: DbAccessor;
	readonly agentId: string;
	readonly allowedScopes?: readonly string[];
	readonly actor: string;
	readonly memoryHeadCommitter?: MemoryHeadCommitter;
	readonly passId?: string;
	readonly evidenceDeliveryDeadline?: number;
	readonly evidenceLeaseMs?: number;
	readonly compartmentId?: number | null;
	readonly passDeadline?: number;
	readonly evidenceTokenBudget?: number;
	readonly now?: () => number;
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
export function readDreamingScopeInDb(
	db: ReadDb,
	input: { readonly agentId: string; readonly passId?: string; readonly readScope?: ReadScope },
): ReadScope {
	if (input.passId === undefined && input.readScope !== undefined) return input.readScope;
	const partition =
		input.passId === undefined
			? { agentId: input.agentId, compartmentId: null }
			: dreamingPassPartitionInDb(db, input.passId, input.agentId);
	return dreamingReadScopeInDb(db, partition.agentId, partition.compartmentId);
}

export async function readDreamingScope(accessor: DbAccessor, agentId: string, passId?: string): Promise<ReadScope> {
	const input = { agentId, passId };
	return runDbOwnerDomainOperation(accessor, {
		runWithOwner: async (owner) =>
			await owner.submit<ReadScope>(
				{ kind: "dreaming_read_scope", input },
				{ operation: "dreaming.scope.read", lane: "read", deadlineMs: 30_000, estimatedWorkUnits: 100 },
			).result,
		runInline: ({ read }) => read((db) => readDreamingScopeInDb(db, input)),
	});
}

export function readDreamingGraphInDb(db: ReadDb, input: DbOwnerDreamingGraphRead): DreamingCapabilityOutput {
	const readScope = readDreamingScopeInDb(db, input);
	const scoped = { ...input, readScope };
	switch (input.tool) {
		case "search_entities":
			return searchEntitiesInDb(db, scoped);
		case "get_entity":
			return input.entityId
				? entityDetailInDb(db, { ...scoped, entityId: input.entityId })
				: { ok: false, error: "Entity not found" };
		case "list_aspect_claims":
			return input.entityId && input.aspectId
				? aspectClaimsInDb(db, { ...scoped, entityId: input.entityId, aspectId: input.aspectId })
				: { ok: false, error: "Aspect not found" };
		case "validate_proposal":
			return validateProposalInDb(db, scoped);
	}
}

async function readDreamingGraph(
	accessor: DbAccessor,
	input: DbOwnerDreamingGraphRead,
): Promise<DreamingCapabilityOutput> {
	return runDbOwnerDomainOperation(accessor, {
		runWithOwner: async (owner) =>
			await owner.submit<DreamingCapabilityOutput>(
				{ kind: "dreaming_graph_read", input },
				{ operation: "dreaming.graph.read", lane: "read", deadlineMs: 30_000, estimatedWorkUnits: 500 },
			).result,
		runInline: ({ read }) => read((db) => readDreamingGraphInDb(db, input)),
	});
}

function evidenceSourceRefs(result: DreamingCapabilityOutput): string[] {
	return evidenceItems(result).map((item) => item.sourceRef);
}

export function prepareDreamingEvidenceInDb(
	db: WriteDb,
	input: DbOwnerDreamingEvidencePreparation,
): DreamingCapabilityOutput {
	if (input.sourceRefs.length > MAX_HYDRATED_ITEMS) throw new Error("evidence_preparation_limit");
	const readScope = readDreamingScopeInDb(db, input);
	const items: Record<string, unknown>[] = [];
	const errors: Record<string, string>[] = [];
	for (const sourceRef of new Set(input.sourceRefs)) {
		const source = readEpisodicSource(db, { agentId: input.agentId, from: sourceRef, readScope });
		if (source === null) {
			errors.push({ sourceRef, error: "Evidence source not found" });
			continue;
		}
		if (input.action === "lease") {
			const leased = leaseDreamingEvidenceInTx(db, {
				agentId: input.agentId,
				passId: input.passId,
				sourceRefs: [sourceRef],
				ttlMs: input.ttlMs,
			});
			if (leased.has(sourceRef)) items.push({ sourceRef });
			continue;
		}
		try {
			const enriched = enrichDreamingSpeakersInTx(db, input.passId, [source], input.agentId);
			items.push({ sourceRef, speaker: enriched[0]?.speaker });
		} catch (error) {
			if (!(error instanceof Error) || !["person_identity_missing", "speaker_required"].includes(error.message))
				throw error;
			errors.push({ sourceRef, error: error.message });
		}
	}
	return { ok: true, items, ...(errors.length > 0 ? { itemErrors: errors } : {}) };
}

async function prepareDreamingEvidence(
	accessor: DbAccessor,
	input: DbOwnerDreamingEvidencePreparation,
): Promise<DreamingCapabilityOutput> {
	return runDbOwnerDomainOperation(accessor, {
		runWithOwner: async (owner) =>
			await owner.submit<DreamingCapabilityOutput>(
				{ kind: "dreaming_evidence_prepare", input },
				{
					operation: `dreaming.evidence.${input.action}`,
					lane: "write",
					deadlineMs: 5_000,
					estimatedWorkUnits: input.sourceRefs.length,
				},
			).result,
		runInline: ({ write }) => write((db) => prepareDreamingEvidenceInDb(db, input)),
	});
}

async function searchDreamingEvidence(
	accessor: DbAccessor,
	input: DbOwnerDreamingEvidenceSearch,
): Promise<DreamingCapabilityOutput> {
	const read = () =>
		runDbOwnerDomainOperation(accessor, {
			runWithOwner: async (owner) =>
				await owner.submit<DreamingCapabilityOutput>(
					{ kind: "dreaming_evidence_search", input },
					{
						operation: "dreaming.capabilities.search-evidence",
						lane: "read",
						workloadClass: "foreground",
						deadlineMs: 30_000,
						estimatedWorkUnits: 200,
					},
				).result,
			runInline: ({ read }) => read((db) => searchDreamingEvidenceInDb(db, input)),
		});
	let result = await read();
	if (!input.passId) return result;
	const pass = { agentId: input.agentId, passId: input.passId };
	const drainsQueue =
		!input.query?.trim() && input.since === undefined && input.before === undefined && input.sourceRef === undefined;
	if (drainsQueue && input.evidenceLeaseMs !== undefined) {
		for (let attempt = 0; attempt < 4; attempt++) {
			const sourceRefs = evidenceSourceRefs(result);
			if (sourceRefs.length === 0) break;
			const prepared = await prepareDreamingEvidence(accessor, {
				...pass,
				action: "lease",
				sourceRefs,
				ttlMs: input.evidenceLeaseMs,
			});
			const leased = new Set(evidenceSourceRefs(prepared));
			if (sourceRefs.every((ref) => leased.has(ref))) break;
			if (attempt === 3) {
				result = {
					...result,
					items: evidenceItems(result).filter((item) => leased.has(item.sourceRef)),
					hasMore: true,
				};
			} else result = await read();
		}
	}
	const sourceRefs = evidenceSourceRefs(result);
	if (sourceRefs.length === 0) return result;
	const prepared = await prepareDreamingEvidence(accessor, { ...pass, action: "speakers", sourceRefs });
	const speakers = new Map(evidenceItems(prepared).map((item) => [item.sourceRef, item]));
	return {
		...result,
		items: evidenceItems(result).flatMap((item) => {
			const speaker = speakers.get(item.sourceRef);
			return speaker ? [{ ...item, speaker: speaker.speaker }] : [];
		}),
		...(prepared.itemErrors === undefined ? {} : { itemErrors: prepared.itemErrors, hasMore: true }),
	};
}

function evidenceItems(result: DreamingCapabilityOutput): Array<Record<string, unknown> & { sourceRef: string }> {
	if (!Array.isArray(result.items)) return [];
	return result.items.flatMap((item: unknown) =>
		typeof item === "object" && item !== null && "sourceRef" in item && typeof item.sourceRef === "string"
			? [{ ...item, sourceRef: item.sourceRef }]
			: [],
	);
}

export function searchDreamingEvidenceInDb(db: ReadDb, input: DbOwnerDreamingEvidenceSearch): DreamingCapabilityOutput {
	const scopeId = input.agentId;
	const readScope = readDreamingScopeInDb(db, input);
	if (input.sourceRef !== undefined) {
		const source = readEpisodicSource(db, { agentId: scopeId, from: input.sourceRef, readScope });
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
		limit: Math.max(1, Math.min(Math.floor(input.limit ?? 20), MAX_HYDRATED_ITEMS)),
		readScope,
	});
	return { ok: true, items: projectEvidence(sources, query ?? "") };
}

const DELIVERY_QUEUE_SCAN_LIMIT = 51;
const WAITING_QUEUE_STRIDE = 3;

function interleaveWaiting(
	waiting: readonly EpisodicSourceRecord[],
	newest: readonly EpisodicSourceRecord[],
): EpisodicSourceRecord[] {
	const order = new Map<string, EpisodicSourceRecord>();
	const add = (source: EpisodicSourceRecord | undefined): void => {
		if (source === undefined) return;
		const ref = `${source.kind}:${source.id}`;
		if (!order.has(ref)) order.set(ref, source);
	};
	newest.forEach((source, index) => {
		if (index % WAITING_QUEUE_STRIDE === 0) add(waiting[index / WAITING_QUEUE_STRIDE]);
		add(source);
	});
	waiting.forEach(add);
	return [...order.values()];
}

function drainDreamingEvidenceQueueInDb(db: ReadDb, input: DbOwnerDreamingEvidenceSearch): DreamingCapabilityOutput {
	const scopeId = input.agentId;
	const partition = input.passId ? dreamingPassPartitionInDb(db, input.passId, scopeId) : { compartmentId: null };
	const peerLeases = evidenceLeasedByOtherPasses(db, scopeId, input.passId, partition.compartmentId);
	const limit = Math.max(1, Math.min(Math.floor(input.limit ?? 20), 50));
	const servedInPass = input.passId ? passDeliveredRanges(db, input.passId, scopeId) : new Map();
	const pageChars = evidencePageChars(input.evidenceChars);
	let budgetExhausted = false;
	const cursors = new Map<string, DreamingEvidenceCursor>();
	const cursorFor = (source: EpisodicSourceRecord): DreamingEvidenceCursor => {
		const ref = `${source.kind}:${source.id}`;
		const cursor = cursors.get(ref) ?? evidenceCursorForSource(db, scopeId, source);
		cursors.set(ref, cursor);
		return cursor;
	};
	const stalled = (source: EpisodicSourceRecord): boolean =>
		cursorFor(source).stalledPasses >= DREAMING_EVIDENCE_STALL_PASSES;
	const queue = {
		agentId: scopeId,
		query: "",
		kind: input.kind,
		excludeDelivered: true,
		exactCompartment: partition.compartmentId,
		excludeSourceRefs: [...peerLeases, ...(input.passId ? passFullyServedSourceRefs(db, input.passId, scopeId) : [])],
	};
	const scanned = interleaveWaiting(
		searchEpisodicSources(db, {
			...queue,
			excludeStalledFrom: DREAMING_EVIDENCE_STALL_PASSES,
			limit: Math.ceil(DELIVERY_QUEUE_SCAN_LIMIT / WAITING_QUEUE_STRIDE),
			order: "oldest-arrival",
		}),
		searchEpisodicSources(db, { ...queue, limit: DELIVERY_QUEUE_SCAN_LIMIT, order: "newest-arrival" }),
	);
	const fresh = [...scanned.filter((source) => !stalled(source)), ...scanned.filter(stalled)];
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
			const reviewed = cursorFor(source).offset;
			const served = extendDeliveredOffset(reviewed, servedInPass.get(ref));
			const offset =
				served > reviewed ? served : dreamingEvidenceResumeStart(source, reviewed, EVIDENCE_RESUME_OVERLAP_CHARS);
			const fragment = projectEvidenceFragment(source, offset, Math.max(remaining, MAX_EVIDENCE_EXCERPT_CHARS));
			if (fragment !== null) {
				items.push(
					reviewed > offset
						? { ...fragment, reviewedChars: Math.min(reviewed - offset, String(fragment.content).length) }
						: fragment,
				);
				remaining -= typeof fragment.content === "string" ? fragment.content.length : 0;
			}
			if (items.length >= max) break;
		}
		return items;
	};
	const continuationRefs = new Set<string>();
	const continuations = page(
		pendingDreamingEvidenceContinuations(db, scopeId, 50, input.kind, partition.compartmentId, peerLeases),
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
		...(returned.length === 0 && peerLeases.length > 0
			? { heldByOtherPasses: true, note: "The remaining sources are held by other running Dreaming passes." }
			: {}),
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
	return readEpisodicSource(db, {
		agentId: input.agentId,
		from: input.sourceRef,
		readScope: readDreamingScopeInDb(db, input),
	});
}

export function collectDreamingReviewDueInDb(
	db: ReadDb,
	input: DbOwnerDreamingReviewDue,
): ReturnType<typeof collectReviewDueClaims> {
	return collectReviewDueClaims(
		{ all: <T>(sql: string, ...params: unknown[]) => db.prepare(sql).all(...params) as T[] },
		new Date(input.nowMs),
		{ agentId: input.agentId, limit: input.limit, readScope: input.readScope },
	);
}

export async function listDreamingAttention(
	accessor: DbAccessor,
	params: {
		readonly agentId?: string;
		readonly kind?: string;
		readonly status?: "pending" | "resolved";
		readonly limit?: number;
		readonly agentFacing?: boolean;
		readonly readScope?: ReadScope;
	},
): Promise<readonly unknown[]> {
	const { agentId: scopeId, kind, status, limit, agentFacing } = params;
	if (kind === "review_due") {
		if (status === "resolved") return [];
		const input: DbOwnerDreamingReviewDue = {
			agentId: scopeId,
			readScope: params.readScope,
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
				readScope: params.readScope,
				kind,
				status: status ?? "pending",
				limit: bounded(limit, 20, 100),
				agentFacing,
			})
		: getDreamingAttentionAcrossScopes(accessor, {
				readScope: params.readScope,
				kind,
				status: status ?? "pending",
				limit: bounded(limit, 50, 200),
				agentFacing,
			});
}

const EVIDENCE_CHARS_PER_TOKEN = 4;

function deliveredEvidenceChars(items: readonly unknown[]): number {
	let chars = 0;
	for (const item of items) {
		const content = (item as { content?: unknown } | null)?.content;
		if (typeof content === "string") chars += content.length;
	}
	return chars;
}

export function createDreamingCapabilities(params: CreateDreamingCapabilitiesParams): readonly DreamingCapability[] {
	const { accessor, agentId, actor } = params;
	const now = params.now ?? Date.now;
	let lastQueueDeliveryAt: number | undefined;
	let deliveredQueueChars = 0;
	const queueDeliveryClosed = (at: number): boolean => {
		if (params.evidenceDeliveryDeadline !== undefined && at >= params.evidenceDeliveryDeadline) return true;
		if (
			params.evidenceTokenBudget !== undefined &&
			deliveredQueueChars >= params.evidenceTokenBudget * EVIDENCE_CHARS_PER_TOKEN
		)
			return true;
		if (params.passDeadline === undefined || lastQueueDeliveryAt === undefined) return false;
		return at + 2 * (at - lastQueueDeliveryAt) >= params.passDeadline;
	};
	return [
		capability(
			"memory_head_read",
			"Read curated memory head",
			`Read the scoped Dreaming-curated MEMORY.md head. tokens is the current head's size and maxTokens its budget (${MEMORY_HEAD_MAX_TOKENS}). During a content pass, committedEntries lists the last published entries whose support still holds, with that support, even when the head is stale, and committedTokens is their size. readableEntries are read-only entries from unclassified or subset-label streams: do not mutate or retain those entryIds in this stream; use a fresh entryId if their supported content belongs here.`,
			true,
			z.object({ agentId: z.string().min(1) }),
			async ({ agentId: scopeId }) =>
				scopeId === agentId
					? {
							ok: true,
							head: await (params.passId === undefined && params.readScope
								? readScopedCuratedMemoryHead(accessor, scopeId, params.readScope)
								: params.memoryHeadCommitter
									? params.memoryHeadCommitter.read(scopeId)
									: readCuratedMemoryHead(scopeId)),
						}
					: { ok: false, error: "Head scope must match the active agent" },
		),
		capability(
			"memory_head_commit",
			"Commit curated memory head",
			`Stage the complete retained MEMORY.md entry set for atomic application with a running content pass's finalization. Start from the committedEntries memory_head_read returns (the last published entries whose support still holds) and give exact source/quote support for each entry; omitted entries are removed. A staged head is not durable until the pass finalizes successfully. The rendered head, one "- text" line per entry, must be at most ${MEMORY_HEAD_MAX_TOKENS} tokens; an over-budget set is rejected with its token count. A rejected commit is not staged; fix it and commit again. Every content pass needs exactly one accepted commit, even when nothing changed: resubmit the committedEntries, or an empty entry set when there are none; an empty set clears the head only when no committed entry still has valid support. A second commit after one is accepted is rejected. Record deferrals and no-change reasons with runbook_write.`,
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
			async (input) =>
				readDreamingGraph(accessor, {
					...input,
					tool: "search_entities",
					passId: params.passId,
					readScope: params.readScope,
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
			async (input) =>
				readDreamingGraph(accessor, {
					...input,
					tool: "get_entity",
					passId: params.passId,
					readScope: params.readScope,
				}),
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
			async (input) =>
				readDreamingGraph(accessor, {
					...input,
					tool: "list_aspect_claims",
					passId: params.passId,
					readScope: params.readScope,
				}),
		),
		capability(
			"search_evidence",
			"Search episodic evidence",
			"Search immutable episodic memories, artifacts, and transcripts in one agent scope across their full history. A query is split on whitespace into words that match independently as substrings (ASCII case-insensitive; unspaced text such as CJK matches as one phrase); sources matching more words rank first, then newer sources. since and before are optional explicit time bounds. Historical summary records can be requested explicitly with kind=summary, but are not part of the default Dreaming delivery path. Results contain exact bounded excerpts of the rendered evidence with contentOffset/contentLength; use sourceRef for citations, which are validated against the complete canonical source. Copy each sourceRef character for character. Each record carries completed: memory, artifact, and summary records are settled captures (true); a transcript is true only after the session-end machinery writes its completion marker, and false while the session is still running — do not file claims from a still-growing transcript, since its states may be contradicted by the session's end. When you look up a specific source and contentTruncated is true, page exact fragments with the same sourceRef and chunkSize: start at offset=0 when contentHasPrevious is true, then use offset=contentOffset+content.length from the fragment just returned until contentHasNext is false. Omit query, since, and before to drain the durable delivery queue: it returns up to limit source revisions not yet fully reviewed, regardless of time watermark. A page holds one excerpt per source. Each resumes where review_evidence acknowledgements ended, after fragments already served earlier in this pass; a source reviewed in an earlier pass resumes slightly before that point, and reviewedChars counts the leading characters already reviewed, which you need not file again. hasMore is true while more of the queue remains. A queued source that is only partly read continues on a later queue page, so do not page it yourself. File what each page establishes and acknowledge it with review_evidence before calling again without a query for the next one, and stop when hasMore is false. Partway through a pass the queue closes (deliveryClosed: true): stop reading new sources, file what you have read, and finish so your progress is recorded. Narrow with a query if the list is large; pass an explicit earlier since only when you need older history. Artifacts are deduped by content hash: content-identical files across vault paths collapse to one canonical entry.",
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
				const drainsQueue =
					(query === undefined || query.trim() === "") &&
					since === undefined &&
					before === undefined &&
					sourceRef === undefined;
				if (drainsQueue && queueDeliveryClosed(now())) {
					return {
						ok: true,
						items: [],
						hasMore: false,
						deliveryClosed: true,
						note: "This pass has used its time or evidence budget for new evidence. File what you have read, write the runbook, and finish; the rest of the queue is delivered to the next pass.",
					};
				}
				const input: DbOwnerDreamingEvidenceSearch = {
					readScope: params.readScope,
					agentId: scopeId,
					...(query === undefined ? {} : { query }),
					...(since === undefined ? {} : { since }),
					...(before === undefined ? {} : { before }),
					...(kind === undefined ? {} : { kind }),
					...(limit === undefined ? {} : { limit }),
					...(sourceRef === undefined ? {} : { sourceRef }),
					...(offset === undefined ? {} : { offset }),
					...(chunkSize === undefined ? {} : { chunkSize }),
					...(params.passId === undefined ? {} : { passId: params.passId, readScope: params.readScope }),
					...(params.evidenceChars === undefined ? {} : { evidenceChars: params.evidenceChars }),
					...(params.evidenceLeaseMs === undefined ? {} : { evidenceLeaseMs: params.evidenceLeaseMs }),
				};
				const result = await searchDreamingEvidence(accessor, input);
				if (drainsQueue && Array.isArray(result.items) && result.items.length > 0) {
					lastQueueDeliveryAt = now();
					deliveredQueueChars += deliveredEvidenceChars(result.items);
				}
				return result;
			},
		),
		capability(
			"review_evidence",
			"Acknowledge reviewed evidence",
			"Record which evidence excerpts this pass has reviewed. A source's evidence cursor moves forward only through text acknowledged here or cited by a successful apply_ontology_ops operation; delivered text that is never acknowledged stays queued and is delivered again to a later pass. For each item, copy sourceRef and contentOffset from a search_evidence result delivered in this pass and scope. Omit through when you reviewed the whole excerpt; otherwise set through to an exact quote from the excerpt, and review ends where its first occurrence ends. A call with any invalid item is rejected as a whole with a code (EXCERPT_NOT_DELIVERED, SCOPE_MISMATCH, QUOTE_NOT_IN_EXCERPT, SOURCE_CHANGED); correct it and call again.",
			false,
			z.object({
				agentId: z.string().min(1),
				items: z
					.array(
						z.object({
							sourceRef: z.string().min(1),
							contentOffset: z.number().int().min(0),
							through: z.string().trim().min(1).optional(),
						}),
					)
					.min(1)
					.max(50),
			}),
			async ({ agentId: scopeId, items }) => {
				if (!params.passId)
					return { ok: false, code: "PASS_REQUIRED", error: "Evidence review requires a live Dreaming pass" };
				const input: DreamingEvidenceReviewRequest = { agentId: scopeId, passId: params.passId, items };
				return await runDbOwnerDomainOperation(accessor, {
					runWithOwner: async (owner) => {
						const handle = owner.submit<DreamingCapabilityOutput>(
							{ kind: "dreaming_evidence_review", input },
							{
								operation: "dreaming.capabilities.review-evidence",
								lane: "read",
								workloadClass: "foreground",
								deadlineMs: 30_000,
								estimatedWorkUnits: 200,
							},
						);
						return await handle.result;
					},
					runInline: ({ read }) => read((db) => reviewDreamingEvidenceInDb(db, input)),
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
			async (input) =>
				readDreamingGraph(accessor, {
					...input,
					tool: "validate_proposal",
					passId: params.passId,
					readScope: params.readScope,
				}),
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
				await readDreamingScope(accessor, scopeId, params.passId);
				const allowedScopes = params.allowedScopes ?? [scopeId];
				return await zoomDreamingHistory(accessor, {
					agentId,
					scopeKey: scopes ?? dreamingScopeKey(allowedScopes),
					compartmentId: params.compartmentId ?? null,
					readScope: params.readScope,
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
			"List attention records by kind and resolution status. Use kind hygiene for structural queue work, kind surprisal for bounded exploration hints, or review_due for expired and approaching temporal claims. Omitted agentId means this pass's run agent, never the whole install. Each record carries its owning agentId.",
			true,
			z.object({
				agentId: z.string().optional(),
				kind: z.string().optional(),
				status: z.enum(["pending", "resolved"]).optional(),
				limit: z.number().finite().optional(),
			}),
			async ({ agentId: scopeId, kind, status, limit }) => ({
				ok: true,
				items: await listDreamingAttention(accessor, {
					agentId: scopeId ?? agentId,
					readScope: params.readScope ?? (await readDreamingScope(accessor, scopeId ?? agentId, params.passId)),
					kind,
					status,
					limit,
					agentFacing: true,
				}),
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
					readScope: params.readScope,
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

interface GraphInput {
	readonly agentId: string;
	readonly readScope: ReadScope;
}
interface PageInput {
	readonly limit?: number;
	readonly offset?: number;
}
export interface DreamingGraphOutput {
	readonly ok: boolean;
	readonly [key: string]: unknown;
}
function page(input: PageInput, fallback = 50, maximum = 200): readonly [number, number] {
	const limit = input.limit !== undefined && Number.isFinite(input.limit) ? Math.floor(input.limit) : fallback;
	const offset = input.offset !== undefined && Number.isFinite(input.offset) ? Math.floor(input.offset) : 0;
	return [Math.max(1, Math.min(maximum, limit)), Math.max(0, offset)];
}
function graphScope(input: GraphInput) {
	if (!input.agentId.trim()) throw new Error("agent_required");
	const args: unknown[] = [];
	const predicate = (alias: string, source: string | null = null) => {
		const scope =
			input.readScope.projects !== null
				? { sql: " AND 0", args: [] }
				: readScopeSql(alias, input.readScope, { visibility: null, memory: null, session: null, source });
		args.push(input.agentId, ...scope.args);
		return `${alias}.agent_id = ? ${scope.sql} AND COALESCE(${alias}.status,'active') = 'active'`;
	};
	const sql = `WITH visible_entities AS (
		SELECT e.* FROM entities e WHERE ${predicate("e", "source_id")}
	), visible_aspects AS (
		SELECT asp.* FROM entity_aspects asp JOIN visible_entities e ON e.id=asp.entity_id AND e.agent_id=asp.agent_id
		WHERE ${predicate("asp")}
	), visible_attributes AS (
		SELECT attr.* FROM entity_attributes attr JOIN visible_aspects asp ON asp.id=attr.aspect_id AND asp.agent_id=attr.agent_id
		WHERE ${predicate("attr", "source_id")}
	), visible_dependencies AS (
		SELECT dep.* FROM entity_dependencies dep
		JOIN visible_entities src ON src.id=dep.source_entity_id AND src.agent_id=dep.agent_id
		JOIN visible_entities dst ON dst.id=dep.target_entity_id AND dst.agent_id=dep.agent_id
		WHERE ${predicate("dep")} AND (dep.aspect_id IS NULL OR EXISTS (
			SELECT 1 FROM visible_aspects asp WHERE asp.id=dep.aspect_id AND asp.agent_id=dep.agent_id
		))
	), visible_contradictions AS (
		SELECT c.* FROM ontology_contradictions c
		JOIN visible_aspects asp ON asp.id=c.aspect_id AND asp.entity_id=c.entity_id AND asp.agent_id=c.agent_id
		JOIN visible_attributes l ON l.id=c.left_attribute_id AND l.aspect_id=asp.id AND l.agent_id=c.agent_id
		JOIN visible_attributes r ON r.id=c.right_attribute_id AND r.aspect_id=asp.id AND r.agent_id=c.agent_id
		WHERE ${predicate("c")}
	)`;
	return { sql, args };
}
const entityProjection = `e.id,e.name,e.canonical_name AS canonicalName,e.entity_type AS entityType,
	e.agent_id AS agentId,substr(e.description,1,2000) AS description,e.mentions,e.pinned,e.pinned_at AS pinnedAt,
	e.status,e.created_at AS createdAt,e.updated_at AS updatedAt,
	json_array_length(CASE WHEN json_valid(e.proposal_evidence) THEN e.proposal_evidence ELSE '[]' END) AS proposalEvidenceCount`;
const entityCounts = `
	(SELECT COUNT(*) FROM visible_aspects asp WHERE asp.entity_id=e.id) AS aspectCount,
	(SELECT COUNT(*) FROM visible_attributes attr JOIN visible_aspects asp ON asp.id=attr.aspect_id WHERE asp.entity_id=e.id AND attr.kind='attribute') AS attributeCount,
	(SELECT COUNT(*) FROM visible_attributes attr JOIN visible_aspects asp ON asp.id=attr.aspect_id WHERE asp.entity_id=e.id AND attr.kind='constraint') AS constraintCount,
	(SELECT COUNT(*) FROM visible_dependencies dep WHERE dep.source_entity_id=e.id OR dep.target_entity_id=e.id) AS dependencyCount`;
const entityOrder = "e.pinned DESC,e.pinned_at DESC,e.mentions DESC,e.updated_at DESC,e.name ASC,e.id ASC";

export function searchEntitiesInDb(
	db: ReadDb,
	input: GraphInput & PageInput & { readonly query?: string; readonly type?: string },
): DreamingGraphOutput {
	const scope = graphScope(input);
	const args = [...scope.args];
	let filters = "";
	if (input.query?.trim()) {
		filters += " AND instr(e.canonical_name,?)>0";
		args.push(input.query.trim().toLowerCase());
	}
	if (input.type) {
		filters += " AND e.entity_type=?";
		args.push(input.type);
	}
	const rows = prepareTypedStatement<Record<string, unknown>>(
		db,
		`${scope.sql}
		SELECT ${entityProjection},${entityCounts} FROM visible_entities e WHERE 1=1 ${filters}
		ORDER BY ${entityOrder} LIMIT ? OFFSET ?`,
	).all(...args, ...page(input, 20, 100));
	return { ok: true, items: rows.map((row) => ({ ...row, pinned: row.pinned === 1 })) };
}
export function entityDetailInDb(
	db: ReadDb,
	input: GraphInput &
		PageInput & {
			readonly entityId: string;
			readonly include?: readonly string[];
			readonly direction?: "incoming" | "outgoing" | "both";
		},
): DreamingGraphOutput {
	const scope = graphScope(input);
	const entity = prepareTypedStatement<Record<string, unknown>>(
		db,
		`${scope.sql}
		SELECT ${entityProjection},${entityCounts} FROM visible_entities e WHERE e.id=?`,
	).get(...scope.args, input.entityId);
	if (!entity) return { ok: false, error: "Entity not found" };
	const result: Record<string, unknown> = {
		ok: true,
		entity: { ...entity, pinned: entity.pinned === 1 },
		pinned: entity.pinned === 1,
		aspectCount: entity.aspectCount,
		attributeCount: entity.attributeCount,
		constraintCount: entity.constraintCount,
		dependencyCount: entity.dependencyCount,
	};
	const [limit, offset] = page(input);
	if (input.include?.includes("aspects")) {
		const aspects = prepareTypedStatement<Record<string, unknown>>(
			db,
			`${scope.sql}
			SELECT asp.id,substr(asp.name,1,2000) AS name,
			(SELECT COUNT(*) FROM visible_attributes attr WHERE attr.aspect_id=asp.id AND attr.kind='attribute') AS attributeCount,
			(SELECT COUNT(*) FROM visible_attributes attr WHERE attr.aspect_id=asp.id AND attr.kind='constraint') AS constraintCount
			FROM visible_aspects asp WHERE asp.entity_id=? ORDER BY asp.weight DESC,asp.name,asp.id LIMIT ? OFFSET ?`,
		).all(...scope.args, input.entityId, limit, offset);
		result.aspects = aspects;
		result.aspectsOffset = offset;
		result.aspectsTruncated = offset + aspects.length < Number(entity.aspectCount);
	}
	if (input.include?.includes("links")) {
		const direction = input.direction ?? "both";
		const filter =
			direction === "incoming"
				? "dep.target_entity_id=?"
				: direction === "outgoing"
					? "dep.source_entity_id=?"
					: "(dep.source_entity_id=? OR dep.target_entity_id=?)";
		const ids = direction === "both" ? [input.entityId, input.entityId] : [input.entityId];
		const links = prepareTypedStatement<Record<string, unknown>>(
			db,
			`${scope.sql}
			SELECT dep.id,CASE WHEN dep.source_entity_id=? THEN 'outgoing' ELSE 'incoming' END AS direction,
			dep.dependency_type AS dependencyType,dep.strength,dep.aspect_id AS aspectId,substr(dep.reason,1,2000) AS reason,
			dep.source_entity_id AS sourceEntityId,src.name AS sourceEntityName,dep.target_entity_id AS targetEntityId,dst.name AS targetEntityName,
			dep.created_at AS createdAt,dep.updated_at AS updatedAt
			FROM visible_dependencies dep JOIN visible_entities src ON src.id=dep.source_entity_id JOIN visible_entities dst ON dst.id=dep.target_entity_id
			WHERE ${filter} ORDER BY dep.strength DESC,dep.updated_at DESC,dep.id LIMIT ? OFFSET ?`,
		).all(...scope.args, input.entityId, ...ids, limit, offset);
		const count =
			prepareTypedStatement<{ count: number }>(
				db,
				`${scope.sql} SELECT COUNT(*) AS count FROM visible_dependencies dep WHERE ${filter}`,
			).get(...scope.args, ...ids)?.count ?? 0;
		result.links = links;
		result.linksOffset = offset;
		result.linksTruncated = offset + links.length < count;
	}
	return { ok: true, ...result };
}
function proposalEvidence(value: unknown): readonly unknown[] {
	if (typeof value !== "string") return [];
	const parsed: unknown = attempt(() => JSON.parse(value));
	return Array.isArray(parsed) ? parsed : [];
}
export function aspectClaimsInDb(
	db: ReadDb,
	input: GraphInput &
		PageInput & { readonly entityId: string; readonly aspectId: string; readonly include?: readonly string[] },
): DreamingGraphOutput {
	const scope = graphScope(input);
	const args = [...scope.args, input.entityId, input.aspectId];
	const items = prepareTypedStatement<Record<string, unknown>>(
		db,
		`${scope.sql}
		SELECT attr.id,attr.aspect_id AS aspectId,attr.agent_id AS agentId,attr.kind,attr.status,attr.content,
		attr.confidence,attr.importance,attr.source_kind AS sourceKind,attr.source_id AS sourceId,attr.proposal_evidence AS proposalEvidence
		FROM visible_attributes attr JOIN visible_aspects asp ON asp.id=attr.aspect_id
		WHERE asp.entity_id=? AND asp.id=? AND attr.kind='attribute'
		ORDER BY attr.importance DESC,attr.created_at DESC,attr.id LIMIT ? OFFSET ?`,
	).all(...args, ...page(input));
	const claims = items.map((item) => ({ ...item, proposalEvidence: proposalEvidence(item.proposalEvidence) }));
	if (!input.include?.includes("contradictions")) return { ok: true, items: claims };
	const contradictions = prepareTypedStatement<Record<string, unknown>>(
		db,
		`${scope.sql}
		SELECT c.id,c.left_attribute_id AS leftAttributeId,c.right_attribute_id AS rightAttributeId,
		c.left_content AS leftContent,c.right_content AS rightContent,c.reason
		FROM visible_contradictions c WHERE c.entity_id=? AND c.aspect_id=? ORDER BY c.updated_at DESC,c.id LIMIT ? OFFSET ?`,
	).all(...args, ...page(input));
	const count =
		prepareTypedStatement<{ count: number }>(
			db,
			`${scope.sql} SELECT COUNT(*) AS count FROM visible_contradictions c WHERE c.entity_id=? AND c.aspect_id=?`,
		).get(...args)?.count ?? 0;
	return { ok: true, items: claims, contradictions: { count, items: contradictions } };
}
export function validateProposalInDb(
	db: ReadDb,
	input: GraphInput & {
		readonly name?: string;
		readonly type?: string;
		readonly entityId?: string;
		readonly aspectId?: string;
		readonly value?: string;
	},
): DreamingGraphOutput {
	const scope = graphScope(input);
	const result: Record<string, unknown> = { ok: true };
	if (input.name !== undefined) {
		result.label = classifyEntityQuality(input.name, input.type);
		result.duplicates = prepareTypedStatement<Record<string, unknown>>(
			db,
			`${scope.sql}
			SELECT e.id,e.name,e.entity_type AS entityType FROM visible_entities e WHERE e.canonical_name=? ORDER BY ${entityOrder} LIMIT 100`,
		).all(...scope.args, input.name.trim().toLowerCase().replace(/\s+/g, " "));
	}
	if (input.entityId !== undefined && input.aspectId !== undefined && input.value !== undefined) {
		const value = input.value;
		const items = prepareTypedStatement<{ attributeId: string; content: string }>(
			db,
			`${scope.sql}
			SELECT attr.id AS attributeId,attr.content FROM visible_attributes attr JOIN visible_aspects asp ON asp.id=attr.aspect_id
			WHERE asp.entity_id=? AND asp.id=? AND attr.kind='attribute' ORDER BY attr.importance DESC,attr.created_at DESC,attr.id LIMIT 200`,
		).all(...scope.args, input.entityId, input.aspectId);
		result.contradiction = items.map((item) => ({
			...item,
			...detectProspectiveContradictionRisk(value, item.content),
		}));
	}
	return { ok: true, ...result };
}
