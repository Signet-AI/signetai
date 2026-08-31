import type { ReadDb, WriteDb } from "../db-accessor";
import { type EpisodicSourceKind, type EpisodicSourceRecord, readEpisodicSource } from "../episodic-sources";
import { renderDreamingEvidence } from "./dreaming-evidence";

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
	readonly content: string;
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

/** Parse exact fragments persisted in Dreaming tool-call output. Invalid rows never acknowledge evidence. */
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
		const agentId = text(record(input)?.agentId);
		const data = record(output);
		if (!agentId || data?.ok !== true || !Array.isArray(data.items)) return [];
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
			const length =
				typeof row?.contentLength === "number" && Number.isSafeInteger(row.contentLength) ? row.contentLength : null;
			if (
				!parsed ||
				!capturedAt ||
				!sourceRevision ||
				start === null ||
				!content ||
				length === null ||
				start < 0 ||
				length < start
			)
				return [];
			const end = start + content.length;
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
					content,
				},
			];
		});
	});
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
		rendered.slice(delivery.start, delivery.end) !== delivery.content
	) {
		return null;
	}
	return source;
}

/** Advance only contiguous delivery. A fragment after a gap is durable audit evidence but never a completion acknowledgement. */
export function recordDreamingEvidenceConsumptionInTx(
	db: WriteDb,
	params: { readonly passId: string; readonly deferredEvidence: ReadonlySet<string> },
): void {
	if (!tableExists(db, "dreaming_evidence_consumption")) return;
	const deliveries = persistedEvidenceDeliveries(db, params.passId)
		.filter((delivery) => !params.deferredEvidence.has(`${delivery.agentId}\u0000${delivery.kind}:${delivery.id}`))
		.sort(
			(a, b) =>
				a.agentId.localeCompare(b.agentId) ||
				a.kind.localeCompare(b.kind) ||
				a.id.localeCompare(b.id) ||
				a.capturedAt.localeCompare(b.capturedAt) ||
				a.start - b.start ||
				a.end - b.end,
		);
	const select = db.prepare(
		`SELECT delivered_offset AS deliveredOffset FROM dreaming_evidence_consumption
		 WHERE agent_id = ? AND source_kind = ? AND source_id = ? AND source_captured_at = ? AND source_entry_id = ? AND source_revision = ?`,
	);
	const upsert = db.prepare(
		`INSERT INTO dreaming_evidence_consumption
		 (agent_id, source_kind, source_id, source_captured_at, source_entry_id, source_revision, delivered_offset, source_length, pass_id, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
		 ON CONFLICT(agent_id, source_kind, source_id, source_captured_at, source_entry_id, source_revision) DO UPDATE SET
		   delivered_offset = excluded.delivered_offset,
		   source_length = excluded.source_length,
		   pass_id = excluded.pass_id,
		   updated_at = excluded.updated_at`,
	);
	for (const delivery of deliveries) {
		const source = verifiedDreamingEvidenceDelivery(db, delivery);
		if (source === null) continue;
		const identity = sourceIdentity(source);
		const revision = sourceRevision(source);
		const row = select.get(delivery.agentId, delivery.kind, delivery.id, delivery.capturedAt, identity, revision) as {
			deliveredOffset: number;
		} | null;
		const current = row?.deliveredOffset ?? 0;
		if (delivery.start > current) continue;
		const next = Math.max(current, delivery.end);
		if (next <= current && row != null) continue;
		upsert.run(
			delivery.agentId,
			delivery.kind,
			delivery.id,
			delivery.capturedAt,
			identity,
			revision,
			Math.min(next, delivery.length),
			delivery.length,
			params.passId,
		);
	}
}

export function deliveredOffsetForSource(db: ReadDb, agentId: string, source: EpisodicSourceRecord): number {
	if (!tableExists(db, "dreaming_evidence_consumption")) return 0;
	const row = db
		.prepare(
			`SELECT delivered_offset AS deliveredOffset FROM dreaming_evidence_consumption
		 WHERE agent_id = ? AND source_kind = ? AND source_id = ? AND source_captured_at = ? AND source_entry_id = ? AND source_revision = ?`,
		)
		.get(agentId, source.kind, source.id, source.capturedAt, sourceIdentity(source), sourceRevision(source)) as {
		deliveredOffset: number;
	} | null;
	return Math.max(0, row?.deliveredOffset ?? 0);
}

