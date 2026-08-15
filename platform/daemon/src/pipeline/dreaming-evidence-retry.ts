import { createHash } from "node:crypto";
import type { DbAccessor, ReadDb, WriteDb } from "../db-accessor";
import {
	type EpisodicSourceKind,
	type EpisodicSourceRecord,
	findEpisodicSourceAgentIds,
	readEpisodicSource,
} from "../episodic-sources";
import { enqueueDreamingAttentionInTx } from "./dreaming-attention";
import { renderDreamingEvidence } from "./dreaming-evidence";
import type { ApplyDreamingOperationsResult, DreamingOperationRequest } from "./dreaming-operations";

export const DREAMING_EVIDENCE_FAILURE_CLASSES = [
	"incomplete_transcript",
	"source_projection",
	"scope_mismatch",
	"quote_mismatch",
	"unknown",
] as const;
export type DreamingEvidenceFailureClass = (typeof DREAMING_EVIDENCE_FAILURE_CLASSES)[number];

export interface DreamingEvidenceRetryPolicy {
	readonly cooldownMs: number;
	readonly hourlyBudget: number;
	readonly maxAttempts: number;
}

export interface RejectedDreamingEvidence {
	readonly agentId: string;
	readonly sourceKind: EpisodicSourceKind;
	readonly sourceId: string;
	readonly failureClass: DreamingEvidenceFailureClass;
	readonly sourceFingerprint: string | null;
}

