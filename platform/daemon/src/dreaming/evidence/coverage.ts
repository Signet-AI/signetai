import type { DbAccessor, ReadDb } from "../../db/owner/accessor";
import {
	type EpisodicSourceKind,
	type EpisodicSourceRecord,
	countEpisodicDreamingEvidenceSources,
	readRecentEpisodicSources,
} from "./episodic-sources";
import { dbOwnerDreamingEvidenceCoverage, runDbOwnerDomainOperation } from "../../db/owner/runtime";
import type {
	DbOwnerDreamingEvidenceCoverage,
	DbOwnerDreamingEvidenceCoverageCursor,
	DbOwnerDreamingEvidenceCoverageDeliveryRow,
	DbOwnerDreamingEvidenceCoverageEntryInput,
	DbOwnerDreamingEvidenceCoverageResult,
} from "../../db/owner/protocol";
import { renderDreamingEvidence } from "./evidence";
import {
	type DreamingEvidenceCursor,
	evidenceCursorForSource,
	hasDreamingEvidenceReviewRow,
	pendingDreamingEvidenceContinuations,
	persistedEvidenceDeliveries,
	readDreamingEvidencePassesPage,
	readStalledEvidenceAttentionIds,
} from "./consumption";
import { DREAMING_EVIDENCE_KINDS } from "../passes/dreaming";

export interface DreamingEvidenceCoverageSourceTotals {
	readonly eligible: number;
	readonly fullyReviewed: number;
	readonly partiallyReviewed: number;
	readonly neverDelivered: number;
}

export interface DreamingEvidenceCoverageCharTotals {
	readonly eligible: number;
	readonly reviewed: number;
	readonly unreviewed: number;
	readonly consumedWithoutReview: number;
	readonly delivered: number;
	readonly redelivered: number;
	readonly consumedByCursorBasis: Readonly<Record<string, number>>;
	readonly stalledRows: number;
}

export interface DreamingEvidenceCoverageKindBreakdown {
	readonly sources: DreamingEvidenceCoverageSourceTotals;
	readonly chars: DreamingEvidenceCoverageCharTotals;
}

export interface DreamingEvidenceCoverage {
	readonly agentId: string;
	readonly sources: DreamingEvidenceCoverageSourceTotals;
	readonly chars: DreamingEvidenceCoverageCharTotals;
	readonly dreamedFraction: number | null;
	readonly redeliveryRatio: number;
	readonly pendingContinuations: number;
	readonly openStalledAttention: number;
	readonly scanComplete: boolean;
	readonly fullyReviewed: boolean;
	readonly byKind: Readonly<Record<string, DreamingEvidenceCoverageKindBreakdown>>;
}

export interface DreamingEvidenceCoverageBounds {
	readonly maxSources: number;
	readonly maxPasses: number;
	readonly deadlineMs: number;
}

const SOURCE_PAGE_ROWS = 100;
const MAX_DELIVERY_RANGES_PER_ENTRY = 200;
const SOURCE_PAGE_RESULT_BYTE_BUDGET = 512_000;
const PASS_PAGE_ROWS = 100;
const CLASSIFY_CHUNK_ROWS = 100;
const CONTINUATIONS_LIMIT = 50;
const ATTENTION_PAGE_ROWS = 200;

export const DREAMING_EVIDENCE_COVERAGE_MAX_SOURCES = 100_000;
export const DREAMING_EVIDENCE_COVERAGE_MAX_PASSES = 50_000;
export const DREAMING_EVIDENCE_COVERAGE_DEADLINE_MS = 120_000;

interface MutableSourceTotals {
	eligible: number;
	fullyReviewed: number;
	partiallyReviewed: number;
	neverDelivered: number;
}

interface MutableCharTotals {
	eligible: number;
	reviewed: number;
	unreviewed: number;
	consumedWithoutReview: number;
	delivered: number;
	redelivered: number;
	consumedByCursorBasis: Record<string, number>;
	stalledRows: number;
}

interface Accumulator {
	readonly sources: MutableSourceTotals;
	readonly chars: MutableCharTotals;
}

type CoveragePageCursor = DbOwnerDreamingEvidenceCoverageCursor;

type CoverageEntryClassificationInput = DbOwnerDreamingEvidenceCoverageEntryInput;

interface WalkEntry {
	readonly kind: EpisodicSourceKind;
	readonly id: string;
	readonly capturedAt: string;
	readonly entryId: string;
	readonly revision: string;
	readonly length: number;
	deliveredChars: number;
	deliveredRanges: Array<readonly [number, number]>;
}

