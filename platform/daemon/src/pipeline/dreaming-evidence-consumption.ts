import { createHash, randomUUID } from "node:crypto";
import type { ReadDb, WriteDb } from "../db-accessor";
import { type EpisodicSourceKind, type EpisodicSourceRecord, readEpisodicSource } from "../episodic-sources";
import { renderDreamingEvidence } from "./dreaming-evidence";
import { DREAMING_ATTENTION_OPERATIONS } from "./dreaming-operation-contract";

export interface DreamingEvidenceDelivery {
	readonly agentId: string;
	readonly kind: EpisodicSourceKind;
	readonly id: string;
	readonly capturedAt: string;
	readonly sourceEntryId: string;
	readonly sourceRevision: string;
	readonly start: number;
	readonly end: number;
	readonly length: number;
	readonly contentSha256: string;
	readonly queue: boolean;
}

export const DREAMING_EVIDENCE_STALL_PASSES = 3;

export function evidenceContentSha256(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

function tableExists(db: ReadDb, table: string): boolean {
	return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) != null;
}

function tableHasColumn(db: ReadDb, table: string, column: string): boolean {
	try {
		const rows = db.prepare(`PRAGMA table_info(${table})`).all() as ReadonlyArray<Record<string, unknown>>;
		return rows.some((row) => row.name === column);
	} catch {
		return false;
	}
}