/**
 * A completed content pass made bounded progress and left one of its delivered
 * source revisions incomplete. The worker uses this only to schedule the next
 * regular sweep: a later no-progress pass has a different id, so it cannot
 * create a self-sustaining retry loop.
 */
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

/**
 * Return a bounded fair slice of every incomplete current revision. Earlier
 * delivery passes go first, so advancing one capped subset cannot strand the
 * rest of an older subset behind the most recent pass. A scan-first pass
 * receives these sources before consulting the ordinary newest-first queue,
 * so a busy stream cannot strand partial evidence below its next page.
 */
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
			 INNER JOIN dreaming_passes pass ON pass.id = dec.pass_id AND pass.agent_id = dec.agent_id
			 WHERE dec.agent_id = ?
			   AND dec.delivered_offset > 0 AND dec.delivered_offset < dec.source_length
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
		.all(agentId, kind ?? null, kind ?? null, boundedLimit) as Array<{
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

/** Count current, eligible source-owned evidence using the same delivery frontier and terminal review rules as Dreaming scans. */
export function countEligibleUnconsumedEvidenceForSource(
	db: ReadDb,
	agentId: string,
	sourceEntryId: string,
	_legacyObsidianRoot?: string,
): number {
	if (!tableExists(db, "dreaming_evidence_consumption")) return 1;
	const legacyRootPrefix = _legacyObsidianRoot?.replace(/\\/g, "/").replace(/\/$/, "") ?? null;
	const candidates: Array<{ kind: EpisodicSourceKind; id: string }> = [
		...(
			db
				.prepare(
					`SELECT source_path AS id FROM memory_artifacts
					 WHERE agent_id = ? AND COALESCE(is_deleted, 0) = 0 AND length(content) > 0
					   AND (source_id = ? OR (? IS NOT NULL AND harness = 'obsidian' AND source_id IS NULL AND source_path >= ? AND source_path < ?))`,
				)
				.all(
					agentId,
					sourceEntryId,
					legacyRootPrefix,
					legacyRootPrefix ?? "",
					`${legacyRootPrefix ?? ""}/\uffff`,
				) as Array<{ id: string }>
		).map((row) => ({ kind: "artifact" as const, id: row.id })),
		...(
			db
				.prepare(
					"SELECT session_key AS id FROM session_transcripts WHERE agent_id = ? AND source_id = ? AND completed_at IS NOT NULL",
				)
				.all(agentId, sourceEntryId) as Array<{ id: string }>
		).map((row) => ({ kind: "transcript" as const, id: row.id })),
	];
	return candidates.reduce((count, candidate) => {
		const source = readEpisodicSource(db, { agentId, from: `${candidate.kind}:${candidate.id}` });
		if (source === null) return count;
		const reviewed =
			tableExists(db, "dreaming_evidence_reviews") &&
			db
				.prepare(
					`SELECT 1 FROM dreaming_evidence_reviews WHERE agent_id = ? AND source_kind = ? AND source_id = ? AND source_captured_at = ? AND source_entry_id = ? AND source_revision = ?`,
				)
				.get(agentId, source.kind, source.id, source.capturedAt, sourceIdentity(source), sourceRevision(source)) !=
				null;
		return reviewed || deliveredOffsetForSource(db, agentId, source) >= renderDreamingEvidence(source).length
			? count
			: count + 1;
	}, 0);
}

export function sourceHasEligibleUnconsumedEvidence(
	db: ReadDb,
	agentId: string,
	sourceEntryId: string,
	legacyObsidianRoot?: string,
): boolean {
	return countEligibleUnconsumedEvidenceForSource(db, agentId, sourceEntryId, legacyObsidianRoot) > 0;
}
