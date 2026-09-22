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
	readonly operations: readonly { readonly operation: string; readonly ok: boolean; readonly error: string | null }[];
	readonly evidenceWindow: DreamingEvidenceWindow | null;
	readonly runbook: DreamingRunbookEntry | null;
	readonly quarantines: readonly { readonly sourceKind: string; readonly sourceId: string; readonly reason: string }[];
}

function parseRecord(value: string | null): Record<string, unknown> | null {
	if (!value) return null;
	try {
		const parsed: unknown = JSON.parse(value);
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

function parseTextList(value: unknown): readonly string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function parseDeferredEvidenceList(value: unknown): readonly DreamingDeferredEvidenceEntry[] {
	if (!Array.isArray(value)) return [];
	const entries: DreamingDeferredEvidenceEntry[] = [];
	for (const item of value) {
		if (typeof item === "string") {
			entries.push(item);
			continue;
		}
		if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
		const entry = item as Record<string, unknown>;
		if (typeof entry.agentId === "string" && typeof entry.sourceRef === "string") {
			entries.push({ agentId: entry.agentId, sourceRef: entry.sourceRef });
		}
	}
	return entries;
}

function parseReviewedExcludedEvidenceList(value: unknown): readonly DreamingReviewedExcludedEvidenceEntry[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((item) => {
		if (typeof item !== "object" || item === null || Array.isArray(item)) return [];
		const entry = item as Record<string, unknown>;
		if (typeof entry.agentId !== "string" || typeof entry.sourceRef !== "string" || typeof entry.reason !== "string")
			return [];
		const agentId = entry.agentId.trim();
		const sourceRef = entry.sourceRef.trim();
		const reason = entry.reason.trim();
		if (!agentId || !sourceRef || !reason) return [];
		return [
			{
				agentId,
				sourceRef,
				reason,
			},
		];
	});
}

function parseRunbook(value: string | null): DreamingRunbookEntry | null {
	const row = parseRecord(value);
	if (!row || typeof row.summary !== "string") return null;
	return {
		summary: row.summary,
		openQuestions: parseTextList(row.openQuestions),
		deferred: parseTextList(row.deferred),
		deferredEvidence: parseDeferredEvidenceList(row.deferredEvidence),
		reviewedExcludedEvidence: parseReviewedExcludedEvidenceList(row.reviewedExcludedEvidence),
	};
}

function parseEvidenceWindow(value: string | null): DreamingEvidenceWindow | null {
	const row = parseRecord(value);
	if (!row || typeof row.cursor !== "object" || row.cursor === null || Array.isArray(row.cursor)) return null;
	const cursor = row.cursor as Record<string, unknown>;
	if (typeof cursor.capturedAt !== "string" || typeof cursor.id !== "string") return null;
	const sources = Array.isArray(row.sources)
		? row.sources.flatMap((source) => {
				if (typeof source !== "object" || source === null || Array.isArray(source)) return [];
				const item = source as Record<string, unknown>;
				if (
					typeof item.sourceRef !== "string" ||
					typeof item.sourceKind !== "string" ||
					typeof item.sourceId !== "string"
				)
					return [];
				return [
					{
						sourceRef: item.sourceRef,
						sourceKind: item.sourceKind,
						sourceId: item.sourceId,
						sourcePath: typeof item.sourcePath === "string" ? item.sourcePath : null,
						chars: typeof item.chars === "number" && Number.isFinite(item.chars) ? Math.max(0, item.chars) : 0,
					},
				];
			})
		: [];
	return {
		cursor: {
			capturedAt: cursor.capturedAt,
			kind: typeof cursor.kind === "string" ? cursor.kind : null,
			id: cursor.id,
			...(typeof cursor.fragmentOffset === "number" &&
			Number.isSafeInteger(cursor.fragmentOffset) &&
			cursor.fragmentOffset > 0
				? { fragmentOffset: cursor.fragmentOffset }
				: {}),
		},
		sources,
	};
}

function operationResults(
	inputJson: string,
	outputJson: string,
): readonly { readonly operation: string; readonly ok: boolean; readonly error: string | null }[] {
	const input = parseRecord(inputJson);
	const output = parseRecord(outputJson);
	const operations = Array.isArray(input?.operations) ? input.operations : [];
	const items = Array.isArray(output?.items) ? output.items : [];
	const fallbackError = typeof output?.error === "string" ? output.error : null;
	return operations.flatMap((operation, index) => {
		if (typeof operation !== "object" || operation === null || Array.isArray(operation)) return [];
		const name = (operation as Record<string, unknown>).operation;
		if (typeof name !== "string") return [];
		const item = items[index];
		const result =
			typeof item === "object" && item !== null && !Array.isArray(item) ? (item as Record<string, unknown>) : null;
		return [
			{
				operation: name,
				ok: result?.ok === true,
				error: typeof result?.error === "string" ? result.error : fallbackError,
			},
		];
	});
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
	}, "pipeline/dreaming-runbook.ts:193");
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
export function readDreamingRunbook(accessor: DbAccessor, agentId: string, limit = 5): readonly DreamingRunbookPass[] {
	const boundedLimit = Math.min(Math.max(Math.floor(limit), 1), 20);
	// @ts-expect-error LEGACY_SYNC_DB_ACCESS: withReadDb migration site
	return accessor.withReadDb((db: import("../db-accessor").ReadDb) => {
		const rows = db
			.prepare(
				`SELECT id, mode, status, started_at AS startedAt, completed_at AS completedAt,
				        summary, error, mutations_applied AS mutationsApplied, mutations_failed AS mutationsFailed,
				        evidence_window_json AS evidenceWindowJson, runbook_json AS runbookJson
				 FROM dreaming_passes WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?`,
			)
			.all(agentId, boundedLimit) as Array<Record<string, unknown>>;
		const quarantines = db.prepare(
			`SELECT source_kind AS sourceKind, source_id AS sourceId, reason
			 FROM dreaming_evidence_exclusions WHERE agent_id = ? AND pass_id = ? AND resolved_at IS NULL
			 ORDER BY excluded_at DESC, source_kind ASC, source_id ASC`,
		);
		const operationCalls = db.prepare(
			`SELECT input_json AS inputJson, output_json AS outputJson
			 FROM dreaming_tool_calls WHERE agent_id = ? AND pass_id = ? AND tool_name = 'apply_ontology_ops'
			 ORDER BY sequence ASC`,
		);
		return rows.map((row) => ({
			passId: row.id as string,
			mode: row.mode as string,
			status: row.status as string,
			startedAt: row.startedAt as string,
			completedAt: (row.completedAt as string) ?? null,
			summary: (row.summary as string) ?? null,
			error: (row.error as string) ?? null,
			mutationsApplied: typeof row.mutationsApplied === "number" ? row.mutationsApplied : null,
			mutationsFailed: typeof row.mutationsFailed === "number" ? row.mutationsFailed : null,
			operations: (operationCalls.all(agentId, row.id) as Array<{ inputJson: string; outputJson: string }>).flatMap(
				(call) => operationResults(call.inputJson, call.outputJson),
			),
			evidenceWindow: parseEvidenceWindow((row.evidenceWindowJson as string) ?? null),
			runbook: parseRunbook((row.runbookJson as string) ?? null),
			quarantines: quarantines.all(agentId, row.id) as DreamingRunbookPass["quarantines"],
		}));
	}, "pipeline/dreaming-runbook.ts:231");
}
export function renderDreamingRunbookForPrompt(items: readonly DreamingRunbookPass[], maxChars = 6_000): string {
	if (items.length === 0) return "";
	const rendered = JSON.stringify(items);
	if (rendered.length <= maxChars) return rendered;
	return JSON.stringify({
		truncated: true,
		originalChars: rendered.length,
		recentPassIds: items.map((item) => item.passId),
	});
}
