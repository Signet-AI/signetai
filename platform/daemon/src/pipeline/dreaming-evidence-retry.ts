import { createHash } from "node:crypto";
import { dreamingPassPartitionInDb, dreamingReadScopeInDb } from "../classification-owner";
import { prepareTypedStatement } from "../db-accessor";
import { runDbOwnerDomainOperation } from "../db-owner-runtime";

import type { DbAccessor, ReadDb, WriteDb } from "../db-accessor";
import { type EpisodicSourceKind, type EpisodicSourceRecord, readEpisodicSource } from "../episodic-sources";
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
	readonly sourceQuote?: string;
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
	compartmentId: number | null,
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
	const source = readEpisodicSource(db, {
		agentId,
		from: reference.sourceRef,
		readScope: dreamingReadScopeInDb(db, agentId, compartmentId),
		preferredCompartment: compartmentId,
	});
	if (source === null) {
		return {
			kind,
			id,
			failureClass: "source_projection",
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

export function collectRejectedDreamingEvidenceInDb(
	db: ReadDb,
	agentId: string,
	result: ApplyDreamingOperationsResult,
	operations: readonly Pick<DreamingOperationRequest, "evidence">[],
	passId?: string,
): readonly RejectedDreamingEvidence[] {
	const compartmentId = passId === undefined ? null : dreamingPassPartitionInDb(db, passId, agentId).compartmentId;
	const indexes = rejectedIndexes(result, operations);
	const candidates = new Map<string, RejectedDreamingEvidence>();
	for (const index of indexes) {
		const operation = operations[index];
		if (!operation) continue;
		for (const rawEvidence of operation.evidence ?? []) {
			const reference = sourceReference(rawEvidence);
			const candidate = reference ? failureClass(db, agentId, reference, compartmentId) : null;
			if (!candidate) continue;
			const key = `${agentId}:${candidate.kind}:${candidate.id}`;
			candidates.set(key, {
				agentId,
				sourceKind: candidate.kind,
				sourceId: candidate.id,
				failureClass: candidate.failureClass,
				sourceFingerprint: candidate.sourceFingerprint,
				sourceQuote: reference?.quote,
			});
		}
	}
	return [...candidates.values()];
}
export async function collectRejectedDreamingEvidence(
	accessor: DbAccessor,
	agentId: string,
	result: ApplyDreamingOperationsResult,
	operations: readonly Pick<DreamingOperationRequest, "evidence">[],
	passId?: string,
): Promise<readonly RejectedDreamingEvidence[]> {
	return await runDbOwnerDomainOperation(accessor, {
		runWithOwner: async (owner) => {
			const input = { agentId, result, operations, passId };
			const handle = owner.submit<readonly RejectedDreamingEvidence[]>(
				{ kind: "dreaming_evidence_classify", input },
				{
					operation: "dreaming.evidence.classify",
					lane: "read",
					workloadClass: "foreground",
					deadlineMs: 30_000,
					estimatedWorkUnits: 200,
				},
			);
			return await handle.result;
		},
		runInline: ({ read }) => read((db) => collectRejectedDreamingEvidenceInDb(db, agentId, result, operations, passId)),
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
		  failure_class, source_fingerprint, retry_count, last_requeued_at, compartment_id)
		 VALUES (?, ?, ?, 'semantic_operation_rejected', ?, datetime('now'), NULL, NULL, ?, ?, 0, NULL, ?)
		 ON CONFLICT(agent_id, source_kind, source_id, COALESCE(compartment_id,0)) DO UPDATE SET
		   reason = excluded.reason,
		   pass_id = excluded.pass_id,
		   excluded_at = excluded.excluded_at,
		   requeue_requested_at = NULL,
		   resolved_at = NULL,
		   failure_class = excluded.failure_class,
		   source_fingerprint = excluded.source_fingerprint`,
	);
	for (const item of items) {
		const partition = dreamingPassPartitionInDb(db, passId, item.agentId);
		const source = readEpisodicSource(db, {
			agentId: item.agentId,
			from: `${item.sourceKind}:${item.sourceId}`,
			readScope: dreamingReadScopeInDb(db, item.agentId, partition.compartmentId),
			preferredCompartment: partition.compartmentId,
		});
		const classified =
			item.sourceQuote === undefined
				? null
				: failureClass(
						db,
						item.agentId,
						{ sourceRef: `${item.sourceKind}:${item.sourceId}`, quote: item.sourceQuote },
						partition.compartmentId,
					);
		statement.run(
			item.agentId,
			source?.kind ?? item.sourceKind,
			source?.id ?? item.sourceId,
			passId,
			classified?.failureClass ?? (source === null ? "source_projection" : item.failureClass),
			source === null ? null : sourceFingerprint(source),
			partition.compartmentId,
		);
	}
}
export function resolveRequeuedDreamingEvidenceInTx(
	db: WriteDb,
	agentId: string,
	passId: string,
	result: ApplyDreamingOperationsResult,
	operations: readonly Pick<DreamingOperationRequest, "evidence">[],
): void {
	const partition = dreamingPassPartitionInDb(db, passId, agentId);
	const indexes = result.items.filter((item) => item.ok).map((item) => item.index);
	if (indexes.length === 0) return;
	const statement = db.prepare(
		`UPDATE dreaming_evidence_exclusions
		 SET resolved_at = datetime('now')
		 WHERE agent_id = ? AND source_kind = ? AND source_id = ?
		   AND compartment_id IS ? AND requeue_requested_at IS NOT NULL AND resolved_at IS NULL`,
	);
	const attentionStatement = db.prepare(
		`UPDATE dreaming_attention
		 SET resolved_at = datetime('now'), resolved_by_pass_id = ?
		 WHERE agent_id = ? AND kind = 'evidence_requeue' AND subject_ref = ? AND compartment_id IS ? AND resolved_at IS NULL`,
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
			if (kind !== "memory" && kind !== "artifact" && kind !== "transcript" && kind !== "summary") continue;
			const source = readEpisodicSource(db, {
				agentId,
				from: reference.sourceRef,
				readScope: dreamingReadScopeInDb(db, agentId, partition.compartmentId),
				preferredCompartment: partition.compartmentId,
			});
			if (source === null) continue;
			const key = `${source.kind}:${source.id}`;
			if (seen.has(key)) continue;
			seen.add(key);
			statement.run(agentId, source.kind, source.id, partition.compartmentId);
			attentionStatement.run(passId, agentId, key, partition.compartmentId);
		}
	}
}

interface RetryRow {
	readonly cursor: number;
	readonly compartment_id: number | null;
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

const retryCursors = new WeakMap<ReadDb, { public: number; classified: number }>();

export function autoRequeueRepairedDreamingEvidenceInDb(
	db: WriteDb,
	policy: DreamingEvidenceRetryPolicy,
	nowMs: number,
): number {
	const cooldownMs = Math.max(0, Math.floor(policy.cooldownMs));
	const hourlyBudget = Math.max(0, Math.floor(policy.hourlyBudget));
	const maxAttempts = Math.max(0, Math.floor(policy.maxAttempts));
	if (hourlyBudget === 0 || maxAttempts === 0) return 0;
	const now = new Date(nowMs).toISOString();
	const hourAgo = nowMs - 60 * 60 * 1000;
	const deadline = performance.now() + 30_000;
	const cursors = retryCursors.get(db) ?? { public: 0, classified: 0 };
	retryCursors.set(db, cursors);
	const rows: RetryRow[] = [];
	for (const lane of ["public", "classified"] as const) {
		const page = prepareTypedStatement<RetryRow>(
			db,
			`SELECT rowid AS cursor, agent_id, compartment_id, source_kind, source_id, failure_class, source_fingerprint, retry_count, last_requeued_at
    FROM dreaming_evidence_exclusions
    WHERE resolved_at IS NULL AND requeue_requested_at IS NULL
    AND failure_class IN ('incomplete_transcript','source_projection','scope_mismatch','quote_mismatch')
    AND retry_count < ? AND compartment_id IS ${lane === "public" ? "NULL" : "NOT NULL"}
    AND rowid > ? ORDER BY rowid LIMIT 250`,
		).all(maxAttempts, cursors[lane]);
		cursors[lane] = page.length === 250 ? (page.at(-1)?.cursor ?? 0) : 0;
		rows.push(...page);
	}
	const budgets = new Map<string, number>();
	let affected = 0;
	for (const row of rows) {
		if (performance.now() >= deadline) break;
		const key = JSON.stringify([row.agent_id, row.compartment_id]);
		let budget = budgets.get(key);
		if (budget === undefined) {
			const recent = prepareTypedStatement<{ count: number }>(
				db,
				`SELECT COUNT(*) AS count FROM (SELECT 1 FROM dreaming_evidence_exclusions WHERE agent_id=? AND compartment_id IS ? AND last_requeued_at IS NOT NULL AND julianday(last_requeued_at)>=julianday(?) LIMIT ?)`,
			).get(row.agent_id, row.compartment_id, new Date(hourAgo).toISOString(), hourlyBudget);
			budget = Math.max(0, hourlyBudget - (recent?.count ?? 0));
			budgets.set(key, budget);
		}
		if (budget === 0) continue;
		const lastRequeued = parsedTime(row.last_requeued_at);
		if (lastRequeued !== null && nowMs - lastRequeued < cooldownMs) continue;
		const source = readEpisodicSource(db, {
			agentId: row.agent_id,
			from: `${row.source_kind}:${row.source_id}`,
			preferredCompartment: row.compartment_id,
			readScope: dreamingReadScopeInDb(db, row.agent_id, row.compartment_id),
		});
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
				   AND retry_count = ? AND compartment_id IS ?`,
			)
			.run(now, now, row.agent_id, row.source_kind, row.source_id, row.retry_count, row.compartment_id);
		if (updated.changes !== 1) continue;
		enqueueDreamingAttentionInTx(db, {
			agentId: row.agent_id,
			compartmentId: row.compartment_id,
			kind: "evidence_requeue",
			subjectRef: `${row.source_kind}:${row.source_id}`,
			details: { sourceKind: row.source_kind, sourceId: row.source_id, automatic: "true" },
			priority: 80,
		});
		budgets.set(key, budget - 1);
		affected += 1;
	}
	return affected;
}
export async function autoRequeueRepairedDreamingEvidence(
	accessor: DbAccessor,
	policy: DreamingEvidenceRetryPolicy,
	nowMs = Date.now(),
): Promise<number> {
	const cooldownMs = Math.max(0, Math.floor(policy.cooldownMs));
	const hourlyBudget = Math.max(0, Math.floor(policy.hourlyBudget));
	const maxAttempts = Math.max(0, Math.floor(policy.maxAttempts));
	if (hourlyBudget === 0 || maxAttempts === 0) return 0;
	const boundedPolicy = { cooldownMs, hourlyBudget, maxAttempts };
	return await runDbOwnerDomainOperation(accessor, {
		runWithOwner: async (owner) => {
			const handle = owner.submit<number>(
				{ kind: "dreaming_evidence_requeue", input: { nowMs, policy: boundedPolicy } },
				{
					operation: "dreaming.evidence.requeue",
					lane: "write",
					workloadClass: "foreground",
					deadlineMs: 30_000,
					estimatedWorkUnits: 500,
				},
			);
			return await handle.result;
		},
		runInline: ({ write }) => write((db) => autoRequeueRepairedDreamingEvidenceInDb(db, boundedPolicy, nowMs)),
	});
}