type DreamingEvidenceCoverageStepRequest = DbOwnerDreamingEvidenceCoverage;
type DreamingEvidenceCoverageStepResult = DbOwnerDreamingEvidenceCoverageResult;

type CoverageDeliveryRow = DbOwnerDreamingEvidenceCoverageDeliveryRow;

export function dreamedFraction(reviewedChars: number, eligibleChars: number): number | null {
	if (!(Number.isSafeInteger(reviewedChars) && reviewedChars >= 0)) return null;
	if (!(Number.isSafeInteger(eligibleChars) && eligibleChars >= 0)) return null;
	if (eligibleChars === 0) return null;
	return reviewedChars / eligibleChars;
}

function emptyAccumulator(): Accumulator {
	return {
		sources: { eligible: 0, fullyReviewed: 0, partiallyReviewed: 0, neverDelivered: 0 },
		chars: {
			eligible: 0,
			reviewed: 0,
			unreviewed: 0,
			consumedWithoutReview: 0,
			delivered: 0,
			redelivered: 0,
			consumedByCursorBasis: {},
			stalledRows: 0,
		},
	};
}

function addAccumulator(total: Accumulator, part: Accumulator): void {
	for (const key of Object.keys(total.sources) as Array<keyof MutableSourceTotals>) {
		total.sources[key] += part.sources[key];
	}
	for (const key of Object.keys(total.chars) as Array<keyof MutableCharTotals>) {
		if (key === "consumedByCursorBasis") continue;
		total.chars[key] += part.chars[key];
	}
	for (const [basis, chars] of Object.entries(part.chars.consumedByCursorBasis)) {
		total.chars.consumedByCursorBasis[basis] = (total.chars.consumedByCursorBasis[basis] ?? 0) + chars;
	}
}

function coveredChars(ranges: ReadonlyArray<readonly [number, number]>, length: number): number {
	const sorted = [...ranges].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
	let covered = 0;
	let end = 0;
	for (const [start, rangeEnd] of sorted) {
		const from = Math.max(0, Math.min(start, length));
		const to = Math.max(from, Math.min(rangeEnd, length));
		if (to <= end) continue;
		covered += to - Math.max(from, end);
		end = to;
	}
	return covered;
}

function classifyEntry(db: ReadDb, agentId: string, entry: CoverageEntryClassificationInput): Accumulator {
	const result = emptyAccumulator();
	const cursor: DreamingEvidenceCursor = evidenceCursorForSource(db, agentId, evidenceCursorSource(entry));
	const reviewRow = hasDreamingEvidenceReviewRow(
		db,
		agentId,
		entry.kind,
		entry.id,
		entry.capturedAt,
		entry.entryId,
		entry.revision,
	);
	const reviewBased = reviewRow || cursor.cursorBasis === "review";
	const reviewedChars = reviewBased ? Math.min(cursor.offset, entry.length) : 0;
	const basisChars = Math.min(cursor.offset, entry.length);
	const covered = coveredChars(entry.deliveredRanges, entry.length);
	result.sources.eligible = 1;
	result.chars.eligible = entry.length;
	result.chars.reviewed = reviewedChars;
	result.chars.unreviewed = entry.length - reviewedChars;
	result.chars.consumedWithoutReview = reviewBased ? 0 : basisChars;
	result.chars.delivered = entry.deliveredRanges.reduce((sum, [start, end]) => {
		const from = Math.max(0, Math.min(start, entry.length));
		const to = Math.max(from, Math.min(end, entry.length));
		return sum + (to - from);
	}, 0);
	result.chars.redelivered = Math.max(0, result.chars.delivered - covered);
	if (cursor.cursorBasis !== null) result.chars.consumedByCursorBasis[cursor.cursorBasis] = basisChars;
	if (cursor.stalledPasses > 0) result.chars.stalledRows = 1;
	if (reviewedChars >= entry.length) result.sources.fullyReviewed = 1;
	else if (reviewedChars > 0) result.sources.partiallyReviewed = 1;
	else if (result.chars.delivered === 0 && cursor.offset === 0) result.sources.neverDelivered = 1;
	return result;
}

function evidenceCursorSource(entry: CoverageEntryClassificationInput): EpisodicSourceRecord {
	return {
		kind: entry.kind,
		id: entry.id,
		capturedAt: entry.capturedAt,
		sourceEntryId: entry.entryId,
		sourceRevision: entry.revision,
		content: "",
		sourceKind: "",
		sourceId: entry.id,
		sourcePath: null,
		project: null,
		harness: null,
		evidenceMeta: null,
		completed: true,
	};
}

