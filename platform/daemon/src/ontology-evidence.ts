import type { ReadDb } from "./db-accessor";

export interface OntologyEvidenceRef {
	readonly sourceKind: string | null;
	readonly sourceId: string | null;
	readonly sourcePath: string | null;
	readonly memoryId?: string | null;
	readonly quote: string | null;
	readonly reference: unknown;
}

export interface OntologyEvidenceItem {
	readonly kind:
		| "provided_quote"
		| "session_transcript"
		| "memory_artifact"
		| "memory"
		| "ontology_proposal"
		| "unresolved";
	readonly found: boolean;
	readonly sourceKind: string | null;
	readonly sourceId: string | null;
	readonly sourcePath: string | null;
	readonly label: string;
	readonly excerpt: string;
	readonly reference: unknown;
}

interface SessionTranscriptEvidenceRow {
	readonly session_key: string;
	readonly content: string;
	readonly seen_at: string;
}

interface MemoryArtifactEvidenceRow {
	readonly source_path: string;
	readonly source_kind: string;
	readonly session_id: string;
	readonly session_key: string | null;
	readonly session_token: string;
	readonly content: string;
}

interface OntologyProposalEvidenceRow {
	readonly id: string;
	readonly operation: string;
	readonly rationale: string;
	readonly evidence: string;
	readonly created_at: string;
}

