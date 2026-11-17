import type { DbAccessor, ReadDb } from "../db-accessor";
import { type EpisodicSourceKind, type EpisodicSourceRecord, readRecentEpisodicSources } from "../episodic-sources";
import { dbOwnerDreamingEvidenceCoverage, runDbOwnerDomainOperation } from "../db-owner-runtime";
import { renderDreamingEvidence } from "./dreaming-evidence";
import {
	type DreamingEvidenceCursor,
	STALLED_EVIDENCE_ATTENTION_SQL,
	evidenceCursorForSource,
	pendingDreamingEvidenceContinuations,
	persistedEvidenceDeliveries,
} from "./dreaming-evidence-consumption";
import { DREAMING_EVIDENCE_KINDS } from "./dreaming";

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
	readonly complete: boolean;
	readonly byKind: Readonly<Record<string, DreamingEvidenceCoverageKindBreakdown>>;
}

export interface DreamingEvidenceCoverageBounds {
	readonly maxSources: number;
	readonly maxPasses: number;
}

export const DREAMING_EVIDENCE_COVERAGE_MAX_SOURCES = 2_000;
export const DREAMING_EVIDENCE_COVERAGE_MAX_PASSES = 500;

const SOURCE_PAGE_ROWS = 100;
const PASS_PAGE_ROWS = 100;
const CONTINUATIONS_LIMIT = 50;
const ATTENTION_PAGE_ROWS = 200;
const ATTENTION_MAX_PAGES = 10;

interface SourceEntry {
	readonly source: EpisodicSourceRecord;
	readonly length: number;
	readonly capturedAt: string;
	readonly entryId: string;
	readonly revision: string;
	deliveredChars: number;
	deliveredRanges: Array<readonly [number, number]>;
}

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

interface CoveragePageCursor {
	readonly capturedAt: string;
	readonly kind: EpisodicSourceKind;
	readonly id: string;
}

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
	total.sources.eligible += part.sources.eligible;
	total.sources.fullyReviewed += part.sources.fullyReviewed;
	total.sources.partiallyReviewed += part.sources.partiallyReviewed;
	total.sources.neverDelivered += part.sources.neverDelivered;
	total.chars.eligible += part.chars.eligible;
	total.chars.reviewed += part.chars.reviewed;
	total.chars.unreviewed += part.chars.unreviewed;
	total.chars.consumedWithoutReview += part.chars.consumedWithoutReview;
	total.chars.delivered += part.chars.delivered;
	total.chars.redelivered += part.chars.redelivered;
	total.chars.stalledRows += part.chars.stalledRows;
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

function hasReviewRow(db: ReadDb, agentId: string, entry: SourceEntry): boolean {
	return (
		db
			.prepare(
				`SELECT 1 FROM dreaming_evidence_reviews
		 WHERE agent_id = ? AND source_kind = ? AND source_id = ? AND source_captured_at = ? AND source_entry_id = ? AND source_revision = ?`,
			)
			.get(agentId, entry.source.kind, entry.source.id, entry.capturedAt, entry.entryId, entry.revision) != null
	);
}

function classifyEntry(db: ReadDb, agentId: string, entry: SourceEntry): Accumulator {
	const result = emptyAccumulator();
	const cursor: DreamingEvidenceCursor = evidenceCursorForSource(db, agentId, entry.source);
	const reviewRow = hasReviewRow(db, agentId, entry);
	const reviewBased = reviewRow || cursor.cursorBasis === "review";
	const reviewedChars = reviewBased ? Math.min(cursor.offset, entry.length) : 0;
	const basisChars = Math.min(cursor.offset, entry.length);
	const covered = coveredChars(entry.deliveredRanges, entry.length);
	result.sources.eligible = 1;
	result.chars.eligible = entry.length;
	result.chars.reviewed = reviewedChars;
	result.chars.unreviewed = entry.length - reviewedChars;
	result.chars.consumedWithoutReview = reviewBased ? 0 : basisChars;
	result.chars.delivered = entry.deliveredChars;
	result.chars.redelivered = Math.max(0, entry.deliveredChars - covered);
	if (cursor.cursorBasis !== null) result.chars.consumedByCursorBasis[cursor.cursorBasis] = basisChars;
	if (cursor.stalledPasses > 0) result.chars.stalledRows = 1;
	if (reviewedChars >= entry.length) result.sources.fullyReviewed = 1;
	else if (reviewedChars > 0) result.sources.partiallyReviewed = 1;
	else if (entry.deliveredChars === 0 && cursor.offset === 0) result.sources.neverDelivered = 1;
	return result;
}

function readEligibleSources(
	db: ReadDb,
	agentId: string,
	cursor: CoveragePageCursor | null,
	limit: number,
): readonly EpisodicSourceRecord[] {
	return readRecentEpisodicSources(db, agentId, limit, DREAMING_EVIDENCE_KINDS, null, "oldest", cursor);
}