export function scanDreamingEvidenceCoverageStep(
	db: ReadDb,
	request: DreamingEvidenceCoverageStepRequest,
): DreamingEvidenceCoverageStepResult {
	if (request.step === "sources") {
		const page = readRecentEpisodicSources(
			db,
			request.agentId,
			request.limit,
			DREAMING_EVIDENCE_KINDS,
			null,
			"oldest",
			request.cursor,
		);
		const entries = page
			.map((source) => {
				const length = renderDreamingEvidence(source).length;
				return {
					kind: source.kind,
					id: source.id,
					capturedAt: source.capturedAt,
					entryId: source.sourceEntryId ?? "",
					revision: source.sourceRevision ?? source.capturedAt,
					length,
				};
			})
			.filter((entry) => entry.length > 0);
		const last = page[page.length - 1];
		return {
			step: "sources",
			entries,
			seen: page.length,
			cursor: last ? { capturedAt: last.capturedAt, kind: last.kind, id: last.id } : null,
			exhausted: page.length < request.limit,
		};
	}
	if (request.step === "passes") {
		const passIds = readDreamingEvidencePassesPage(
			db,
			request.agentId,
			request.afterCreatedAt,
			request.afterPassId,
			request.limit,
		);
		const deliveries: CoverageDeliveryRow[] = [];
		for (const pass of passIds) {
			for (const delivery of persistedEvidenceDeliveries(db, pass.id)) {
				if (delivery.agentId !== request.agentId) continue;
				deliveries.push({
					kind: delivery.kind,
					id: delivery.id,
					capturedAt: delivery.capturedAt,
					sourceEntryId: delivery.sourceEntryId,
					sourceRevision: delivery.sourceRevision,
					start: delivery.start,
					end: delivery.end,
				});
			}
		}
		const last = passIds[passIds.length - 1];
		return {
			step: "passes",
			deliveries,
			afterCreatedAt: last ? last.createdAt : request.afterCreatedAt,
			afterPassId: last ? last.id : request.afterPassId,
			seen: passIds.length,
			exhausted: passIds.length < request.limit,
		};
	}
	if (request.step === "classify") {
		const delta = emptyAccumulator();
		const byKind: Record<string, Accumulator> = {};
		for (const entry of request.entries) {
			const part = classifyEntry(db, request.agentId, entry);
			addAccumulator(delta, part);
			const kindDelta = (byKind[entry.kind] ??= emptyAccumulator());
			addAccumulator(kindDelta, part);
		}
		return { step: "classify", delta, byKind };
	}
	if (request.step === "count") {
		const count = countEpisodicDreamingEvidenceSources(db, request.agentId, DREAMING_EVIDENCE_KINDS, request.bound);
		return { step: "count", eligible: count.bounded ? count.eligible : null };
	}
	const continuations = pendingDreamingEvidenceContinuations(db, request.agentId, request.continuationsLimit);
	let openStalledAttention = 0;
	let afterAttentionId = request.afterAttentionId;
	let attentionTruncated = false;
	const rows = readStalledEvidenceAttentionIds(db, request.agentId, afterAttentionId, request.attentionLimit);
	openStalledAttention += rows.length;
	if (rows.length >= request.attentionLimit) attentionTruncated = true;
	if (rows.length > 0) afterAttentionId = rows[rows.length - 1] ?? request.afterAttentionId;
	return {
		step: "tails",
		pendingContinuations: continuations.length,
		continuationsTruncated: continuations.length >= request.continuationsLimit,
		openStalledAttention,
		attentionTruncated,
		exhausted: !attentionTruncated,
		afterAttentionId,
	};
}

class DreamingEvidenceCoverageWalk {
	readonly entries = new Map<string, WalkEntry>();
	sourceCursor: CoveragePageCursor | null = null;
	private lastSourceLimit = 0;
	sourcesDone = false;
	countDone = false;
	scannedSources = 0;
	passCreatedAt = "";
	passId = "";
	passesDone = false;
	scannedPasses = 0;
	readonly classifyQueue: string[] = [];
	classifyDone = false;
	tailsAfterAttentionId = "";
	tailsDone = false;
	pendingContinuations = 0;
	openStalledAttention = 0;
	readonly totals: Accumulator = emptyAccumulator();
	readonly byKind = new Map<EpisodicSourceKind, Accumulator>(
		DREAMING_EVIDENCE_KINDS.map((kind) => [kind, emptyAccumulator()]),
	);
	incomplete: string | null = null;

	constructor(
		readonly agentId: string,
		readonly bounds: DreamingEvidenceCoverageBounds,
		private readonly startedAt: number,
	) {}

