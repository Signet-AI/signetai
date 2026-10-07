import { createHash } from "node:crypto";
import type { WriteDb } from "./db-accessor";
import { readEpisodicSource } from "./episodic-sources";
import { enqueueDreamingAttentionInTx } from "./pipeline/dreaming-attention";

export interface SourceRevisionClaimReviewInput {
	readonly agentId: string;
	readonly sourceId: string;
	readonly sourcePath: string;
	readonly content: string;
}

function collapseWhitespace(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function quotesCitingSource(
	db: WriteDb,
	evidenceJson: string | null,
	input: SourceRevisionClaimReviewInput,
): readonly string[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(evidenceJson ?? "[]");
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) return [];
	const quotes: string[] = [];
	for (const item of parsed) {
		if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
		const citation = item as Record<string, unknown>;
		const quote = typeof citation.quote === "string" ? citation.quote.trim() : "";
		if (!quote) continue;
		if (citation.source_path === input.sourcePath || citation.source_ref === `artifact:${input.sourcePath}`) {
			quotes.push(quote);
			continue;
		}
		if (typeof citation.source_ref !== "string") continue;
		const source = readEpisodicSource(db, { agentId: input.agentId, from: citation.source_ref });
		if (source?.sourcePath === input.sourcePath && (source.sourceEntryId ?? source.sourceId) === input.sourceId) {
			quotes.push(quote);
		}
	}
	return quotes;
}

function stillStated(content: string, quotes: readonly string[]): boolean {
	if (quotes.length === 0) return false;
	const collapsed = collapseWhitespace(content);
	return quotes.every((quote) => content.includes(quote) || collapsed.includes(collapseWhitespace(quote)));
}

interface CitingClaimRow {
	readonly id: string;
	readonly aspect_id: string | null;
	readonly claim_key: string | null;
	readonly proposal_evidence: string | null;
	readonly entity_id: string | null;
	readonly source_path: string;
}

function activeDreamingClaimsCitingInTx(
	db: WriteDb,
	input: { readonly agentId: string; readonly sourceId: string; readonly sourcePath?: string },
): readonly CitingClaimRow[] {
	return db
		.prepare(
			`SELECT attr.id, attr.aspect_id, attr.claim_key, attr.proposal_evidence, asp.entity_id, attr.source_path
			 FROM entity_attributes attr
			 LEFT JOIN entity_aspects asp ON asp.id = attr.aspect_id
			 WHERE attr.agent_id = ? AND attr.source_id = ?${input.sourcePath === undefined ? "" : " AND attr.source_path = ?"}
			   AND attr.source_path IS NOT NULL
			   AND attr.source_root = 'dreaming' AND COALESCE(attr.status, 'active') = 'active'`,
		)
		.all(
			input.agentId,
			input.sourceId,
			...(input.sourcePath === undefined ? [] : [input.sourcePath]),
		) as CitingClaimRow[];
}

function flagClaimInTx(
	db: WriteDb,
	agentId: string,
	row: CitingClaimRow,
	details: Readonly<Record<string, string>>,
): void {
	enqueueDreamingAttentionInTx(db, {
		agentId,
		kind: "contested_claim",
		subjectRef: `attribute:${row.id}`,
		details: {
			attributeId: row.id,
			...(row.aspect_id ? { aspectId: row.aspect_id } : {}),
			...(row.entity_id ? { entityId: row.entity_id } : {}),
			...(row.claim_key ? { claimKey: row.claim_key } : {}),
			sourceRef: `artifact:${row.source_path}`,
			...details,
		},
		priority: 60,
		reopen: false,
	});
}

export function flagDreamingClaimsForSourceRevisionInTx(db: WriteDb, input: SourceRevisionClaimReviewInput): number {
	const rows = activeDreamingClaimsCitingInTx(db, input);
	if (rows.length === 0) return 0;
	const sourceRevision = createHash("sha256").update(input.content).digest("hex").slice(0, 16);
	let flagged = 0;
	for (const row of rows) {
		if (stillStated(input.content, quotesCitingSource(db, row.proposal_evidence, input))) continue;
		flagClaimInTx(db, input.agentId, row, { reason: "source_changed", sourceRevision });
		flagged++;
	}
	return flagged;
}

export function flagDreamingClaimsForRemovedSourcePathInTx(
	db: WriteDb,
	input: { readonly agentId: string; readonly sourceId: string; readonly sourcePath: string },
): number {
	const rows = activeDreamingClaimsCitingInTx(db, input);
	for (const row of rows) flagClaimInTx(db, input.agentId, row, { reason: "source_removed" });
	return rows.length;
}

export function flagDreamingClaimsForMissingSourcePathsInTx(
	db: WriteDb,
	input: { readonly agentId: string; readonly sourceId: string },
): number {
	const present = new Set(
		(
			db
				.prepare(
					"SELECT source_path FROM memory_artifacts WHERE agent_id = ? AND source_id = ? AND COALESCE(is_deleted, 0) = 0",
				)
				.all(input.agentId, input.sourceId) as Array<{ source_path: string }>
		).map((row) => row.source_path),
	);
	let flagged = 0;
	for (const row of activeDreamingClaimsCitingInTx(db, input)) {
		if (present.has(row.source_path)) continue;
		flagClaimInTx(db, input.agentId, row, { reason: "source_removed" });
		flagged++;
	}
	return flagged;
}