export function getDreamingEvidenceCoverageInDb(
	db: ReadDb,
	agentId: string,
	bounds: DreamingEvidenceCoverageBounds,
): DreamingEvidenceCoverage {
	const totals = emptyAccumulator();
	const byKind = new Map<string, Accumulator>(DREAMING_EVIDENCE_KINDS.map((kind) => [kind, emptyAccumulator()]));
	const entries = new Map<string, SourceEntry>();
	let complete = true;
	let scanned = 0;
	let pageCursor: CoveragePageCursor | null = null;
	for (;;) {
		const budget = Math.min(SOURCE_PAGE_ROWS, bounds.maxSources - scanned);
		if (budget <= 0) {
			if (readEligibleSources(db, agentId, pageCursor, 1).length > 0) complete = false;
			break;
		}
		const page = readEligibleSources(db, agentId, pageCursor, budget);
		for (const source of page) {
			const length = renderDreamingEvidence(source).length;
			if (length <= 0) continue;
			entries.set(`${source.kind}\u0000${source.id}`, {
				source,
				length,
				capturedAt: source.capturedAt,
				entryId: source.sourceEntryId ?? "",
				revision: source.sourceRevision ?? source.capturedAt,
				deliveredChars: 0,
				deliveredRanges: [],
			});
		}
		scanned += page.length;
		if (page.length < budget) break;
		const last = page[page.length - 1];
		pageCursor = { capturedAt: last.capturedAt, kind: last.kind, id: last.id };
	}
	let passBudget = bounds.maxPasses;
	let afterPassId = "";
	for (;;) {
		const passBudgetPage = Math.min(PASS_PAGE_ROWS, passBudget);
		if (passBudgetPage <= 0) {
			if (db.prepare("SELECT 1 FROM dreaming_passes WHERE agent_id = ? AND id > ? LIMIT 1").get(agentId, afterPassId))
				complete = false;
			break;
		}
		const passIds = db
			.prepare("SELECT id FROM dreaming_passes WHERE agent_id = ? AND id > ? ORDER BY id ASC LIMIT ?")
			.all(agentId, afterPassId, passBudgetPage) as Array<{ id: string }>;
		if (passIds.length === 0) break;
		for (const { id } of passIds) {
			for (const delivery of persistedEvidenceDeliveries(db, id)) {
				if (delivery.agentId !== agentId) continue;
				const entry = entries.get(`${delivery.kind}\u0000${delivery.id}`);
				if (entry === undefined) continue;
				if (
					delivery.capturedAt !== entry.capturedAt ||
					delivery.sourceEntryId !== entry.entryId ||
					delivery.sourceRevision !== entry.revision
				)
					continue;
				entry.deliveredChars += delivery.end - delivery.start;
				entry.deliveredRanges.push([delivery.start, delivery.end]);
			}
		}
		passBudget -= passIds.length;
		afterPassId = passIds[passIds.length - 1].id;
		if (passIds.length < passBudgetPage) break;
	}
	for (const entry of entries.values()) {
		const part = classifyEntry(db, agentId, entry);
		addAccumulator(totals, part);
		const kindTotals = byKind.get(entry.source.kind);
		if (kindTotals !== undefined) addAccumulator(kindTotals, part);
	}
	const continuations = pendingDreamingEvidenceContinuations(db, agentId, CONTINUATIONS_LIMIT);
	if (continuations.length >= CONTINUATIONS_LIMIT) complete = false;
	let openStalledAttention = 0;
	let afterAttentionId = "";
	for (let page = 0; page < ATTENTION_MAX_PAGES; page += 1) {
		const rows = db
			.prepare(
				`SELECT id FROM dreaming_attention
		 WHERE agent_id = ? AND resolved_at IS NULL AND ${STALLED_EVIDENCE_ATTENTION_SQL} AND id > ?
		 ORDER BY id ASC LIMIT ?`,
			)
			.all(agentId, afterAttentionId, ATTENTION_PAGE_ROWS) as Array<{ id: string }>;
		openStalledAttention += rows.length;
		if (rows.length < ATTENTION_PAGE_ROWS) break;
		afterAttentionId = rows[rows.length - 1].id;
		if (page === ATTENTION_MAX_PAGES - 1) complete = false;
	}
	const redeliveryRatio = totals.chars.delivered > 0 ? totals.chars.redelivered / totals.chars.delivered : 0;
	return {
		agentId,
		sources: totals.sources,
		chars: totals.chars,
		dreamedFraction: dreamedFraction(totals.chars.reviewed, totals.chars.eligible),
		redeliveryRatio,
		pendingContinuations: continuations.length,
		openStalledAttention,
		complete,
		byKind: Object.fromEntries(
			DREAMING_EVIDENCE_KINDS.map((kind) => {
				const kindTotals = byKind.get(kind) ?? emptyAccumulator();
				return [kind, { sources: kindTotals.sources, chars: kindTotals.chars }];
			}),
		),
	};
}

const COVERAGE_OWNER_OPTIONS = {
	operation: "dreaming.evidence-coverage",
	lane: "read",
	workloadClass: "foreground",
	deadlineMs: 30_000,
	estimatedWorkUnits: 500,
} as const;

export async function getDreamingEvidenceCoverage(
	accessor: DbAccessor,
	agentId: string,
): Promise<DreamingEvidenceCoverage> {
	const input = {
		agentId,
		maxSources: DREAMING_EVIDENCE_COVERAGE_MAX_SOURCES,
		maxPasses: DREAMING_EVIDENCE_COVERAGE_MAX_PASSES,
	};
	return await runDbOwnerDomainOperation(accessor, {
		runWithOwner: async (owner) => await dbOwnerDreamingEvidenceCoverage(owner, input, COVERAGE_OWNER_OPTIONS),
		runInline: ({ read }) => read((db) => getDreamingEvidenceCoverageInDb(db, agentId, input)),
	});
}