	nextStep(): DreamingEvidenceCoverageStepRequest | null {
		if (!this.sourcesDone) {
			const budget = this.bounds.maxSources - this.scannedSources;
			if (budget <= 0) {
				this.sourcesDone = true;
				this.passesDone = true;
				return this.nextStep();
			}
			return {
				step: "sources",
				agentId: this.agentId,
				cursor: this.sourceCursor,
				limit: (this.lastSourceLimit = Math.min(SOURCE_PAGE_ROWS, budget)),
			};
		}
		if (!this.passesDone) {
			const budget = this.bounds.maxPasses - this.scannedPasses;
			if (budget <= 0) {
				this.passesDone = true;
				this.incomplete ??= "pass-budget";
				return this.nextStep();
			}
			return {
				step: "passes",
				agentId: this.agentId,
				afterCreatedAt: this.passCreatedAt,
				afterPassId: this.passId,
				limit: Math.min(PASS_PAGE_ROWS, budget),
			};
		}
		if (!this.classifyDone) {
			const chunk = this.classifyQueue
				.slice(0, CLASSIFY_CHUNK_ROWS)
				.map((key) => {
					const entry = this.entries.get(key);
					return entry === undefined ? null : this.entryInput(entry);
				})
				.filter((entry) => entry !== null);
			return { step: "classify", agentId: this.agentId, entries: chunk };
		}
		if (!this.tailsDone) {
			return {
				step: "tails",
				agentId: this.agentId,
				afterAttentionId: this.tailsAfterAttentionId,
				attentionLimit: ATTENTION_PAGE_ROWS,
				continuationsLimit: CONTINUATIONS_LIMIT,
			};
		}
		if (!this.countDone) {
			return { step: "count", agentId: this.agentId, bound: this.bounds.maxSources };
		}
		return null;
	}

	apply(result: DreamingEvidenceCoverageStepResult): void {
		if (result.step === "count") {
			this.applyCount(result);
			return;
		}
		if (result.step === "sources") {
			let pageBytes = 0;
			for (const entry of result.entries) {
				pageBytes += JSON.stringify(entry).length;
				if (pageBytes > SOURCE_PAGE_RESULT_BYTE_BUDGET) {
					this.incomplete ??= "sources-result-budget";
					break;
				}
				const key = `${entry.kind}\u0000${entry.id}`;
				if (this.entries.has(key)) continue;
				this.entries.set(key, {
					kind: entry.kind,
					id: entry.id,
					capturedAt: entry.capturedAt,
					entryId: entry.entryId,
					revision: entry.revision,
					length: entry.length,
					deliveredChars: 0,
					deliveredRanges: [],
				});
				this.classifyQueue.push(key);
			}
			this.scannedSources += result.seen;
			this.sourceCursor = result.cursor;
			if (result.exhausted) this.sourcesDone = true;
			return;
		}
		if (result.step === "passes") {
			for (const delivery of result.deliveries) {
				const entry = this.entries.get(`${delivery.kind}\u0000${delivery.id}`);
				if (entry === undefined) continue;
				if (
					delivery.capturedAt !== entry.capturedAt ||
					delivery.sourceEntryId !== entry.entryId ||
					delivery.sourceRevision !== entry.revision
				) {
					continue;
				}
				const start = Math.max(0, Math.min(delivery.start, entry.length));
				const end = Math.max(start, Math.min(delivery.end, entry.length));
				if (end <= start) continue;
				entry.deliveredChars += end - start;
				entry.deliveredRanges.push([start, end]);
				if (entry.deliveredRanges.length > MAX_DELIVERY_RANGES_PER_ENTRY) {
					entry.deliveredRanges = entry.deliveredRanges.slice(-MAX_DELIVERY_RANGES_PER_ENTRY);
					this.incomplete ??= "delivery-ranges";
				}
			}
			this.scannedPasses += result.seen;
			this.passCreatedAt = result.afterCreatedAt;
			this.passId = result.afterPassId;
			if (result.exhausted) this.passesDone = true;
			return;
		}
		if (result.step === "classify") {
			for (let i = 0; i < CLASSIFY_CHUNK_ROWS && this.classifyQueue.length > 0; i += 1) {
				this.classifyQueue.shift();
			}
			addAccumulator(this.totals, result.delta);
			for (const [kind, part] of Object.entries(result.byKind)) {
				const kindTotals = this.byKind.get(kind as EpisodicSourceKind) ?? emptyAccumulator();
				addAccumulator(kindTotals, part);
				this.byKind.set(kind as EpisodicSourceKind, kindTotals);
			}
			if (this.classifyQueue.length === 0) this.classifyDone = true;
			return;
		}
		this.pendingContinuations = result.pendingContinuations;
		this.openStalledAttention += result.openStalledAttention;
		this.tailsAfterAttentionId = result.afterAttentionId;
		if (result.exhausted) this.tailsDone = true;
		if (result.continuationsTruncated) this.incomplete ??= "continuations-truncated";
		return;
	}