function record(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function text(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

function sourceIdentity(source: EpisodicSourceRecord): string {
	return source.sourceEntryId ?? "";
}

function sourceRevision(source: EpisodicSourceRecord): string {
	return source.sourceRevision ?? source.capturedAt;
}

function sourceRef(value: string): { readonly kind: EpisodicSourceKind; readonly id: string } | null {
	const separator = value.indexOf(":");
	if (separator <= 0) return null;
	const kind = value.slice(0, separator);
	const id = value.slice(separator + 1);
	if (!id || !["memory", "artifact", "transcript", "summary"].includes(kind)) return null;
	return { kind: kind as EpisodicSourceKind, id };
}
export function persistedEvidenceDeliveries(db: ReadDb, passId: string): readonly DreamingEvidenceDelivery[] {
	if (!tableExists(db, "dreaming_tool_calls")) return [];
	const rows = db
		.prepare(
			`SELECT input_json AS inputJson, output_json AS outputJson
			 FROM dreaming_tool_calls
			 WHERE pass_id = ? AND tool_name = 'search_evidence' ORDER BY sequence ASC`,
		)
		.all(passId) as Array<{ inputJson: string; outputJson: string }>;
	return rows.flatMap(({ inputJson, outputJson }) => {
		let input: unknown;
		let output: unknown;
		try {
			input = JSON.parse(inputJson);
			output = JSON.parse(outputJson);
		} catch {
			return [];
		}
		const request = record(input);
		const agentId = text(request?.agentId);
		const data = record(output);
		if (!agentId || data?.ok !== true || !Array.isArray(data.items)) return [];
		const queue =
			(typeof request?.query !== "string" || request.query.trim() === "") &&
			request?.since === undefined &&
			request?.before === undefined &&
			request?.sourceRef === undefined;
		return data.items.flatMap((item) => {
			const row = record(item);
			const ref = text(row?.sourceRef);
			const parsed = ref ? sourceRef(ref) : null;
			const capturedAt = text(row?.capturedAt);
			const sourceRevision = text(row?.sourceRevision);
			const sourceEntryId = typeof row?.sourceEntryId === "string" ? row.sourceEntryId : "";
			const start =
				typeof row?.contentOffset === "number" && Number.isSafeInteger(row.contentOffset) ? row.contentOffset : null;
			const content = text(row?.content);
			const compactChars =
				typeof row?.contentChars === "number" && Number.isSafeInteger(row.contentChars) ? row.contentChars : null;
			const compactSha256 = text(row?.contentSha256);
			const delivered =
				content !== null
					? { chars: content.length, sha256: evidenceContentSha256(content) }
					: compactChars !== null && compactChars > 0 && compactSha256 !== null
						? { chars: compactChars, sha256: compactSha256 }
						: null;
			const length =
				typeof row?.contentLength === "number" && Number.isSafeInteger(row.contentLength) ? row.contentLength : null;
			if (
				!parsed ||
				!capturedAt ||
				!sourceRevision ||
				start === null ||
				delivered === null ||
				length === null ||
				start < 0 ||
				length < start
			)
				return [];
			const end = start + delivered.chars;
			if (end > length) return [];
			return [
				{
					agentId,
					kind: parsed.kind,
					id: parsed.id,
					capturedAt,
					sourceEntryId,
					sourceRevision,
					start,
					end,
					length,
					contentSha256: delivered.sha256,
					queue,
				},
			];
		});
	});
}

export function passDeliveredRanges(
	db: ReadDb,
	passId: string,
	agentId: string,
): ReadonlyMap<string, ReadonlyArray<readonly [number, number]>> {
	const ranges = new Map<string, Array<readonly [number, number]>>();
	for (const delivery of persistedEvidenceDeliveries(db, passId)) {
		if (delivery.agentId !== agentId) continue;
		const ref = `${delivery.kind}:${delivery.id}`;
		ranges.set(ref, [...(ranges.get(ref) ?? []), [delivery.start, delivery.end] as const]);
	}
	return ranges;
}

export function passFullyServedSourceRefs(db: ReadDb, passId: string, agentId: string): string[] {
	const coverage = new Map<string, { ranges: Array<readonly [number, number]>; length: number }>();
	for (const delivery of persistedEvidenceDeliveries(db, passId)) {
		if (delivery.agentId !== agentId) continue;
		const ref = `${delivery.kind}:${delivery.id}`;
		const entry = coverage.get(ref) ?? { ranges: [], length: delivery.length };
		entry.ranges.push([delivery.start, delivery.end]);
		coverage.set(ref, entry);
	}
	return [...coverage].flatMap(([ref, { ranges, length }]) => {
		const first = Math.min(...ranges.map(([start]) => start));
		return extendDeliveredOffset(first, ranges) >= length ? [ref] : [];
	});
}

export function extendDeliveredOffset(
	baseline: number,
	ranges: ReadonlyArray<readonly [number, number]> | undefined,
): number {
	let offset = baseline;
	for (const [start, end] of [...(ranges ?? [])].sort((a, b) => a[0] - b[0])) {
		if (start > offset) break;
		offset = Math.max(offset, end);
	}
	return offset;
}

export interface FiledEvidenceCitation {
	readonly key: string;
	readonly quote: string;
}

export interface FailedOperationEvidence {
	readonly sources: ReadonlySet<string>;
	readonly scopes: ReadonlySet<string>;
	readonly filedSources: ReadonlySet<string>;
	readonly filedCitations: readonly FiledEvidenceCitation[];
}

export function failedOperationEvidence(
	db: ReadDb,
	passId: string,
	passAgentId: string,
	passScopes: readonly string[],
): FailedOperationEvidence {
	const keys = new Set<string>();
	const scopes = new Set<string>();
	const filed = new Set<string>();
	const filedQuotes = new Set<string>();
	const filedCitations: FiledEvidenceCitation[] = [];
	const failedQuotes: Array<{ readonly key: string; readonly quote: string }> = [];
	if (!tableExists(db, "dreaming_tool_calls")) return { sources: keys, scopes, filedSources: filed, filedCitations };
	const rows = db
		.prepare(
			`SELECT input_json AS inputJson, output_json AS outputJson
			 FROM dreaming_tool_calls
			 WHERE pass_id = ? AND tool_name = 'apply_ontology_ops' ORDER BY sequence ASC`,
		)
		.all(passId) as Array<{ inputJson: string; outputJson: string }>;
	for (const { inputJson, outputJson } of rows) {
		let input: Record<string, unknown> | null;
		let output: Record<string, unknown> | null;
		try {
			input = record(JSON.parse(inputJson));
			output = record(JSON.parse(outputJson));
		} catch {
			for (const scope of passScopes) scopes.add(scope);
			continue;
		}
		const agentId = text(input?.agentId) ?? passAgentId;
		const operations = Array.isArray(input?.operations) ? input.operations : [];
		if (output?.ok !== true && operations.length === 0) {
			scopes.add(agentId);
			continue;
		}
		const citations = (index: number): Array<{ readonly key: string; readonly quote: string }> => {
			const evidence = record(operations[index])?.evidence;
			return (Array.isArray(evidence) ? evidence : []).flatMap((citation) => {
				const cited = record(citation);
				const ref = text(cited?.source_ref) ?? text(cited?.sourceRef);
				const parsed = ref ? sourceRef(ref) : null;
				return parsed
					? [{ key: `${agentId}\u0000${parsed.kind}:${parsed.id}`, quote: text(cited?.quote)?.trim() ?? "" }]
					: [];
			});
		};
		if (output?.ok === true && Array.isArray(output.items)) {
			for (const item of output.items) {
				const row = record(item);
				if (row?.ok !== true || typeof row.index !== "number") continue;
				for (const cited of citations(row.index)) {
					filed.add(cited.key);
					filedQuotes.add(`${cited.key}\u0000${cited.quote}`);
					if (cited.quote) filedCitations.push(cited);
				}
			}
		}
		const failedIndexes =
			output?.ok === true && Array.isArray(output.items)
				? output.items.flatMap((item) => {
						const row = record(item);
						return row?.ok === false && typeof row.index === "number" ? [row.index] : [];
					})
				: operations.map((_, index) => index);
		for (const index of failedIndexes) {
			if (DREAMING_ATTENTION_OPERATIONS.has(text(record(operations[index])?.operation) ?? "")) continue;
			const cited = citations(index);
			if (cited.length === 0) scopes.add(agentId);
			failedQuotes.push(...cited);
		}
	}
	for (const { key, quote } of failedQuotes) {
		if (!filedQuotes.has(`${key}\u0000${quote}`)) keys.add(key);
	}
	return { sources: keys, scopes, filedSources: filed, filedCitations };
}

export function verifiedDreamingEvidenceDelivery(
	db: ReadDb,
	delivery: DreamingEvidenceDelivery,
): EpisodicSourceRecord | null {
	const source = readEpisodicSource(db, { agentId: delivery.agentId, from: `${delivery.kind}:${delivery.id}` });
	if (
		source === null ||
		source.kind !== delivery.kind ||
		source.id !== delivery.id ||
		(source.sourceEntryId !== null && source.sourceEntryId !== delivery.sourceEntryId) ||
		source.capturedAt !== delivery.capturedAt ||
		sourceRevision(source) !== delivery.sourceRevision
	)
		return null;
	const rendered = renderDreamingEvidence(source);
	if (
		rendered.length !== delivery.length ||
		delivery.end > rendered.length ||
		evidenceContentSha256(rendered.slice(delivery.start, delivery.end)) !== delivery.contentSha256
	) {
		return null;
	}
	return source;
}
function deliveredExcerpt(db: ReadDb, delivery: DreamingEvidenceDelivery): string | null {
	const source = verifiedDreamingEvidenceDelivery(db, delivery);
	return source === null ? null : renderDreamingEvidence(source).slice(delivery.start, delivery.end);
}

function sameDelivery(a: DreamingEvidenceDelivery, b: DreamingEvidenceDelivery): boolean {
	return (
		a.agentId === b.agentId &&
		a.kind === b.kind &&
		a.id === b.id &&
		a.capturedAt === b.capturedAt &&
		a.sourceEntryId === b.sourceEntryId &&
		a.sourceRevision === b.sourceRevision &&
		a.start === b.start &&
		a.end === b.end &&
		a.length === b.length &&
		a.contentSha256 === b.contentSha256
	);
}

export interface DreamingEvidenceReviewRequest {
	readonly agentId: string;
	readonly passId: string;
	readonly items: ReadonlyArray<{
		readonly sourceRef: string;
		readonly contentOffset: number;
		readonly through?: string;
	}>;
}

export type DreamingEvidenceReviewRejection =
	| "EXCERPT_NOT_DELIVERED"
	| "SCOPE_MISMATCH"
	| "QUOTE_NOT_IN_EXCERPT"
	| "SOURCE_CHANGED";

const REVIEW_REJECTION_ERRORS: Readonly<Record<DreamingEvidenceReviewRejection, string>> = {
	EXCERPT_NOT_DELIVERED:
		"No excerpt with this sourceRef and contentOffset was delivered by search_evidence in this pass; copy both from a search_evidence result",
	SCOPE_MISMATCH:
		"This excerpt was delivered in a different agent scope; acknowledge it with the agentId used for search_evidence",
	QUOTE_NOT_IN_EXCERPT: "through is not an exact quote from this excerpt; copy it character for character",
	SOURCE_CHANGED: "The source changed after this excerpt was delivered; read it again with search_evidence",
};

export function reviewDreamingEvidenceInDb(
	db: ReadDb,
	input: DreamingEvidenceReviewRequest,
): { readonly ok: boolean; readonly [key: string]: unknown } {
	const deliveries = persistedEvidenceDeliveries(db, input.passId);
	const accepted: Record<string, unknown>[] = [];
	const rejected: Array<Record<string, unknown> & { readonly code: DreamingEvidenceReviewRejection }> = [];
	input.items.forEach((item, index) => {
		const parsed = sourceRef(item.sourceRef);
		const sameExcerpt =
			parsed === null
				? []
				: deliveries.filter(
						(delivery) =>
							delivery.kind === parsed.kind && delivery.id === parsed.id && delivery.start === item.contentOffset,
					);
		const inScope = sameExcerpt.filter((delivery) => delivery.agentId === input.agentId).reverse();
		const reject = (code: DreamingEvidenceReviewRejection): void => {
			rejected.push({
				index,
				sourceRef: item.sourceRef,
				contentOffset: item.contentOffset,
				code,
				error: REVIEW_REJECTION_ERRORS[code],
			});
		};
		if (sameExcerpt.length === 0) {
			reject("EXCERPT_NOT_DELIVERED");
			return;
		}
		if (inScope.length === 0) {
			reject("SCOPE_MISMATCH");
			return;
		}
		const quote = item.through?.trim();
		let verified = false;
		for (const delivery of inScope) {
			const excerpt = deliveredExcerpt(db, delivery);
			if (excerpt === null) continue;
			verified = true;
			const at = quote === undefined ? 0 : excerpt.indexOf(quote);
			if (quote !== undefined && (quote.length === 0 || at < 0)) continue;
			accepted.push({
				sourceRef: item.sourceRef,
				contentOffset: delivery.start,
				reviewedThrough: quote === undefined ? delivery.end : delivery.start + at + quote.length,
				excerptEnd: delivery.end,
				contentLength: delivery.length,
				capturedAt: delivery.capturedAt,
				sourceEntryId: delivery.sourceEntryId,
				sourceRevision: delivery.sourceRevision,
				contentSha256: delivery.contentSha256,
			});
			return;
		}
		reject(verified ? "QUOTE_NOT_IN_EXCERPT" : "SOURCE_CHANGED");
	});
	if (rejected.length > 0) {
		return {
			ok: false,
			code: rejected[0]?.code,
			error: `${rejected.length} of ${input.items.length} acknowledgements were rejected and none were recorded; correct them and call review_evidence again`,
			items: rejected,
		};
	}
	return { ok: true, items: accepted };
}

interface ReviewedRange {
	readonly delivery: DreamingEvidenceDelivery;
	readonly end: number;
}

function persistedEvidenceReviews(
	db: ReadDb,
	passId: string,
	deliveries: readonly DreamingEvidenceDelivery[],
): readonly ReviewedRange[] {
	if (!tableExists(db, "dreaming_tool_calls")) return [];
	const rows = db
		.prepare(
			`SELECT input_json AS inputJson, output_json AS outputJson
			 FROM dreaming_tool_calls
			 WHERE pass_id = ? AND tool_name = 'review_evidence' ORDER BY sequence ASC`,
		)
		.all(passId) as Array<{ inputJson: string; outputJson: string }>;
	const integer = (value: unknown): number | null =>
		typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
	return rows.flatMap(({ inputJson, outputJson }) => {
		let input: unknown;
		let output: unknown;
		try {
			input = JSON.parse(inputJson);
			output = JSON.parse(outputJson);
		} catch {
			return [];
		}
		const agentId = text(record(input)?.agentId);
		const data = record(output);
		if (!agentId || data?.ok !== true || !Array.isArray(data.items)) return [];
		return data.items.flatMap((item): ReviewedRange[] => {
			const row = record(item);
			const ref = text(row?.sourceRef);
			const parsed = ref ? sourceRef(ref) : null;
			const capturedAt = text(row?.capturedAt);
			const revision = text(row?.sourceRevision);
			const contentSha256 = text(row?.contentSha256);
			const start = integer(row?.contentOffset);
			const end = integer(row?.reviewedThrough);
			const excerptEnd = integer(row?.excerptEnd);
			const length = integer(row?.contentLength);
			if (
				!parsed ||
				!capturedAt ||
				!revision ||
				!contentSha256 ||
				typeof row?.sourceEntryId !== "string" ||
				start === null ||
				end === null ||
				excerptEnd === null ||
				length === null ||
				start > end ||
				end > excerptEnd ||
				excerptEnd > length
			)
				return [];
			const reviewed: DreamingEvidenceDelivery = {
				agentId,
				kind: parsed.kind,
				id: parsed.id,
				capturedAt,
				sourceEntryId: row.sourceEntryId,
				sourceRevision: revision,
				start,
				end: excerptEnd,
				length,
				contentSha256,
				queue: false,
			};
			const delivery = deliveries.find((candidate) => sameDelivery(candidate, reviewed));
			return delivery === undefined ? [] : [{ delivery, end }];
		});
	});
}

function citationFloors(
	db: ReadDb,
	deliveries: readonly DreamingEvidenceDelivery[],
	citations: readonly FiledEvidenceCitation[],
): readonly ReviewedRange[] {
	const excerpts = new Map<DreamingEvidenceDelivery, string | null>();
	return citations.flatMap(({ key, quote }) =>
		deliveries.flatMap((delivery) => {
			if (`${delivery.agentId}\u0000${delivery.kind}:${delivery.id}` !== key) return [];
			if (!excerpts.has(delivery)) excerpts.set(delivery, deliveredExcerpt(db, delivery));
			const at = excerpts.get(delivery)?.indexOf(quote) ?? -1;
			return at < 0 ? [] : [{ delivery, end: delivery.start + at + quote.length }];
		}),
	);
}

function revisionKey(delivery: DreamingEvidenceDelivery): string {
	return [
		delivery.agentId,
		delivery.kind,
		delivery.id,
		delivery.capturedAt,
		delivery.sourceEntryId,
		delivery.sourceRevision,
	].join("\u0000");
}

export function recordDreamingEvidenceConsumptionInTx(
	db: WriteDb,
	params: {
		readonly passId: string;
		readonly deferredEvidence: ReadonlySet<string>;
		readonly withheldScopes?: ReadonlySet<string>;
		readonly filedSources?: ReadonlySet<string>;
		readonly filedCitations?: readonly FiledEvidenceCitation[];
	},
): void {
	if (!tableExists(db, "dreaming_evidence_consumption")) return;
	const deliveries = persistedEvidenceDeliveries(db, params.passId);
	const revisions = new Map<
		string,
		{ readonly delivery: DreamingEvidenceDelivery; readonly ranges: Array<readonly [number, number]>; queued: boolean }
	>();
	for (const delivery of deliveries) {
		const key = revisionKey(delivery);
		const entry = revisions.get(key) ?? { delivery, ranges: [], queued: false };
		entry.queued ||= delivery.queue;
		revisions.set(key, entry);
	}
	const reviewed = [
		...persistedEvidenceReviews(db, params.passId, deliveries),
		...citationFloors(db, deliveries, params.filedCitations ?? []),
	];
	const progressSuppressed = (delivery: DreamingEvidenceDelivery): boolean => {
		const sourceKey = `${delivery.agentId}\u0000${delivery.kind}:${delivery.id}`;
		if (params.deferredEvidence.has(sourceKey)) return true;
		return params.withheldScopes?.has(delivery.agentId) === true && params.filedSources?.has(sourceKey) !== true;
	};
	for (const { delivery, end } of reviewed) {
		if (progressSuppressed(delivery)) continue;
		if (verifiedDreamingEvidenceDelivery(db, delivery) === null) continue;
		revisions.get(revisionKey(delivery))?.ranges.push([delivery.start, end] as const);
	}
	const select = db.prepare(
		`SELECT delivered_offset AS deliveredOffset, stalled_passes AS stalledPasses FROM dreaming_evidence_consumption
		 WHERE agent_id = ? AND source_kind = ? AND source_id = ? AND source_captured_at = ? AND source_entry_id = ? AND source_revision = ?`,
	);
	const advance = db.prepare(
		`INSERT INTO dreaming_evidence_consumption
		 (agent_id, source_kind, source_id, source_captured_at, source_entry_id, source_revision, delivered_offset, source_length, pass_id, updated_at, cursor_basis, stalled_passes)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), 'review', 0)
		 ON CONFLICT(agent_id, source_kind, source_id, source_captured_at, source_entry_id, source_revision) DO UPDATE SET
		   delivered_offset = excluded.delivered_offset,
		   source_length = excluded.source_length,
		   pass_id = excluded.pass_id,
		   updated_at = excluded.updated_at,
		   cursor_basis = 'review',
		   stalled_passes = 0`,
	);
	const stall = db.prepare(
		`INSERT INTO dreaming_evidence_consumption
		 (agent_id, source_kind, source_id, source_captured_at, source_entry_id, source_revision, delivered_offset, source_length, pass_id, updated_at, cursor_basis, stalled_passes)
		 VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, datetime('now'), 'review', 1)
		 ON CONFLICT(agent_id, source_kind, source_id, source_captured_at, source_entry_id, source_revision) DO UPDATE SET
		   stalled_passes = dreaming_evidence_consumption.stalled_passes + 1`,
	);
	const attention = tableExists(db, "dreaming_attention");
	const raiseStall = db.prepare(
		`INSERT INTO dreaming_attention (id, agent_id, kind, subject_ref, details_json, priority)
		 VALUES (?, ?, 'evidence_requeue', ?, ?, 60)
		 ON CONFLICT(agent_id, kind, subject_ref) DO UPDATE SET
		   details_json = excluded.details_json,
		   priority = MAX(dreaming_attention.priority, excluded.priority),
		   generation = dreaming_attention.generation + 1,
		   resolved_at = NULL,
		   resolved_by_pass_id = NULL
		 WHERE dreaming_attention.resolved_at IS NOT NULL
		    OR json_extract(dreaming_attention.details_json, '$.reason') = 'evidence-stalled'`,
	);
	const ordered = [...revisions.values()].sort(
		(a, b) =>
			a.delivery.agentId.localeCompare(b.delivery.agentId) ||
			a.delivery.kind.localeCompare(b.delivery.kind) ||
			a.delivery.id.localeCompare(b.delivery.id) ||
			a.delivery.capturedAt.localeCompare(b.delivery.capturedAt),
	);
	for (const { delivery, ranges, queued } of ordered) {
		const source = verifiedDreamingEvidenceDelivery(db, delivery);
		if (source === null) continue;
		const identity = [
			delivery.agentId,
			delivery.kind,
			delivery.id,
			delivery.capturedAt,
			sourceIdentity(source),
			sourceRevision(source),
		] as const;
		const row = select.get(...identity) as { deliveredOffset: number; stalledPasses: number } | null;
		const current = Math.max(0, row?.deliveredOffset ?? 0);
		const next = Math.min(extendDeliveredOffset(current, ranges), delivery.length);
		const ref = `${delivery.kind}:${delivery.id}`;
		if (next > current) {
			advance.run(...identity, next, delivery.length, params.passId);
			if (attention) resolveStalledEvidenceAttentionInTx(db, params.passId, delivery.agentId, ref);
			continue;
		}
		if (!queued || current >= delivery.length || progressSuppressed(delivery)) continue;
		stall.run(...identity, delivery.length, params.passId);
		const stalledPasses = (row?.stalledPasses ?? 0) + 1;
		if (!attention || stalledPasses < DREAMING_EVIDENCE_STALL_PASSES) continue;
		raiseStall.run(
			randomUUID(),
			delivery.agentId,
			ref,
			JSON.stringify({
				reason: "evidence-stalled",
				sourceRef: ref,
				sourceRevision: delivery.sourceRevision,
				reviewedChars: String(current),
				sourceLength: String(delivery.length),
				stalledPasses: String(stalledPasses),
			}),
		);
	}
}

export const STALLED_EVIDENCE_ATTENTION_SQL =
	"(kind = 'evidence_requeue' AND json_valid(details_json) AND json_extract(details_json, '$.reason') = 'evidence-stalled')";

export function resolveStalledEvidenceAttentionInTx(db: WriteDb, passId: string, agentId: string, ref: string): void {
	db.prepare(
		`UPDATE dreaming_attention SET resolved_at = datetime('now'), resolved_by_pass_id = ?
		 WHERE agent_id = ? AND subject_ref = ? AND resolved_at IS NULL AND ${STALLED_EVIDENCE_ATTENTION_SQL}`,
	).run(passId, agentId, ref);
}

export interface DreamingEvidenceCursor {
	readonly offset: number;
	readonly stalledPasses: number;
}

export function evidenceCursorForSource(
	db: ReadDb,
	agentId: string,
	source: EpisodicSourceRecord,
): DreamingEvidenceCursor {
	if (!tableExists(db, "dreaming_evidence_consumption")) return { offset: 0, stalledPasses: 0 };
	const row = db
		.prepare(
			`SELECT delivered_offset AS deliveredOffset, stalled_passes AS stalledPasses FROM dreaming_evidence_consumption
		 WHERE agent_id = ? AND source_kind = ? AND source_id = ? AND source_captured_at = ? AND source_entry_id = ? AND source_revision = ?`,
		)
		.get(agentId, source.kind, source.id, source.capturedAt, sourceIdentity(source), sourceRevision(source)) as {
		deliveredOffset: number;
		stalledPasses: number;
	} | null;
	return { offset: Math.max(0, row?.deliveredOffset ?? 0), stalledPasses: row?.stalledPasses ?? 0 };
}

export function deliveredOffsetForSource(db: ReadDb, agentId: string, source: EpisodicSourceRecord): number {
	return evidenceCursorForSource(db, agentId, source).offset;
}
export function hasDreamingEvidenceContinuation(db: ReadDb, agentId: string, passId: string | null): boolean {
	if (!passId || !tableExists(db, "dreaming_evidence_consumption")) return false;
	const reviewedPredicate = tableExists(db, "dreaming_evidence_reviews")
		? `AND NOT EXISTS (
		       SELECT 1 FROM dreaming_evidence_reviews der
		       WHERE der.agent_id = dreaming_evidence_consumption.agent_id
		         AND der.source_kind = dreaming_evidence_consumption.source_kind
		         AND der.source_id = dreaming_evidence_consumption.source_id
		         AND der.source_captured_at = dreaming_evidence_consumption.source_captured_at
		         AND der.source_entry_id = dreaming_evidence_consumption.source_entry_id
		         AND der.source_revision = dreaming_evidence_consumption.source_revision
		   )`
		: "";
	return (
		db
			.prepare(
				`SELECT 1 FROM dreaming_evidence_consumption
				 WHERE agent_id = ? AND pass_id = ?
				   AND delivered_offset > 0 AND delivered_offset < source_length
				   ${reviewedPredicate}
				 LIMIT 1`,
			)
			.get(agentId, passId) != null
	);
}
export function pendingDreamingEvidenceContinuations(
	db: ReadDb,
	agentId: string,
	limit: number,
	kind?: EpisodicSourceKind,
): readonly EpisodicSourceRecord[] {
	if (!tableExists(db, "dreaming_evidence_consumption")) return [];
	const boundedLimit = Math.min(Math.max(Math.floor(limit), 1), 50);
	const transcriptUpdatedAt = tableHasColumn(db, "session_transcripts", "updated_at") ? "st.updated_at" : "NULL";
	const transcriptCompletedAt = tableHasColumn(db, "session_transcripts", "completed_at") ? "st.completed_at" : "NULL";
	const transcriptSourceId = tableHasColumn(db, "session_transcripts", "source_id") ? "st.source_id" : "NULL";
	const transcriptContentHash = tableHasColumn(db, "session_transcripts", "content_hash") ? "st.content_hash" : "NULL";
	const transcriptRevision = `COALESCE(${transcriptCompletedAt}, ${transcriptUpdatedAt}, st.created_at)`;
	const reviewedPredicate = tableExists(db, "dreaming_evidence_reviews")
		? `AND NOT EXISTS (
		       SELECT 1 FROM dreaming_evidence_reviews der
		       WHERE der.agent_id = dec.agent_id
		         AND der.source_kind = dec.source_kind
		         AND der.source_id = dec.source_id
		         AND der.source_captured_at = dec.source_captured_at
		         AND der.source_entry_id = dec.source_entry_id
		         AND der.source_revision = dec.source_revision
		   )`
		: "";
	const rows = db
		.prepare(
			`SELECT dec.source_kind AS kind, dec.source_id AS id, dec.source_captured_at AS capturedAt,
			        dec.source_entry_id AS sourceEntryId, dec.source_revision AS sourceRevision
			 FROM dreaming_evidence_consumption dec
			 INNER JOIN dreaming_passes pass ON pass.id = dec.pass_id
			 WHERE dec.agent_id = ?
			   AND dec.delivered_offset > 0 AND dec.delivered_offset < dec.source_length
			   AND dec.stalled_passes < ?
			   ${reviewedPredicate}
			   AND (? IS NULL OR dec.source_kind = ?)
			   AND (
			     (dec.source_kind = 'memory' AND EXISTS (
			       SELECT 1 FROM memories m
			       WHERE m.agent_id = dec.agent_id AND m.id = dec.source_id
			         AND m.memory_kind = 'episodic' AND COALESCE(m.is_deleted, 0) = 0
			         AND m.visibility != 'archived' AND m.scope IS NULL
			         AND COALESCE(m.type, '') != 'session_summary'
			         AND dec.source_captured_at = m.created_at AND dec.source_entry_id = ''
			         AND dec.source_revision = m.created_at
			     ))
			     OR (dec.source_kind = 'artifact' AND EXISTS (
			       SELECT 1 FROM memory_artifacts ma
			       WHERE ma.agent_id = dec.agent_id AND ma.source_path = dec.source_id
			         AND COALESCE(ma.is_deleted, 0) = 0 AND length(ma.content) > 0
			         AND dec.source_captured_at = ma.captured_at
			         AND dec.source_entry_id = COALESCE(ma.source_id, '')
			         AND dec.source_revision = CASE
			           WHEN ma.source_sha256 IS NULL OR ma.source_sha256 = '' THEN ma.captured_at
			           ELSE ma.source_sha256
			         END
			     ))
			     OR (dec.source_kind = 'transcript' AND EXISTS (
			       SELECT 1 FROM session_transcripts st
			       WHERE st.agent_id = dec.agent_id AND st.session_key = dec.source_id
			         AND dec.source_captured_at = ${transcriptRevision}
			         AND dec.source_entry_id = COALESCE(${transcriptSourceId}, '')
			         AND dec.source_revision = CASE WHEN ${transcriptSourceId} IS NULL OR ${transcriptSourceId} = '' THEN ${transcriptRevision} ELSE COALESCE(${transcriptContentHash}, ${transcriptRevision}) END
			     ))
			     OR (dec.source_kind = 'summary' AND EXISTS (
			       SELECT 1 FROM session_summaries ss
			       WHERE ss.agent_id = dec.agent_id AND ss.id = dec.source_id
			         AND ss.depth = 0
			         AND COALESCE(ss.source_type, 'summary') IN ('summary', 'compaction', 'checkpoint')
			         AND dec.source_captured_at = ss.latest_at
			         AND dec.source_entry_id = '' AND dec.source_revision = ss.latest_at
			     ))
			   )
			 ORDER BY pass.rowid ASC, dec.source_kind ASC, dec.source_id ASC, dec.source_captured_at ASC
			 LIMIT ?`,
		)
		.all(agentId, DREAMING_EVIDENCE_STALL_PASSES, kind ?? null, kind ?? null, boundedLimit) as Array<{
		kind: EpisodicSourceKind;
		id: string;
		capturedAt: string;
		sourceEntryId: string;
		sourceRevision: string;
	}>;
	return rows.flatMap((row) => {
		const source = readEpisodicSource(db, { agentId, from: `${row.kind}:${row.id}` });
		if (
			source === null ||
			source.capturedAt !== row.capturedAt ||
			sourceIdentity(source) !== row.sourceEntryId ||
			sourceRevision(source) !== row.sourceRevision
		)
			return [];
		return [source];
	});
}
function candidateHasUnconsumedEvidence(db: ReadDb, agentId: string, kind: EpisodicSourceKind, id: string): boolean {
	const source = readEpisodicSource(db, { agentId, from: `${kind}:${id}` });
	if (source === null) return false;
	const reviewed =
		tableExists(db, "dreaming_evidence_reviews") &&
		db
			.prepare(
				`SELECT 1 FROM dreaming_evidence_reviews WHERE agent_id = ? AND source_kind = ? AND source_id = ? AND source_captured_at = ? AND source_entry_id = ? AND source_revision = ?`,
			)
			.get(agentId, source.kind, source.id, source.capturedAt, sourceIdentity(source), sourceRevision(source)) != null;
	return !reviewed && deliveredOffsetForSource(db, agentId, source) < renderDreamingEvidence(source).length;
}

interface SourceCandidateBranch {
	readonly kind: "artifact" | "transcript";
	readonly select: string;
	readonly args: readonly unknown[];
	readonly id: string;
	readonly identity: string;
}

function sourceCandidateBranches(
	db: ReadDb,
	agentId: string,
	sourceEntryId: string,
	legacyObsidianRoot: string | undefined,
): readonly SourceCandidateBranch[] {
	const legacyRootPrefix = legacyObsidianRoot?.replace(/\\/g, "/").replace(/\/$/, "") ?? null;
	const identity = (
		kind: string,
		alias: string,
		id: string,
		capturedAt: string,
		entryId: string,
		revision: string,
	): string =>
		`e.agent_id = ${alias}.agent_id AND e.source_kind = '${kind}' AND e.source_id = ${id}
		 AND e.source_captured_at = ${capturedAt} AND e.source_entry_id = ${entryId} AND e.source_revision = ${revision}`;
	const branches: SourceCandidateBranch[] = [
		{
			kind: "artifact",
			select: `SELECT ma.source_path AS id FROM memory_artifacts ma
			 WHERE ma.agent_id = ? AND COALESCE(ma.is_deleted, 0) = 0 AND length(ma.content) > 0
			   AND (ma.source_id = ? OR (? IS NOT NULL AND ma.harness = 'obsidian' AND ma.source_id IS NULL AND ma.source_path >= ? AND ma.source_path < ?))`,
			args: [agentId, sourceEntryId, legacyRootPrefix, legacyRootPrefix ?? "", `${legacyRootPrefix ?? ""}/\uffff`],
			id: "ma.source_path",
			identity: identity(
				"artifact",
				"ma",
				"ma.source_path",
				"ma.captured_at",
				"COALESCE(ma.source_id, '')",
				"CASE WHEN ma.source_sha256 IS NULL OR ma.source_sha256 = '' THEN ma.captured_at ELSE ma.source_sha256 END",
			),
		},
	];
	if (
		tableHasColumn(db, "session_transcripts", "source_id") &&
		tableHasColumn(db, "session_transcripts", "completed_at")
	) {
		const updatedAt = tableHasColumn(db, "session_transcripts", "updated_at") ? "st.updated_at" : "NULL";
		const contentHash = tableHasColumn(db, "session_transcripts", "content_hash") ? "st.content_hash" : "NULL";
		const capturedAt = `COALESCE(st.completed_at, ${updatedAt}, st.created_at)`;
		branches.push({
			kind: "transcript",
			select: `SELECT st.session_key AS id FROM session_transcripts st
			 WHERE st.agent_id = ? AND st.source_id = ? AND st.completed_at IS NOT NULL`,
			args: [agentId, sourceEntryId],
			id: "st.session_key",
			identity: identity(
				"transcript",
				"st",
				"st.session_key",
				capturedAt,
				"COALESCE(st.source_id, '')",
				`CASE WHEN st.source_id IS NULL OR st.source_id = '' THEN ${capturedAt} ELSE COALESCE(${contentHash}, ${capturedAt}) END`,
			),
		});
	}
	return branches;
}

export interface SourceEvidenceDrainProbe {
	readonly status: "pending" | "drained" | "undetermined";
	readonly resumeAfter: string | null;
	readonly rendered: number;
}

const SOURCE_DRAIN_PAGE_ROWS = 32;

export function probeSourceEvidenceDrain(
	db: ReadDb,
	agentId: string,
	sourceEntryId: string,
	options: {
		readonly legacyObsidianRoot?: string;
		readonly maxRenders: number;
		readonly resumeAfter?: string | null;
	},
): SourceEvidenceDrainProbe {
	let resumeAfter = options.resumeAfter ?? null;
	if (!tableExists(db, "dreaming_evidence_consumption")) return { status: "pending", resumeAfter, rendered: 0 };
	const branches = sourceCandidateBranches(db, agentId, sourceEntryId, options.legacyObsidianRoot);
	const notReviewed = (branch: SourceCandidateBranch): string =>
		tableExists(db, "dreaming_evidence_reviews")
			? `AND NOT EXISTS (SELECT 1 FROM dreaming_evidence_reviews e WHERE ${branch.identity})`
			: "";
	for (const branch of branches) {
		const partial = db
			.prepare(
				`${branch.select} ${notReviewed(branch)}
				 AND EXISTS (SELECT 1 FROM dreaming_evidence_consumption e WHERE ${branch.identity} AND e.delivered_offset < e.source_length)
				 LIMIT 1`,
			)
			.get(...branch.args);
		if (partial != null) return { status: "pending", resumeAfter, rendered: 0 };
	}
	const separator = resumeAfter?.indexOf(":") ?? -1;
	const resumeKind = resumeAfter !== null && separator > 0 ? resumeAfter.slice(0, separator) : null;
	const resumeId = resumeAfter !== null && separator > 0 ? resumeAfter.slice(separator + 1) : "";
	let rendered = 0;
	for (const branch of branches) {
		if (resumeKind === "transcript" && branch.kind === "artifact") continue;
		let after = resumeKind === branch.kind ? resumeId : "";
		const undelivered = db.prepare(
			`${branch.select} AND ${branch.id} > ? ${notReviewed(branch)}
			 AND NOT EXISTS (SELECT 1 FROM dreaming_evidence_consumption e WHERE ${branch.identity})
			 ORDER BY ${branch.id} ASC
			 LIMIT ?`,
		);
		for (;;) {
			const pageRows = Math.max(1, Math.min(SOURCE_DRAIN_PAGE_ROWS, options.maxRenders - rendered + 1));
			const rows = undelivered.all(...branch.args, after, pageRows) as Array<{ id: string }>;
			for (const row of rows) {
				if (rendered >= options.maxRenders) return { status: "undetermined", resumeAfter, rendered };
				rendered += 1;
				if (candidateHasUnconsumedEvidence(db, agentId, branch.kind, row.id)) {
					return { status: "pending", resumeAfter, rendered };
				}
				after = row.id;
				resumeAfter = `${branch.kind}:${row.id}`;
			}
			if (rows.length < pageRows) break;
		}
	}
	return { status: "drained", resumeAfter, rendered };
}

export function sourceHasEligibleUnconsumedEvidence(
	db: ReadDb,
	agentId: string,
	sourceEntryId: string,
	legacyObsidianRoot?: string,
): boolean {
	return (
		probeSourceEvidenceDrain(db, agentId, sourceEntryId, {
			legacyObsidianRoot,
			maxRenders: Number.POSITIVE_INFINITY,
		}).status !== "drained"
	);
}

export const IMPORTED_SOURCE_ATTENTION_ROWS_PER_SCOPE = 20;
export const IMPORTED_SOURCE_ATTENTION_RENDER_BUDGET = 8;

export function resolveImportedSourceAttentionInTx(db: WriteDb, passId: string, scopes: readonly string[]): number {
	if (!tableExists(db, "dreaming_attention")) return 0;
	const checkSeq = "(CASE WHEN json_valid(details_json) THEN json_extract(details_json, '$.drainCheckSeq') END)";
	const pendingSource =
		"agent_id = ? AND kind = 'evidence_requeue' AND resolved_at IS NULL AND subject_ref LIKE 'source:%'";
	const pending = db.prepare(
		`SELECT id, subject_ref AS subjectRef,
		        CASE WHEN json_valid(details_json) THEN json_extract(details_json, '$.drainResumeAfter') END AS resumeAfter
		 FROM dreaming_attention
		 WHERE ${pendingSource}
		 ORDER BY COALESCE(${checkSeq}, 0) ASC, created_at ASC, id ASC
		 LIMIT ?`,
	);
	const nextCheckSeq = db.prepare(
		`SELECT COALESCE(MAX(${checkSeq}), 0) + 1 AS seq FROM dreaming_attention WHERE ${pendingSource}`,
	);
	const stamp = db.prepare(
		`UPDATE dreaming_attention
		 SET details_json = json_set(CASE WHEN json_valid(details_json) THEN details_json ELSE '{}' END,
		                             '$.drainCheckSeq', ?, '$.drainResumeAfter', ?)
		 WHERE id = ?`,
	);
	const resolve = db.prepare(
		`UPDATE dreaming_attention SET resolved_at = datetime('now'), resolved_by_pass_id = ?
		 WHERE id = ? AND resolved_at IS NULL`,
	);
	let resolved = 0;
	let renderBudget = IMPORTED_SOURCE_ATTENTION_RENDER_BUDGET;
	for (const agentId of new Set(scopes)) {
		const rows = pending.all(agentId, IMPORTED_SOURCE_ATTENTION_ROWS_PER_SCOPE) as Array<{
			id: string;
			subjectRef: string;
			resumeAfter: unknown;
		}>;
		const seq = (nextCheckSeq.get(agentId) as { seq: number }).seq;
		for (const row of rows) {
			const sourceEntryId = row.subjectRef.slice("source:".length);
			const probe = sourceEntryId
				? probeSourceEvidenceDrain(db, agentId, sourceEntryId, {
						maxRenders: renderBudget,
						resumeAfter: typeof row.resumeAfter === "string" ? row.resumeAfter : null,
					})
				: null;
			renderBudget -= probe?.rendered ?? 0;
			if (probe?.status === "drained") {
				resolve.run(passId, row.id);
				resolved += 1;
				continue;
			}
			stamp.run(seq, probe?.resumeAfter ?? null, row.id);
		}
	}
	return resolved;
}
