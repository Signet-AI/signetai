import type { DbAccessor, WriteDb } from "../db-accessor";
import type { DreamingAgentEvidence } from "./dreaming-evidence";
import type { DreamingReviewedExcludedEvidenceEntry } from "./dreaming-evidence-reviews";

export interface DreamingDeferredEvidence {
	readonly agentId: string;
	readonly sourceRef: string;
}

export type DreamingDeferredEvidenceEntry = string | DreamingDeferredEvidence;

export interface DreamingRunbookEntry {
	readonly summary: string;
	readonly openQuestions: readonly string[];
	readonly deferred: readonly string[];
	readonly deferredEvidence: readonly DreamingDeferredEvidenceEntry[];
	readonly reviewedExcludedEvidence: readonly DreamingReviewedExcludedEvidenceEntry[];
}

export interface DreamingEvidenceWindow {
	readonly cursor: {
		readonly capturedAt: string;
		readonly kind: string | null;
		readonly id: string;
		readonly fragmentOffset?: number;
	};
	readonly sources: readonly {
		readonly sourceRef: string;
		readonly sourceKind: string;
		readonly sourceId: string;
		readonly sourcePath: string | null;
		readonly chars: number;
	}[];
}

export interface DreamingRunbookOperations {
	readonly applied: Readonly<Record<string, number>>;
	readonly failed: readonly { readonly operation: string; readonly error: string | null; readonly count: number }[];
}

export interface DreamingRunbookPass {
	readonly passId: string;
	readonly mode: string;
	readonly status: string;
	readonly startedAt: string;
	readonly completedAt: string | null;
	readonly summary: string | null;
	readonly error: string | null;
	readonly mutationsApplied: number | null;
	readonly mutationsFailed: number | null;
	readonly operations: DreamingRunbookOperations;
	readonly evidenceWindow: DreamingEvidenceWindow | null;
	readonly runbook: DreamingRunbookEntry | null;
	readonly quarantines: readonly { readonly sourceKind: string; readonly sourceId: string; readonly reason: string }[];
}

function serializeRunbook(entry: DreamingRunbookEntry): string {
	return JSON.stringify(entry);
}
export function writeDreamingRunbook(
	accessor: DbAccessor,
	params: { readonly agentId: string; readonly passId: string; readonly entry: DreamingRunbookEntry },
): boolean {
	// @ts-expect-error LEGACY_SYNC_DB_ACCESS: withWriteTx migration site
	return accessor.withWriteTx((db: import("../db-accessor").WriteDb) => {
		const result = db
			.prepare(
				`UPDATE dreaming_passes SET runbook_json = ?
				 WHERE id = ? AND agent_id = ? AND status = 'running'`,
			)
			.run(serializeRunbook(params.entry), params.passId, params.agentId);
		return result.changes === 1;
	}, "db:dreaming.runbook.write");
}
export function recordDreamingEvidenceWindowInTx(
	db: WriteDb,
	params: {
		readonly agentId: string;
		readonly passId: string;
		readonly cursor: DreamingEvidenceWindow["cursor"];
		readonly evidence: readonly DreamingAgentEvidence[];
	},
): void {
	const window: DreamingEvidenceWindow = {
		cursor: params.cursor,
		sources: params.evidence.map((source) => ({
			sourceRef: source.sourceRef,
			sourceKind: source.sourceKind,
			sourceId: source.sourceId,
			sourcePath: source.sourcePath,
			chars: source.content.length,
		})),
	};
	db.prepare("UPDATE dreaming_passes SET evidence_window_json = ? WHERE id = ? AND agent_id = ?").run(
		JSON.stringify(window),
		params.passId,
		params.agentId,
	);
}

export { readDreamingPassRecord } from "./dreaming";