	applyCount(result: Extract<DreamingEvidenceCoverageStepResult, { step: "count" }>): void {
		this.countDone = true;
		if (result.eligible === null) this.incomplete ??= "count-unbounded";
		else if (result.eligible !== this.entries.size) this.incomplete ??= "source-drift";
	}

	entryInput(entry: WalkEntry): CoverageEntryClassificationInput {
		return {
			kind: entry.kind,
			id: entry.id,
			capturedAt: entry.capturedAt,
			entryId: entry.entryId,
			revision: entry.revision,
			length: entry.length,
			deliveredRanges: entry.deliveredRanges,
		};
	}

	deadlineExceeded(): boolean {
		return Date.now() - this.startedAt >= this.bounds.deadlineMs;
	}

	done(): boolean {
		return this.sourcesDone && this.passesDone && this.classifyDone && this.tailsDone && this.countDone;
	}

	snapshot(): DreamingEvidenceCoverage {
		const redeliveryRatio =
			this.totals.chars.delivered > 0 ? this.totals.chars.redelivered / this.totals.chars.delivered : 0;
		return {
			agentId: this.agentId,
			sources: this.totals.sources,
			chars: this.totals.chars,
			dreamedFraction: dreamedFraction(this.totals.chars.reviewed, this.totals.chars.eligible),
			redeliveryRatio,
			pendingContinuations: this.pendingContinuations,
			openStalledAttention: this.openStalledAttention,
			scanComplete: this.incomplete === null,
			fullyReviewed:
				this.incomplete === null &&
				this.totals.chars.eligible > 0 &&
				this.totals.chars.unreviewed === 0 &&
				this.totals.chars.consumedWithoutReview === 0,
			byKind: Object.fromEntries(
				DREAMING_EVIDENCE_KINDS.map((kind) => {
					const kindTotals = this.byKind.get(kind) ?? emptyAccumulator();
					return [kind, { sources: kindTotals.sources, chars: kindTotals.chars }];
				}),
			),
		};
	}
}

export function scanDreamingEvidenceCoverage(
	db: ReadDb,
	agentId: string,
	bounds: DreamingEvidenceCoverageBounds,
): DreamingEvidenceCoverage {
	const walk = new DreamingEvidenceCoverageWalk(agentId, bounds, Date.now());
	for (;;) {
		const step = walk.nextStep();
		if (step === null) break;
		walk.apply(scanDreamingEvidenceCoverageStep(db, step));
	}
	return walk.snapshot();
}

export function getDreamingEvidenceCoverageInDb(
	db: ReadDb,
	agentId: string,
	bounds: DreamingEvidenceCoverageBounds,
): DreamingEvidenceCoverage {
	return scanDreamingEvidenceCoverage(db, agentId, bounds);
}

export async function getDreamingEvidenceCoverage(
	accessor: DbAccessor,
	agentId: string,
): Promise<DreamingEvidenceCoverage> {
	const bounds: DreamingEvidenceCoverageBounds = {
		maxSources: DREAMING_EVIDENCE_COVERAGE_MAX_SOURCES,
		maxPasses: DREAMING_EVIDENCE_COVERAGE_MAX_PASSES,
		deadlineMs: DREAMING_EVIDENCE_COVERAGE_DEADLINE_MS,
	};
	const walk = new DreamingEvidenceCoverageWalk(agentId, bounds, Date.now());
	for (;;) {
		const step = walk.nextStep();
		if (step === null) break;
		if (walk.deadlineExceeded()) {
			walk.incomplete ??= "deadline";
			break;
		}
		const result = await runDbOwnerDomainOperation(accessor, {
			runWithOwner: async (owner) =>
				await dbOwnerDreamingEvidenceCoverage(owner, { ...step, agentId: walk.agentId }, COVERAGE_OWNER_OPTIONS),
			runInline: ({ read }) => read((db) => scanDreamingEvidenceCoverageStep(db, { ...step, agentId: walk.agentId })),
		});
		walk.apply(result);
	}
	return walk.snapshot();
}

const COVERAGE_OWNER_OPTIONS = {
	operation: "dreaming.evidence-coverage",
	lane: "read",
	workloadClass: "foreground",
	deadlineMs: 30_000,
	estimatedWorkUnits: 10,
} as const;