interface MemoryEvidenceRow {
	readonly id: string;
	readonly source_id: string | null;
	readonly source_type: string | null;
	readonly source_path: string | null;
	readonly content: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(record: Readonly<Record<string, unknown>>, key: string): string | null {
	const value = record[key];
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function tableExists(db: ReadDb, name: string): boolean {
	return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
}

function columnExists(db: ReadDb, table: string, column: string): boolean {
	const cols = db.prepare(`PRAGMA table_info(${table})`).all() as ReadonlyArray<Record<string, unknown>>;
	return cols.some((col) => col.name === column);
}

function unique(values: readonly (string | null | undefined)[]): string[] {
	return [
		...new Set(
			values.filter((value): value is string => value !== null && value !== undefined && value.trim().length > 0),
		),
	];
}

function sourceIdCandidates(value: string | null): string[] {
	if (value === null) return [];
	return unique([
		value,
		value.replace(/^transcript:/, ""),
		value.replace(/^session:/, ""),
		value.startsWith("transcript:") || value.startsWith("session:") ? null : `transcript:${value}`,
		value.startsWith("session:") ? null : `session:${value}`,
	]);
}

function compactExcerpt(content: string, quote: string | null, max = 1200): string {
	const text = content.replace(/\s+/g, " ").trim();
	if (text.length <= max) return text;
	if (quote !== null) {
		const cleanQuote = quote.replace(/\s+/g, " ").trim();
		const idx = text.toLowerCase().indexOf(cleanQuote.toLowerCase());
		if (idx >= 0) {
			const start = Math.max(0, idx - Math.floor((max - cleanQuote.length) / 2));
			const end = Math.min(text.length, start + max);
			return `${start > 0 ? "..." : ""}${text.slice(start, end).trim()}${end < text.length ? "..." : ""}`;
		}
	}
	return `${text.slice(0, max - 3).trim()}...`;
}

export function readOntologyEvidenceRef(value: unknown): OntologyEvidenceRef | null {
	if (typeof value === "string") {
		const trimmed = value.trim();
		return trimmed.length > 0
			? { sourceKind: null, sourceId: trimmed, sourcePath: null, memoryId: null, quote: null, reference: value }
			: null;
	}
	if (!isRecord(value)) return null;
	const transcriptId = readString(value, "transcript_id");
	const sessionKey = readString(value, "session_key");
	const proposalId = readString(value, "proposal_id");
	return {
		sourceKind:
			readString(value, "source_kind") ??
			(proposalId ? "ontology_proposal" : transcriptId || sessionKey ? "transcript" : null),
		sourceId:
			readString(value, "source_id") ??
			proposalId ??
			transcriptId ??
			sessionKey ??
			readString(value, "session_id") ??
			readString(value, "source"),
		sourcePath: readString(value, "source_path"),
		memoryId: readString(value, "memory_id"),
		quote: readString(value, "quote"),
		reference: value,
	};
}

export function uniqueOntologyEvidenceRefs(refs: readonly OntologyEvidenceRef[]): OntologyEvidenceRef[] {
	const seen = new Set<string>();
	return refs.filter((ref) => {
		const key = [
			ref.sourceKind ?? "",
			ref.sourceId ?? "",
			ref.sourcePath ?? "",
			ref.memoryId ?? "",
			ref.quote ?? "",
		].join("\0");
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

function readSessionTranscriptEvidence(
	db: ReadDb,
	agentId: string,
	ref: OntologyEvidenceRef,
): SessionTranscriptEvidenceRow | null {
	const ids = sourceIdCandidates(ref.sourceId);
	if (ids.length === 0 || !tableExists(db, "session_transcripts")) return null;
	const placeholders = ids.map(() => "?").join(", ");
	const seenExpr = columnExists(db, "session_transcripts", "updated_at")
		? "COALESCE(updated_at, created_at)"
		: "created_at";
	const row = db
		.prepare(
			`SELECT session_key, content, ${seenExpr} AS seen_at
			 FROM session_transcripts
			 WHERE agent_id = ? AND session_key IN (${placeholders})
			 ORDER BY ${seenExpr} DESC
			 LIMIT 1`,
		)
		.get(agentId, ...ids) as SessionTranscriptEvidenceRow | undefined;
	return row ?? null;
}

function readOntologyProposalEvidence(
	db: ReadDb,
	agentId: string,
	ref: OntologyEvidenceRef,
): OntologyProposalEvidenceRow | null {
	if (!tableExists(db, "ontology_proposals")) return null;
	const proposalId = ref.sourceKind === "ontology_proposal" ? ref.sourceId : null;
	if (proposalId === null) return null;
	const row = db
		.prepare(
			`SELECT id, operation, rationale, evidence, created_at
			 FROM ontology_proposals
			 WHERE id = ? AND agent_id = ?
			 LIMIT 1`,
		)
		.get(proposalId, agentId) as OntologyProposalEvidenceRow | undefined;
	return row ?? null;
}

function readMemoryArtifactEvidence(
	db: ReadDb,
	agentId: string,
	ref: OntologyEvidenceRef,
): MemoryArtifactEvidenceRow | null {
	if (!tableExists(db, "memory_artifacts")) return null;
	const ids = sourceIdCandidates(ref.sourceId);
	const filters = ["agent_id = ?", "COALESCE(is_deleted, 0) = 0"];
	const args: unknown[] = [agentId];
	if (ref.sourcePath !== null) {
		filters.push("source_path = ?");
		args.push(ref.sourcePath);
	} else if (ids.length > 0) {
		const placeholders = ids.map(() => "?").join(", ");
		filters.push(
			`(source_node_id IN (${placeholders})
			  OR session_id IN (${placeholders})
			  OR session_key IN (${placeholders})
			  OR session_token IN (${placeholders})
			  OR source_path IN (${placeholders}))`,
		);
		args.push(...ids, ...ids, ...ids, ...ids, ...ids);
	} else {
		return null;
	}
	const row = db
		.prepare(
			`SELECT source_path, source_kind, session_id, session_key, session_token, content
			 FROM memory_artifacts
			 WHERE ${filters.join(" AND ")}
			 ORDER BY captured_at DESC
			 LIMIT 1`,
		)
		.get(...args) as MemoryArtifactEvidenceRow | undefined;
	return row ?? null;
}

function readMemoryEvidence(db: ReadDb, agentId: string, ref: OntologyEvidenceRef): MemoryEvidenceRow | null {
	if (!ref.memoryId || !tableExists(db, "memories")) return null;
	const row = db
		.prepare(
			`SELECT id, source_id, source_type, source_path, content
			 FROM memories
			 WHERE id = ? AND agent_id = ? AND COALESCE(is_deleted, 0) = 0
			 LIMIT 1`,
		)
		.get(ref.memoryId, agentId) as MemoryEvidenceRow | undefined;
	return row ?? null;
}

function sourceLooksLikeTranscript(ref: OntologyEvidenceRef): boolean {
	return (
		ref.sourceKind === "transcript" ||
		ref.sourceKind === "session_transcript" ||
		ref.sourceId?.startsWith("transcript:") === true ||
		ref.sourceId?.startsWith("session:") === true
	);
}

export function resolveOntologyEvidenceRef(
	db: ReadDb,
	agentId: string,
	ref: OntologyEvidenceRef,
): OntologyEvidenceItem {
	const proposal = readOntologyProposalEvidence(db, agentId, ref);
	if (proposal !== null) {
		return {
			kind: "ontology_proposal",
			found: true,
			sourceKind: "ontology_proposal",
			sourceId: proposal.id,
			sourcePath: ref.sourcePath,
			label: `proposal:${proposal.id}`,
			excerpt: compactExcerpt((ref.quote ?? proposal.rationale) || proposal.evidence, null),
			reference: ref.reference,
		};
	}

	const sourcePathArtifact = ref.sourcePath !== null ? readMemoryArtifactEvidence(db, agentId, ref) : null;
	if (sourcePathArtifact !== null) {
		return {
			kind: "memory_artifact",
			found: true,
			sourceKind: sourcePathArtifact.source_kind,
			sourceId: sourcePathArtifact.session_key ?? sourcePathArtifact.session_id ?? sourcePathArtifact.session_token,
			sourcePath: sourcePathArtifact.source_path,
			label: sourcePathArtifact.source_path,
			excerpt: compactExcerpt(sourcePathArtifact.content, ref.quote),
			reference: ref.reference,
		};
	}

	const transcript = sourceLooksLikeTranscript(ref) ? readSessionTranscriptEvidence(db, agentId, ref) : null;
	if (transcript !== null) {
		return {
			kind: "session_transcript",
			found: true,
			sourceKind: ref.sourceKind ?? "transcript",
			sourceId: transcript.session_key,
			sourcePath: ref.sourcePath,
			label: `transcript:${transcript.session_key}`,
			excerpt: compactExcerpt(transcript.content, ref.quote),
			reference: ref.reference,
		};
	}

	const artifact = ref.sourcePath === null ? readMemoryArtifactEvidence(db, agentId, ref) : null;
	if (artifact !== null) {
		return {
			kind: "memory_artifact",
			found: true,
			sourceKind: artifact.source_kind,
			sourceId: artifact.session_key ?? artifact.session_id ?? artifact.session_token,
			sourcePath: artifact.source_path,
			label: artifact.source_path,
			excerpt: compactExcerpt(artifact.content, ref.quote),
			reference: ref.reference,
		};
	}

	const memory = readMemoryEvidence(db, agentId, ref);
	if (memory !== null) {
		return {
			kind: "memory",
			found: true,
			sourceKind: memory.source_type,
			sourceId: memory.source_id ?? memory.id,
			sourcePath: memory.source_path,
			label: `memory:${memory.id}`,
			excerpt: compactExcerpt(memory.content, ref.quote),
			reference: ref.reference,
		};
	}

	if (ref.quote !== null) {
		return {
			kind: "provided_quote",
			found: true,
			sourceKind: ref.sourceKind,
			sourceId: ref.sourceId,
			sourcePath: ref.sourcePath,
			label: "embedded quote",
			excerpt: compactExcerpt(ref.quote, null),
			reference: ref.reference,
		};
	}

	return {
		kind: "unresolved",
		found: false,
		sourceKind: ref.sourceKind,
		sourceId: ref.sourceId,
		sourcePath: ref.sourcePath,
		label: ref.sourcePath ?? ref.sourceId ?? ref.memoryId ?? "unknown evidence",
		excerpt: "",
		reference: ref.reference,
	};
}