interface EvidenceReference {
	readonly sourceRef: string;
	readonly quote: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function sourceReference(value: unknown): EvidenceReference | null {
	if (!isRecord(value)) return null;
	const quote = nonEmptyString(value.quote);
	if (!quote) return null;
	const explicit = nonEmptyString(value.source_ref);
	if (explicit) return { sourceRef: explicit, quote };
	const kind = nonEmptyString(value.source_kind);
	const id = nonEmptyString(value.source_id);
	return kind && id ? { sourceRef: `${kind}:${id}`, quote } : null;
}

function sourceFingerprint(source: EpisodicSourceRecord): string {
	const renderedContent = renderDreamingEvidence(source);
	return createHash("sha256")
		.update(
			JSON.stringify({
				kind: source.kind,
				id: source.id,
				content: source.content,
				renderedContent,
				completed: source.completed,
				capturedAt: source.capturedAt,
				sourceKind: source.sourceKind,
				sourceId: source.sourceId,
				sourcePath: source.sourcePath,
				sourceEntryId: source.sourceEntryId,
			}),
		)
		.digest("hex");
}

function failureClass(
	db: ReadDb,
	agentId: string,
	reference: EvidenceReference,
): {
	readonly kind: EpisodicSourceKind;
	readonly id: string;
	readonly failureClass: DreamingEvidenceFailureClass;
	readonly sourceFingerprint: string | null;
} | null {
	const colon = reference.sourceRef.indexOf(":");
	if (colon <= 0) return null;
	const kind = reference.sourceRef.slice(0, colon);
	const id = reference.sourceRef.slice(colon + 1);
	if (kind !== "memory" && kind !== "artifact" && kind !== "transcript" && kind !== "summary") return null;
	const source = readEpisodicSource(db, { agentId, from: reference.sourceRef });
	if (source === null) {
		return {
			kind,
			id,
			failureClass:
				findEpisodicSourceAgentIds(db, reference.sourceRef).length > 0 ? "scope_mismatch" : "source_projection",
			sourceFingerprint: null,
		};
	}
	if (source.kind === "transcript" && !source.completed) {
		return { kind, id: source.id, failureClass: "incomplete_transcript", sourceFingerprint: sourceFingerprint(source) };
	}
	if (!renderDreamingEvidence(source).includes(reference.quote)) {
		return { kind, id: source.id, failureClass: "quote_mismatch", sourceFingerprint: sourceFingerprint(source) };
	}
	return { kind, id: source.id, failureClass: "unknown", sourceFingerprint: sourceFingerprint(source) };
}

function rejectedIndexes(
	result: ApplyDreamingOperationsResult,
	operations: readonly Pick<DreamingOperationRequest, "evidence">[],
): ReadonlySet<number> {
	const indexes = result.items.filter((item) => !item.ok).map((item) => item.index);
	return new Set(indexes.length > 0 ? indexes : result.ok ? [] : operations.map((_operation, index) => index));
}

/** Resolve rejected citations to the source state that caused the rejection. */
export function collectRejectedDreamingEvidence(
	accessor: DbAccessor,
	agentId: string,
	result: ApplyDreamingOperationsResult,
	operations: readonly Pick<DreamingOperationRequest, "evidence">[],
): readonly RejectedDreamingEvidence[] {
	const indexes = rejectedIndexes(result, operations);
	// @ts-expect-error LEGACY_SYNC_DB_ACCESS: withReadDb migration site
	return accessor.withReadDb((db: import("../db-accessor").ReadDb) => {
		const candidates = new Map<string, RejectedDreamingEvidence>();
		for (const index of indexes) {
			const operation = operations[index];
			if (!operation) continue;
			for (const rawEvidence of operation.evidence ?? []) {
				const reference = sourceReference(rawEvidence);
				const candidate = reference ? failureClass(db, agentId, reference) : null;
				if (!candidate) continue;
				const key = `${agentId}:${candidate.kind}:${candidate.id}`;
				candidates.set(key, {
					agentId,
					sourceKind: candidate.kind,
					sourceId: candidate.id,
					failureClass: candidate.failureClass,
					sourceFingerprint: candidate.sourceFingerprint,
				});
			}
		}
		return [...candidates.values()];
	});
}

export function recordRejectedDreamingEvidenceInTx(
	db: WriteDb,
	passId: string,
	items: readonly RejectedDreamingEvidence[],
): void {
	const statement = db.prepare(
		`INSERT INTO dreaming_evidence_exclusions
		 (agent_id, source_kind, source_id, reason, pass_id, excluded_at, requeue_requested_at, resolved_at,
		  failure_class, source_fingerprint, retry_count, last_requeued_at)
		 VALUES (?, ?, ?, 'semantic_operation_rejected', ?, datetime('now'), NULL, NULL, ?, ?, 0, NULL)
		 ON CONFLICT(agent_id, source_kind, source_id) DO UPDATE SET
		   reason = excluded.reason,
		   pass_id = excluded.pass_id,
		   excluded_at = excluded.excluded_at,
		   requeue_requested_at = NULL,
		   resolved_at = NULL,
		   failure_class = excluded.failure_class,
		   source_fingerprint = excluded.source_fingerprint`,
	);
	for (const item of items) {
		statement.run(item.agentId, item.sourceKind, item.sourceId, passId, item.failureClass, item.sourceFingerprint);
	}
}

/** Mark a requeued citation repaired once the daemon accepts it again. */
export function resolveRequeuedDreamingEvidenceInTx(
	db: WriteDb,
	agentId: string,
	passId: string,
	result: ApplyDreamingOperationsResult,
	operations: readonly Pick<DreamingOperationRequest, "evidence">[],
): void {
	const indexes = result.items.filter((item) => item.ok).map((item) => item.index);
	if (indexes.length === 0) return;
	const statement = db.prepare(
		`UPDATE dreaming_evidence_exclusions
		 SET resolved_at = datetime('now')
		 WHERE agent_id = ? AND source_kind = ? AND source_id = ?
		   AND requeue_requested_at IS NOT NULL AND resolved_at IS NULL`,
	);
	const attentionStatement = db.prepare(
		`UPDATE dreaming_attention
		 SET resolved_at = datetime('now'), resolved_by_pass_id = ?
		 WHERE agent_id = ? AND kind = 'evidence_requeue' AND subject_ref = ? AND resolved_at IS NULL`,
	);
	const seen = new Set<string>();
	for (const index of indexes) {
		const operation = operations[index];
		if (!operation) continue;
		for (const rawEvidence of operation.evidence ?? []) {
			const reference = sourceReference(rawEvidence);
			if (!reference) continue;
			const colon = reference.sourceRef.indexOf(":");
			if (colon <= 0) continue;
			const kind = reference.sourceRef.slice(0, colon);
			const id = reference.sourceRef.slice(colon + 1);
			if (kind !== "memory" && kind !== "artifact" && kind !== "transcript" && kind !== "summary") continue;
			const key = `${kind}:${id}`;
			if (seen.has(key)) continue;
			seen.add(key);
			statement.run(agentId, kind, id);
			attentionStatement.run(passId, agentId, `${kind}:${id}`);
		}
	}
}

interface RetryRow {
	readonly agent_id: string;
	readonly source_kind: EpisodicSourceKind;
	readonly source_id: string;
	readonly failure_class: DreamingEvidenceFailureClass;
	readonly source_fingerprint: string | null;
	readonly retry_count: number;
	readonly last_requeued_at: string | null;
}

function parsedTime(value: string | null): number | null {
	if (!value) return null;
	const parsed = Date.parse(value.replace(" ", "T") + (value.includes("T") ? "" : "Z"));
	return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Requeue only a source whose canonical state changed since a transient
 * rejection. The update and attention mint are atomic, and retry_count plus
 * the hourly budget make this a bounded repair aid rather than a hot loop.
 */
export function autoRequeueRepairedDreamingEvidence(
	accessor: DbAccessor,
	policy: DreamingEvidenceRetryPolicy,
	nowMs = Date.now(),
): number {
	const cooldownMs = Math.max(0, Math.floor(policy.cooldownMs));
	const hourlyBudget = Math.max(0, Math.floor(policy.hourlyBudget));
	const maxAttempts = Math.max(0, Math.floor(policy.maxAttempts));
	if (hourlyBudget === 0 || maxAttempts === 0) return 0;
	const now = new Date(nowMs).toISOString();
	const hourAgo = nowMs - 60 * 60 * 1000;
	// @ts-expect-error LEGACY_SYNC_DB_ACCESS: withWriteTx migration site
	return accessor.withWriteTx((db: import("../db-accessor").WriteDb) => {
		const recent = db
			.prepare(
				`SELECT COUNT(*) AS count FROM dreaming_evidence_exclusions
				 WHERE last_requeued_at IS NOT NULL AND julianday(last_requeued_at) >= julianday(?)`,
			)
			.get(new Date(hourAgo).toISOString()) as { count: number };
		let budget = Math.max(0, hourlyBudget - (recent.count ?? 0));
		if (budget === 0) return 0;
		const rows = db
			.prepare(
				`SELECT agent_id, source_kind, source_id, failure_class, source_fingerprint,
				        retry_count, last_requeued_at
				 FROM dreaming_evidence_exclusions
				 WHERE resolved_at IS NULL AND requeue_requested_at IS NULL
				   AND failure_class IN ('incomplete_transcript', 'source_projection', 'scope_mismatch', 'quote_mismatch')
				   AND retry_count < ?
				 ORDER BY excluded_at ASC, source_kind ASC, source_id ASC`,
			)
			.all(maxAttempts) as RetryRow[];
		let affected = 0;
		for (const row of rows) {
			if (budget === 0) break;
			const lastRequeued = parsedTime(row.last_requeued_at);
			if (lastRequeued !== null && nowMs - lastRequeued < cooldownMs) continue;
			const source = readEpisodicSource(db, { agentId: row.agent_id, from: `${row.source_kind}:${row.source_id}` });
			if (source === null) continue;
			if (row.failure_class === "incomplete_transcript" && !source.completed) continue;
			const currentFingerprint = sourceFingerprint(source);
			if (row.source_fingerprint === currentFingerprint) continue;
			const updated = db
				.prepare(
					`UPDATE dreaming_evidence_exclusions
					 SET requeue_requested_at = ?, last_requeued_at = ?, retry_count = retry_count + 1
					 WHERE agent_id = ? AND source_kind = ? AND source_id = ?
					   AND resolved_at IS NULL AND requeue_requested_at IS NULL
					   AND retry_count < ?`,
				)
				.run(now, now, row.agent_id, row.source_kind, row.source_id, maxAttempts) as { changes: number };
			if (updated.changes !== 1) continue;
			enqueueDreamingAttentionInTx(db, {
				agentId: row.agent_id,
				kind: "evidence_requeue",
				subjectRef: `${row.source_kind}:${row.source_id}`,
				details: { sourceKind: row.source_kind, sourceId: row.source_id, automatic: "true" },
				priority: 80,
			});
			budget -= 1;
			affected += 1;
		}
		return affected;
	});
}
