import { getDbOwnerForAccessor } from "../db-owner-runtime";
import { ownerReadAll, ownerReadOne } from "../db-owner-sql";
import type { DbAccessor, ReadDb, WriteDb } from "../db-accessor";
import { runWriteTxAsync } from "../db-accessor";
import { type EpisodicSourceKind, readEpisodicSource } from "../episodic-sources";
import { enqueueDreamingAttentionInTx } from "./dreaming-attention";
import {
	deliveredOffsetForSource,
	persistedEvidenceDeliveries,
	verifiedDreamingEvidenceDelivery,
} from "./dreaming-evidence-consumption";
import { renderDreamingEvidence } from "./dreaming-evidence";

export interface DreamingReviewedExcludedEvidenceEntry {
	readonly agentId: string;
	readonly sourceRef: string;
	readonly reason: string;
}

export interface DreamingReviewedEvidence {
	readonly agentId: string;
	readonly sourceKind: EpisodicSourceKind;
	readonly sourceId: string;
	readonly sourceCapturedAt: string;
	readonly sourceEntryId: string;
	readonly sourceRevision: string;
	readonly reason: string;
	readonly passId: string;
	readonly reviewedAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sourceRef(value: string): { readonly kind: EpisodicSourceKind; readonly id: string } | null {
	const separator = value.indexOf(":");
	if (separator <= 0) return null;
	const kind = value.slice(0, separator);
	const id = value.slice(separator + 1);
	if (!id || !["memory", "artifact", "transcript", "summary"].includes(kind)) return null;
	return { kind: kind as EpisodicSourceKind, id };
}

function sourceEntryId(source: { readonly sourceEntryId: string | null }): string {
	return source.sourceEntryId ?? "";
}

function sourceRevision(source: { readonly sourceRevision?: string | null; readonly capturedAt: string }): string {
	return source.sourceRevision ?? source.capturedAt;
}

function tableExists(db: ReadDb): boolean {
	return (
		db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get("dreaming_evidence_reviews") != null
	);
}
export function parseDreamingReviewedExcludedEvidence(
	value: unknown,
): readonly DreamingReviewedExcludedEvidenceEntry[] | null {
	if (!isRecord(value) || value.reviewedExcludedEvidence === undefined) return [];
	if (!Array.isArray(value.reviewedExcludedEvidence)) return null;
	const entries: DreamingReviewedExcludedEvidenceEntry[] = [];
	for (const item of value.reviewedExcludedEvidence) {
		if (
			!isRecord(item) ||
			typeof item.agentId !== "string" ||
			typeof item.sourceRef !== "string" ||
			typeof item.reason !== "string"
		)
			return null;
		const agentId = item.agentId.trim();
		const sourceRefValue = item.sourceRef.trim();
		const reason = item.reason.trim();
		if (!agentId || !sourceRefValue || !reason) return null;
		entries.push({ agentId, sourceRef: sourceRefValue, reason });
	}
	return entries;
}

function wasFullyDelivered(
	db: ReadDb,
	deliveries: ReturnType<typeof persistedEvidenceDeliveries>,
	agentId: string,
	kind: EpisodicSourceKind,
	id: string,
	sourceCapturedAt: string,
	sourceEntryId: string,
	revision: string,
	initialOffset: number,
	length: number,
): boolean {
	let offset = Math.min(initialOffset, length);
	const matches = deliveries
		.filter(
			(delivery) =>
				delivery.agentId === agentId &&
				delivery.kind === kind &&
				delivery.id === id &&
				delivery.capturedAt === sourceCapturedAt &&
				delivery.sourceEntryId === sourceEntryId &&
				delivery.sourceRevision === revision,
		)
		.sort((a, b) => a.start - b.start || a.end - b.end);
	for (const delivery of matches) {
		if (verifiedDreamingEvidenceDelivery(db, delivery) === null) return false;
		if (delivery.start > offset) return false;
		if (delivery.end > offset) offset = delivery.end;
	}
	return matches.length > 0 && offset >= length;
}
export function recordDreamingReviewedExcludedEvidenceInTx(
	db: WriteDb,
	params: {
		readonly passId: string;
		readonly scopeIds: ReadonlySet<string>;
		readonly entries: readonly DreamingReviewedExcludedEvidenceEntry[];
		readonly deferredEvidence: ReadonlySet<string>;
	},
): number {
	if (!tableExists(db)) return 0;
	const deliveries = persistedEvidenceDeliveries(db, params.passId);
	const insert = db.prepare(
		`INSERT INTO dreaming_evidence_reviews
		 (agent_id, source_kind, source_id, source_captured_at, source_entry_id, source_revision,
		  reason, pass_id, reviewed_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
		 ON CONFLICT(agent_id, source_kind, source_id, source_captured_at, source_entry_id, source_revision) DO UPDATE SET
		   reason = excluded.reason,
		   pass_id = excluded.pass_id,
		   reviewed_at = excluded.reviewed_at`,
	);
	const seen = new Set<string>();
	let recorded = 0;
	for (const entry of params.entries) {
		const agentId = entry.agentId;
		if (!params.scopeIds.has(agentId)) continue;
		const parsed = sourceRef(entry.sourceRef);
		if (!parsed) continue;
		const source = readEpisodicSource(db, { agentId, from: entry.sourceRef });
		if (source === null) continue;
		if (
			params.deferredEvidence.has(`${agentId}\u0000${entry.sourceRef}`) ||
			params.deferredEvidence.has(`${agentId}\u0000${source.kind}:${source.id}`)
		)
			continue;
		const revision = sourceRevision(source);
		if (
			!wasFullyDelivered(
				db,
				deliveries,
				agentId,
				source.kind,
				source.id,
				source.capturedAt,
				sourceEntryId(source),
				revision,
				deliveredOffsetForSource(db, agentId, source),
				renderDreamingEvidence(source).length,
			)
		)
			continue;
		const key = `${agentId}\u0000${source.kind}\u0000${source.id}\u0000${source.capturedAt}\u0000${revision}`;
		if (seen.has(key)) continue;
		seen.add(key);
		insert.run(
			agentId,
			source.kind,
			source.id,
			source.capturedAt,
			sourceEntryId(source),
			revision,
			entry.reason,
			params.passId,
		);
		recorded += 1;
	}
	return recorded;
}

export async function getDreamingReviewedEvidence(
	accessor: DbAccessor,
	agentId: string,
): Promise<readonly DreamingReviewedEvidence[]> {
	const owner = await getDbOwnerForAccessor(accessor);
	const exists = await ownerReadOne<{ readonly present: number }>(
		owner,
		"SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?",
		["dreaming_evidence_reviews"],
		{ operation: "dreaming.evidence-reviews-table", workloadClass: "foreground" },
	);
	if (exists === null) return [];
	return await ownerReadAll<DreamingReviewedEvidence>(
		owner,
		`SELECT agent_id AS agentId, source_kind AS sourceKind, source_id AS sourceId,
		        source_captured_at AS sourceCapturedAt, source_entry_id AS sourceEntryId,
		        source_revision AS sourceRevision, reason, pass_id AS passId,
		        reviewed_at AS reviewedAt
		 FROM dreaming_evidence_reviews
		 WHERE agent_id = ?
		 ORDER BY reviewed_at DESC, source_kind ASC, source_id ASC`,
		[agentId],
		{ operation: "dreaming.evidence-reviews-read", workloadClass: "foreground" },
	);
}
export async function requestDreamingReviewedEvidenceRequeue(
	accessor: DbAccessor,
	agentId: string,
	sourceKind: EpisodicSourceKind,
	sourceId: string,
): Promise<boolean> {
	return await runWriteTxAsync(
		accessor,
		(db) => {
			if (!tableExists(db)) return false;
			const result = db
				.prepare("DELETE FROM dreaming_evidence_reviews WHERE agent_id = ? AND source_kind = ? AND source_id = ?")
				.run(agentId, sourceKind, sourceId) as { changes: number };
			if (result.changes === 0) return false;
			db.prepare(
				"DELETE FROM dreaming_evidence_consumption WHERE agent_id = ? AND source_kind = ? AND source_id = ?",
			).run(agentId, sourceKind, sourceId);
			enqueueDreamingAttentionInTx(db, {
				agentId,
				kind: "evidence_requeue",
				subjectRef: `${sourceKind}:${sourceId}`,
				details: { sourceKind, sourceId, reviewedExcluded: "true" },
				priority: 80,
			});
			return true;
		},
		{ siteToken: "pipeline/dreaming-evidence-reviews.ts:232" },
	);
}
