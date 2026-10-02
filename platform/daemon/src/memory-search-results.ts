import type { RecallResult } from "./memory-search";
import type { ScoredRecallCandidate } from "./memory-search-candidates";

export interface RecallCurrentnessInfo {
	readonly active: readonly string[];
	readonly superseded: ReadonlyArray<{
		readonly content: string;
		readonly replacement: string | null;
	}>;
}

export interface MemoryRecallRow {
	readonly id: string;
	readonly content: string;
	readonly source_id: string | null;
	readonly type: string;
	readonly tags: string | null;
	readonly pinned: number;
	readonly importance: number;
	readonly who: string;
	readonly project: string | null;
	readonly created_at: string;
	readonly visibility: string | null;
	readonly scope: string | null;
	readonly agent_id: string | null;
}

export function projectAuthorizedRecallResults(
	candidates: readonly ScoredRecallCandidate[],
	safeRows: readonly MemoryRecallRow[],
	currentness: ReadonlyMap<string, RecallCurrentnessInfo>,
	candidateLimit: number,
	contentLimit: number,
): RecallResult[] {
	const rowsById = new Map(safeRows.map((row) => [row.id, row]));
	return candidates.slice(0, candidateLimit).flatMap((candidate) => {
		const row = rowsById.get(candidate.id);
		if (!row) return [];
		const content = annotateCurrentness(row.content, currentness.get(row.id));
		const truncated = content.length > contentLimit;
		return [
			{
				id: row.id,
				content: truncated ? `${content.slice(0, contentLimit)} [truncated]` : content,
				content_length: content.length,
				truncated,
				score: Math.round(candidate.score * 100) / 100,
				source: candidate.source,
				...(row.source_id ? { source_id: row.source_id, session_id: sessionIdFromSourceId(row.source_id) } : {}),
				type: row.type,
				tags: row.tags,
				pinned: !!row.pinned,
				importance: row.importance,
				who: row.who,
				project: row.project,
				created_at: row.created_at,
				visibility: row.visibility,
				scope: row.scope,
			},
		];
	});
}

export function appendRecallResultsWithinLimit(
	results: RecallResult[],
	candidates: readonly RecallResult[],
	limit: number,
): void {
	for (const candidate of candidates) {
		if (results.length >= limit) break;
		results.push(candidate);
	}
}

function annotateCurrentness(content: string, info: RecallCurrentnessInfo | undefined): string {
	if (!info || info.superseded.length === 0) return content;
	const lines = ["[Signet currentness]"];
	if (info.active.length > 0) {
		lines.push("Current structured facts:");
		for (const item of info.active) lines.push(`- ${item}`);
	}
	if (info.superseded.length > 0) {
		lines.push("Superseded structured facts, historical unless the question asks about the past:");
		for (const item of info.superseded) {
			lines.push(`- ${item.content}`);
			if (item.replacement) lines.push(`  Current replacement: ${item.replacement}`);
		}
	}
	return `${lines.join("\n")}\n\n${content}`;
}

function sessionIdFromSourceId(sourceId: string): string {
	const index = sourceId.lastIndexOf(":");
	return index >= 0 ? sourceId.slice(index + 1) : sourceId;
}
