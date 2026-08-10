import type { AttributeKind, Entity, EntityAspect, EntityAttribute, EpistemicAssertion } from "@signet/core";
import type { DbAccessor, ReadDb } from "./db-accessor";
import { tableExists } from "./db-helpers";
import { findEpisodicSourceAgentIds, readEpisodicSource, sourceIdCandidates } from "./episodic-sources";
import { listEntityAttributesByPath } from "./knowledge-graph";

const SOURCE_KINDS = ["memory", "artifact", "transcript", "summary"] as const;
const MAX_VERSION_LIMIT = 50;
const MAX_PREMISE_LIMIT = 100;
const MAX_REVERSE_LIMIT = 100;
const MAX_DEPTH = 3;
const MAX_EXCERPT_LENGTH = 1200;

type TraceSourceKind = (typeof SOURCE_KINDS)[number];
type TraceIntegrity = "verified" | "unverified" | "invalidated";

interface TraceReference {
	readonly sourceKind: string | null;
	readonly sourceId: string | null;
	readonly sourcePath: string | null;
	readonly quote: string | null;
	readonly strict?: boolean;
	readonly derivedMemoryId?: string | null;
	readonly reference: unknown;
}

interface TraceSource {
	readonly kind: TraceSourceKind;
	readonly id: string;
	readonly path: string | null;
	readonly content: string | null;
	readonly project: string | null;
	readonly visibility: string | null;
	readonly scope: string | null;
	readonly sessionKeys: readonly string[];
	readonly state: "available" | "deleted" | "stale" | "incomplete";
}

interface TraceEvidence {
	readonly sourceKind: TraceSourceKind;
	readonly sourceId: string;
	readonly sourcePath: string | null;
	readonly exactQuote: string | null;
	readonly excerpt: string | null;
	readonly found: boolean;
	readonly state: TraceSource["state"] | "quote_unverified";
	readonly scope: {
		readonly agentId: string;
		readonly project: string | null;
		readonly visibility: string | null;
		readonly sessionKeys: readonly string[];
	};
	readonly reference: unknown;
}

interface TracePremise {
	readonly depth: number;
	readonly derivedMemoryId: string | null;
	readonly evidence: TraceEvidence;
}

interface TraceVersion {
	readonly attribute: EntityAttribute;
	readonly lifecycle: {
		readonly status: EntityAttribute["status"];
		readonly memoryId: string | null;
		readonly memoryPresent: boolean;
		readonly staleAt: string | null;
		readonly supersededBy: string | null;
	};
	readonly history: {
		readonly version: number | null;
		readonly versionRootId: string | null;
		readonly previousAttributeId: string | null;
		readonly supersededBy: string | null;
	};
}

interface TraceAssertion {
	readonly id: string;
	readonly agentId: string;
	readonly subjectEntityId: string;
	readonly subjectEntityName: string | null;
	readonly claimAttributeId: string | null;
	readonly predicate: EpistemicAssertion["predicate"];
	readonly content: string;
	readonly normalizedContent: string;
	readonly speaker: string | null;
	readonly assertedAt: string;
	readonly confidence: number;
	readonly evidence: readonly unknown[];
	readonly sourceKind: string | null;
	readonly sourceId: string | null;
	readonly sourcePath: string | null;
	readonly sourceRoot: string | null;
	readonly status: EpistemicAssertion["status"];
	readonly supersedesAssertionId: string | null;
	readonly archivedAt: string | null;
	readonly archivedBy: string | null;
	readonly archiveReason: string | null;
	readonly createdBy: string;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly evidenceRefs: readonly TraceReference[];
}

interface ReverseTraceItem {
	readonly attributeId: string | null;
	readonly memoryId: string;
	readonly entity: string | null;
	readonly aspect: string | null;
	readonly groupKey: string | null;
	readonly claimKey: string | null;
	readonly content: string;
	readonly status: string;
	readonly depth: number;
}

export interface ExplainClaimParams {
	readonly agentId: string;
	readonly entity: string;
	readonly aspect: string;
	readonly group: string;
	readonly claim: string;
	readonly kind?: AttributeKind;
	readonly versionLimit?: number;
	readonly premiseLimit?: number;
	readonly reverseLimit?: number;
	readonly maxDepth?: number;
	readonly sessionKey?: string | null;
	readonly project?: string | null;
}

export interface ClaimTraceResult {
	readonly entity: Entity;
	readonly aspect: EntityAspect;
	readonly path: {
		readonly groupKey: string;
		readonly claimKey: string;
		readonly kind: AttributeKind | null;
	};
	readonly current: {
		readonly items: readonly TraceVersion[];
		readonly status: "active" | "competing" | "historical" | "empty";
	};
	readonly versions: {
		readonly items: readonly TraceVersion[];
		readonly truncated: boolean;
	};
	readonly competing: {
		readonly items: readonly TraceVersion[];
		readonly contradictoryAssertions: readonly TraceAssertion[];
	};
	readonly assertions: readonly TraceAssertion[];
	readonly premises: {
		readonly items: readonly TracePremise[];
		readonly truncated: boolean;
	};
	readonly reverse: {
		readonly items: readonly ReverseTraceItem[];
		readonly truncated: boolean;
	};
	readonly authorization: {
		readonly agentId: string;
		readonly project: string | null;
		readonly sessionKey: string | null;
		readonly decisions: {
			readonly agent: "allowed";
			readonly project: "unrestricted" | "allowed";
			readonly session: "unrestricted" | "allowed";
		};
		readonly readPath: "recall";
	};
	readonly integrity: {
		readonly status: TraceIntegrity;
		readonly verifiedPremises: number;
		readonly invalidatedPremises: number;
		readonly unverifiedPremises: number;
		readonly reason: string | null;
	};
	readonly traversal: {
		readonly limits: {
			readonly versionLimit: number;
			readonly premiseLimit: number;
			readonly reverseLimit: number;
			readonly maxDepth: number;
		};
		readonly versionsVisited: number;
		readonly premisesVisited: number;
		readonly reverseVisited: number;
		readonly maxDepthReached: number;
		readonly bounded: true;
	};
	readonly latencyMs: number;
}

export class OntologyClaimTraceError extends Error {
	constructor(
		message: string,
		readonly status: 400 | 403 | 404 | 409,
	) {
		super(message);
		this.name = "OntologyClaimTraceError";
	}
}

interface MemoryStateRow {
	id: string;
	is_deleted: number | null;
	stale_at: string | null;
	superseded_by: string | null;
	project: string | null;
	visibility: string | null;
	scope: string | null;
}

interface RawAssertionRow {
	id: string;
	agent_id: string;
	subject_entity_id: string;
	subject_entity_name: string | null;
	claim_attribute_id: string | null;
	predicate: EpistemicAssertion["predicate"];
	content: string;
	normalized_content: string;
	speaker: string | null;
	asserted_at: string;
	confidence: number;
	evidence: string;
	source_kind: string | null;
	source_id: string | null;
	source_path: string | null;
	source_root: string | null;
	status: EpistemicAssertion["status"];
	supersedes_assertion_id: string | null;
	archived_at: string | null;
	archived_by: string | null;
	archive_reason: string | null;
	created_by: string;
	created_at: string;
	updated_at: string;
}

interface RawReverseRow {
	readonly memory_id: string;
	readonly attribute_id: string | null;
	readonly entity_name: string | null;
	readonly aspect_name: string | null;
	readonly group_key: string | null;
	readonly claim_key: string | null;
	readonly content: string;
	readonly status: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function parseJsonArray(value: string | null | undefined): readonly unknown[] {
	if (!value) return [];
	try {
		const parsed: unknown = JSON.parse(value);
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

function parseReference(value: unknown): TraceReference | null {
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (!trimmed) return null;
		const separator = trimmed.indexOf(":");
		return separator > 0
			? {
					sourceKind: trimmed.slice(0, separator),
					sourceId: trimmed.slice(separator + 1),
					sourcePath: null,
					quote: null,
					strict: true,
					reference: value,
				}
			: { sourceKind: null, sourceId: trimmed, sourcePath: null, quote: null, strict: true, reference: value };
	}
	if (!isRecord(value)) return null;
	const sourceRef = stringValue(value.source_ref) ?? stringValue(value.sourceRef);
	let sourceKind = stringValue(value.source_kind) ?? stringValue(value.sourceKind);
	let sourceId = stringValue(value.source_id) ?? stringValue(value.sourceId);
	if (sourceRef) {
		const separator = sourceRef.indexOf(":");
		if (separator > 0 && separator < sourceRef.length - 1) {
			sourceKind = sourceRef.slice(0, separator);
			sourceId = sourceRef.slice(separator + 1);
		}
	}
	if (!sourceId) sourceId = stringValue(value.memory_id) ?? stringValue(value.memoryId);
	if (!sourceKind && (value.memory_id !== undefined || value.memoryId !== undefined) && sourceId) {
		sourceKind = "memory";
	}
	return {
		sourceKind,
		sourceId,
		sourcePath: stringValue(value.source_path) ?? stringValue(value.sourcePath),
		quote: stringValue(value.quote),
		strict:
			Boolean(sourceRef) ||
			(canonicalSourceKind(sourceKind) !== null && sourceId !== null) ||
			Boolean(value.memory_id) ||
			Boolean(value.memoryId),
		reference: value,
	};
}

function canonicalSourceKind(value: string | null): TraceSourceKind | null {
	if (!value) return null;
	return SOURCE_KINDS.includes(value as TraceSourceKind) ? (value as TraceSourceKind) : null;
}

function sourceRefParts(reference: TraceReference): { readonly kind: string | null; readonly id: string } {
	const explicitKind = reference.sourceKind;
	const sourceId = reference.sourceId?.trim() ?? "";
	if (explicitKind) return { kind: explicitKind, id: sourceId };
	const separator = sourceId.indexOf(":");
	if (separator > 0 && separator < sourceId.length - 1) {
		return { kind: sourceId.slice(0, separator), id: sourceId.slice(separator + 1) };
	}
	return { kind: null, id: sourceId };
}

function mergeReferences(references: readonly TraceReference[]): TraceReference[] {
	const merged = new Map<string, TraceReference>();
	const quotedBases = new Set<string>();
	for (const reference of references) {
		const parts = sourceRefParts(reference);
		const kind = parts.kind;
		const id = parts.id;
		const baseKey = `${kind ?? ""}\u0000${id}\u0000${reference.sourcePath ?? ""}`;
		if (reference.quote !== null) {
			const key = `${baseKey}\u0000quote\u0000${reference.quote}`;
			merged.delete(`${baseKey}\u0000noquote`);
			if (!merged.has(key)) {
				merged.set(key, {
					...reference,
					sourceKind: kind,
					sourceId: id,
				});
			}
			quotedBases.add(baseKey);
			continue;
		}
		if (quotedBases.has(baseKey)) continue;
		const key = `${baseKey}\u0000noquote`;
		if (!merged.has(key)) {
			merged.set(key, {
				...reference,
				sourceKind: kind,
				sourceId: id,
			});
		}
	}
	return [...merged.values()];
}

function compactExcerpt(content: string, quote: string): string {
	const index = content.indexOf(quote);
	const start = Math.max(0, index - Math.floor((MAX_EXCERPT_LENGTH - quote.length) / 2));
	const end = Math.min(content.length, start + MAX_EXCERPT_LENGTH);
	return `${start > 0 ? "..." : ""}${content.slice(start, end)}${end < content.length ? "..." : ""}`;
}

function publicReference(value: unknown): unknown | null {
	const parsed = parseReference(value);
	if (!parsed) return null;
	const kind = canonicalSourceKind(parsed.sourceKind);
	const sourceId = parsed.sourceId?.trim() ?? "";
	if (!kind || !sourceId) return null;
	if (typeof value === "string") return `${kind}:${sourceId}`;
	if (!isRecord(value)) return null;

	// Evidence metadata is untrusted input. Return only the canonical source
	// identity and human-readable span fields; in particular, never echo
	// session IDs/tokens or connector-specific metadata from the stored object.
	const result: Record<string, string> = { source_ref: `${kind}:${sourceId}` };
	const sourcePath = parsed.sourcePath;
	const quote = parsed.quote;
	const sourceRoot = stringValue(value.source_root) ?? stringValue(value.sourceRoot);
	if (sourcePath) result.source_path = sourcePath;
	if (sourceRoot) result.source_root = sourceRoot;
	if (quote) result.quote = quote;
	return result;
}

function publicEvidence(values: readonly unknown[]): readonly unknown[] {
	return values.map(publicReference).filter((item): item is unknown => item !== null);
}

function visibleSessionKeys(sessionKey: string | null): readonly string[] {
	// Source-native session tokens remain internal authorization material. Only
	// echo the boundary the caller explicitly supplied; never return discovered
	// session IDs/tokens from artifact metadata.
	return sessionKey === null ? [] : [sessionKey];
}

function boundedInteger(value: number | undefined, fallback: number, max: number, name: string): number {
	const normalized = value ?? fallback;
	if (!Number.isInteger(normalized) || normalized < 1 || normalized > max) {
		throw new OntologyClaimTraceError(`${name} must be an integer between 1 and ${max}`, 400);
	}
	return normalized;
}

function boundedDepth(value: number | undefined): number {
	const normalized = value ?? MAX_DEPTH;
	if (!Number.isInteger(normalized) || normalized < 0 || normalized > MAX_DEPTH) {
		throw new OntologyClaimTraceError(`maxDepth must be an integer between 0 and ${MAX_DEPTH}`, 400);
	}
	return normalized;
}

function memoryState(db: ReadDb, agentId: string, memoryId: string | null): MemoryStateRow | null {
	if (!memoryId || !tableExists(db, "memories")) return null;
	return (
		(db
			.prepare(
				`SELECT id, COALESCE(is_deleted, 0) AS is_deleted, stale_at, superseded_by, project, visibility, scope
			 FROM memories WHERE id = ? AND agent_id = ? LIMIT 1`,
			)
			.get(memoryId, agentId) as MemoryStateRow | undefined) ?? null
	);
}

function requireProjectScopedAttribute(db: ReadDb, attribute: EntityAttribute, project: string | null): void {
	if (project === null) return;
	const memory = memoryState(db, attribute.agentId, attribute.memoryId);
	if (!memory || memory.project !== project) {
		throw new OntologyClaimTraceError("Claim is outside the authorized project scope", 403);
	}
}

function sourceSessionKeys(
	db: ReadDb,
	agentId: string,
	kind: TraceSourceKind,
	id: string,
	path: string | null,
): string[] {
	const keys = new Set<string>();
	const candidates = sourceIdCandidates(id);
	const placeholders = candidates.map(() => "?").join(", ");
	if (kind === "transcript") keys.add(id.replace(/^(transcript|session):/, ""));
	if (kind === "artifact" && tableExists(db, "memory_artifacts")) {
		const rows = db
			.prepare(
				`SELECT session_id, session_key, session_token
				 FROM memory_artifacts
				 WHERE agent_id = ? AND (
				   source_path = ? OR source_node_id IN (${placeholders}) OR session_id IN (${placeholders})
				   OR session_key IN (${placeholders}) OR session_token IN (${placeholders})
				 )`,
			)
			.all(agentId, path ?? id, ...candidates, ...candidates, ...candidates, ...candidates) as Array<{
			readonly session_id: string | null;
			readonly session_key: string | null;
			readonly session_token: string | null;
		}>;
		for (const row of rows) {
			for (const value of [row.session_key, row.session_id, row.session_token]) {
				if (value) keys.add(value);
			}
		}
	}
	if (kind === "summary" && tableExists(db, "session_summaries")) {
		const rows = db
			.prepare(
				`SELECT session_key, source_ref FROM session_summaries
				 WHERE agent_id = ? AND (id IN (${placeholders}) OR source_ref IN (${placeholders}))`,
			)
			.all(agentId, ...candidates, ...candidates) as Array<{
			readonly session_key: string | null;
			readonly source_ref: string | null;
		}>;
		for (const row of rows) {
			if (row.session_key) keys.add(row.session_key);
			const sourceRef = row.source_ref?.trim();
			if (sourceRef?.startsWith("session:") || sourceRef?.startsWith("transcript:")) {
				keys.add(sourceRef.slice(sourceRef.indexOf(":") + 1));
			}
		}
	}
	if (kind === "memory" && tableExists(db, "memories")) {
		const row = db
			.prepare("SELECT source_type, source_id FROM memories WHERE id = ? AND agent_id = ? LIMIT 1")
			.get(id, agentId) as { readonly source_type: string | null; readonly source_id: string | null } | undefined;
		if (row?.source_id) {
			if (row.source_type === "transcript" || row.source_type === "session") {
				keys.add(row.source_id.replace(/^(transcript|session):/, ""));
			}
			if (tableExists(db, "memory_artifacts")) {
				const linked = db
					.prepare(
						`SELECT session_key, session_id, session_token FROM memory_artifacts
							 WHERE agent_id = ? AND (source_node_id = ? OR source_id = ?)`,
					)
					.all(agentId, row.source_id, row.source_id) as Array<{
					readonly session_key: string | null;
					readonly session_id: string | null;
					readonly session_token: string | null;
				}>;
				for (const linkedRow of linked) {
					for (const value of [linkedRow.session_key, linkedRow.session_id, linkedRow.session_token]) {
						if (value) keys.add(value);
					}
				}
			}
		}
	}
	return [...keys];
}

function sourceAgentIds(db: ReadDb, kind: TraceSourceKind, id: string, path: string | null): readonly string[] {
	// This is an ownership probe, not a content read: it deliberately checks
	// all agent rows so an inaccessible source is forbidden rather than
	// misreported as missing. The returned rows contain agent IDs only; every
	// source body is still read through the requested agent scope below.
	const owners = new Set(findEpisodicSourceAgentIds(db, `${kind}:${path ?? id}`));
	const candidates = sourceIdCandidates(id);
	const placeholders = candidates.map(() => "?").join(", ");
	if (kind === "memory" && tableExists(db, "memories")) {
		const rows = db
			.prepare(`SELECT DISTINCT agent_id FROM memories WHERE id IN (${placeholders})`)
			.all(...candidates) as Array<{ readonly agent_id: string | null }>;
		for (const row of rows) if (row.agent_id) owners.add(row.agent_id);
	}
	if (kind === "artifact" && tableExists(db, "memory_artifacts")) {
		const rows = db
			.prepare(
				`SELECT DISTINCT agent_id FROM memory_artifacts
				 WHERE source_path = ? OR source_node_id IN (${placeholders}) OR session_id IN (${placeholders})
				    OR session_key IN (${placeholders}) OR session_token IN (${placeholders})`,
			)
			.all(path ?? id, ...candidates, ...candidates, ...candidates, ...candidates) as Array<{
			readonly agent_id: string | null;
		}>;
		for (const row of rows) if (row.agent_id) owners.add(row.agent_id);
	}
	if (
		(kind === "transcript" || kind === "summary") &&
		tableExists(db, kind === "transcript" ? "session_transcripts" : "session_summaries")
	) {
		const rows =
			kind === "transcript"
				? (db
						.prepare(`SELECT DISTINCT agent_id FROM session_transcripts WHERE session_key IN (${placeholders})`)
						.all(...candidates) as Array<{ readonly agent_id: string | null }>)
				: (db
						.prepare(
							`SELECT DISTINCT agent_id FROM session_summaries
							 WHERE id IN (${placeholders}) OR source_ref IN (${placeholders})`,
						)
						.all(...candidates, ...candidates) as Array<{ readonly agent_id: string | null }>);
		for (const row of rows) if (row.agent_id) owners.add(row.agent_id);
	}
	return [...owners];
}

function readDeletedArtifact(
	db: ReadDb,
	params: { readonly agentId: string; readonly id: string; readonly path: string | null },
): TraceSource | null {
	if (!tableExists(db, "memory_artifacts")) return null;
	const candidates = sourceIdCandidates(params.id);
	const placeholders = candidates.map(() => "?").join(", ");
	const row = db
		.prepare(
			`SELECT source_path, source_node_id, session_id, session_key, session_token, project, content
			 FROM memory_artifacts
			 WHERE agent_id = ? AND COALESCE(is_deleted, 0) != 0 AND (
			   source_path = ? OR source_node_id IN (${placeholders}) OR session_id IN (${placeholders})
			   OR session_key IN (${placeholders}) OR session_token IN (${placeholders})
			 )
			 ORDER BY captured_at DESC LIMIT 1`,
		)
		.get(params.agentId, params.path ?? params.id, ...candidates, ...candidates, ...candidates, ...candidates) as
		| {
				readonly source_path: string;
				readonly source_node_id: string | null;
				readonly session_id: string | null;
				readonly session_key: string | null;
				readonly session_token: string | null;
				readonly project: string | null;
				readonly content: string;
		  }
		| undefined;
	if (!row) return null;
	return {
		kind: "artifact",
		id: row.source_path,
		path: row.source_path,
		content: null,
		project: row.project,
		visibility: "scoped",
		scope: null,
		sessionKeys: [row.session_key, row.session_id, row.session_token].filter(
			(value): value is string => value !== null && value.length > 0,
		),
		state: "deleted",
	};
}

function readSource(
	db: ReadDb,
	params: {
		readonly agentId: string;
		readonly kind: TraceSourceKind;
		readonly id: string;
		readonly path: string | null;
		readonly project: string | null;
		readonly sessionKey: string | null;
	},
): TraceSource {
	const normalizedId = params.id.replace(new RegExp(`^${params.kind}:`), "");
	const sourceRef = `${params.kind}:${params.path ?? normalizedId}`;
	const source = readEpisodicSource(db, { agentId: params.agentId, from: sourceRef });
	if (!source) {
		const agents = sourceAgentIds(db, params.kind, normalizedId, params.path);
		if (agents.some((agentId) => agentId !== params.agentId)) {
			throw new OntologyClaimTraceError("Claim premise crosses the authorized agent scope", 403);
		}
		const deleted =
			params.kind === "artifact"
				? readDeletedArtifact(db, { agentId: params.agentId, id: normalizedId, path: params.path })
				: null;
		if (deleted) {
			if (params.project !== null && deleted.project !== params.project) {
				throw new OntologyClaimTraceError("Claim premise is outside the authorized project scope", 403);
			}
			if (params.sessionKey !== null && !deleted.sessionKeys.includes(params.sessionKey)) {
				throw new OntologyClaimTraceError("Claim trace premise crosses the authorized session boundary", 403);
			}
			return deleted;
		}
		throw new OntologyClaimTraceError(`Claim premise '${sourceRef}' was not found`, 409);
	}
	if (params.project !== null && source.project !== params.project) {
		throw new OntologyClaimTraceError("Claim premise is outside the authorized project scope", 403);
	}
	const sessionKeys = sourceSessionKeys(db, params.agentId, params.kind, normalizedId, params.path);
	if (params.sessionKey !== null && !sessionKeys.includes(params.sessionKey)) {
		throw new OntologyClaimTraceError("Claim trace premise crosses the authorized session boundary", 403);
	}
	const state: TraceSource["state"] = source.completed ? "available" : "incomplete";
	return {
		kind: params.kind,
		id: source.id,
		path: source.sourcePath,
		content: state === "available" ? source.content : null,
		project: source.project,
		visibility: "scoped",
		scope: null,
		sessionKeys,
		state,
	};
}

function readMemorySource(
	db: ReadDb,
	params: {
		readonly agentId: string;
		readonly id: string;
		readonly project: string | null;
		readonly sessionKey: string | null;
	},
): TraceSource {
	const row = db
		.prepare(
			`SELECT id, content, source_path, project, visibility, scope, memory_kind, COALESCE(is_deleted, 0) AS is_deleted,
			        stale_at, superseded_by, source_type, source_id
			 FROM memories WHERE id = ? AND agent_id = ? LIMIT 1`,
		)
		.get(params.id, params.agentId) as
		| {
				readonly id: string;
				readonly content: string;
				readonly source_path: string | null;
				readonly project: string | null;
				readonly visibility: string | null;
				readonly scope: string | null;
				readonly memory_kind: string | null;
				readonly is_deleted: number;
				readonly stale_at: string | null;
				readonly superseded_by: string | null;
				readonly source_type: string | null;
				readonly source_id: string | null;
		  }
		| undefined;
	if (!row) {
		// Return only existence, never cross-agent content, so fabricated and
		// cross-agent source IDs have distinct fail-closed outcomes.
		const crossAgent = db.prepare("SELECT 1 FROM memories WHERE id = ? LIMIT 1").get(params.id);
		if (crossAgent) throw new OntologyClaimTraceError("Claim premise crosses the authorized agent scope", 403);
		throw new OntologyClaimTraceError(`Claim premise 'memory:${params.id}' was not found`, 409);
	}
	if (params.project !== null && row.project !== params.project) {
		throw new OntologyClaimTraceError("Claim premise is outside the authorized project scope", 403);
	}
	const sessionKeys = sourceSessionKeys(db, params.agentId, "memory", row.id, null);
	if (params.sessionKey !== null && !sessionKeys.includes(params.sessionKey)) {
		throw new OntologyClaimTraceError("Claim trace premise crosses the authorized session boundary", 403);
	}
	const state: TraceSource["state"] =
		row.is_deleted !== 0
			? "deleted"
			: row.stale_at !== null || row.superseded_by !== null
				? "stale"
				: row.memory_kind !== "episodic" || row.visibility === "archived" || row.scope !== null
					? "incomplete"
					: "available";
	return {
		kind: "memory",
		id: row.id,
		path: row.source_path,
		content: state === "available" ? row.content : null,
		project: row.project,
		visibility: row.visibility,
		scope: row.scope,
		sessionKeys,
		state,
	};
}

function sourceFromReference(
	db: ReadDb,
	params: {
		readonly agentId: string;
		readonly reference: TraceReference;
		readonly project: string | null;
		readonly sessionKey: string | null;
	},
): TraceEvidence {
	const kind = canonicalSourceKind(params.reference.sourceKind);
	const id = params.reference.sourceId?.trim() ?? "";
	if (!kind || !id) {
		throw new OntologyClaimTraceError("Claim premise must include a canonical source_ref", 409);
	}
	const source =
		kind === "memory"
			? readMemorySource(db, {
					agentId: params.agentId,
					id: id.replace(/^memory:/, ""),
					project: params.project,
					sessionKey: params.sessionKey,
				})
			: readSource(db, {
					agentId: params.agentId,
					kind,
					id,
					path: params.reference.sourcePath,
					project: params.project,
					sessionKey: params.sessionKey,
				});
	const quote = params.reference.quote;
	const exact = source.content !== null && quote !== null && source.content.includes(quote);
	if (source.state === "available" && quote === null) {
		return {
			sourceKind: kind,
			sourceId: source.id,
			sourcePath: source.path,
			exactQuote: null,
			excerpt: null,
			found: true,
			state: "quote_unverified",
			scope: {
				agentId: params.agentId,
				project: source.project,
				visibility: source.visibility,
				sessionKeys: visibleSessionKeys(params.sessionKey),
			},
			reference: publicReference(params.reference.reference),
		};
	}
	if (source.state === "available" && quote !== null && !exact) {
		throw new OntologyClaimTraceError("Claim premise quote does not match the immutable source", 409);
	}
	return {
		sourceKind: kind,
		sourceId: source.id,
		sourcePath: source.path,
		exactQuote: exact ? quote : null,
		excerpt: exact && source.content !== null && quote !== null ? compactExcerpt(source.content, quote) : null,
		found: source.state !== "deleted",
		state: source.state,
		scope: {
			agentId: params.agentId,
			project: source.project,
			visibility: source.visibility,
			sessionKeys: visibleSessionKeys(params.sessionKey),
		},
		reference: publicReference(params.reference.reference),
	};
}

function attributeReferences(
	db: ReadDb,
	attribute: EntityAttribute,
	proposalEvidence: readonly unknown[],
): TraceReference[] {
	const references: TraceReference[] = [];
	if (tableExists(db, "derived_memory_sources") && attribute.memoryId) {
		const rows = db
			.prepare(
				`SELECT source_kind, source_id, source_path FROM derived_memory_sources
				 WHERE derived_memory_id = ? AND agent_id = ? ORDER BY created_at ASC LIMIT ?`,
			)
			.all(attribute.memoryId, attribute.agentId, MAX_PREMISE_LIMIT + 1) as Array<{
			readonly source_kind: string;
			readonly source_id: string;
			readonly source_path: string | null;
		}>;
		references.push(
			...rows.map((row) => ({
				sourceKind: row.source_kind,
				sourceId: row.source_id,
				sourcePath: row.source_path,
				quote: null,
				strict: true,
				derivedMemoryId: attribute.memoryId,
				reference: {
					source_ref: `${row.source_kind}:${row.source_id}`,
					source_path: row.source_path,
				},
			})),
		);
	}
	for (const raw of [...attribute.proposalEvidence, ...proposalEvidence]) {
		const parsed = parseReference(raw);
		if (parsed) references.push({ ...parsed, derivedMemoryId: attribute.memoryId });
	}
	if (attribute.sourceKind || attribute.sourceId || attribute.sourcePath) {
		const kind = sourceRefParts({
			sourceKind: attribute.sourceKind,
			sourceId: attribute.sourceId,
			sourcePath: attribute.sourcePath,
			quote: null,
			reference: attribute,
		}).kind;
		if (canonicalSourceKind(kind) !== null) {
			references.push({
				sourceKind: attribute.sourceKind,
				sourceId: attribute.sourceId,
				sourcePath: attribute.sourcePath,
				quote: null,
				strict: true,
				derivedMemoryId: attribute.memoryId,
				reference: {
					source_kind: attribute.sourceKind,
					source_id: attribute.sourceId,
					source_path: attribute.sourcePath,
				},
			});
		}
	}
	return mergeReferences(references).filter(
		(reference) =>
			reference.sourceKind !== "ontology_proposal" &&
			reference.strict === true &&
			canonicalSourceKind(reference.sourceKind) !== null &&
			(reference.sourceId?.trim().length ?? 0) > 0,
	);
}

function traceVersion(db: ReadDb, attribute: EntityAttribute): TraceVersion {
	const memory = memoryState(db, attribute.agentId, attribute.memoryId);
	return {
		attribute: {
			...attribute,
			proposalEvidence: publicEvidence(attribute.proposalEvidence),
		},
		lifecycle: {
			status: attribute.status,
			memoryId: attribute.memoryId,
			memoryPresent: memory !== null,
			staleAt: memory?.stale_at ?? null,
			supersededBy: memory?.superseded_by ?? attribute.supersededBy ?? null,
		},
		history: {
			version: attribute.version ?? null,
			versionRootId: attribute.versionRootId ?? null,
			previousAttributeId: attribute.previousAttributeId ?? null,
			supersededBy: attribute.supersededBy,
		},
	};
}

function readProposalEvidence(db: ReadDb, agentId: string, proposalId: string | null): readonly unknown[] {
	if (!proposalId || !tableExists(db, "ontology_proposals")) return [];
	const row = db
		.prepare("SELECT evidence FROM ontology_proposals WHERE id = ? AND agent_id = ? LIMIT 1")
		.get(proposalId, agentId) as { readonly evidence: string | null } | undefined;
	return parseJsonArray(row?.evidence);
}

function readAssertions(db: ReadDb, agentId: string, attributeIds: readonly string[]): TraceAssertion[] {
	if (!tableExists(db, "epistemic_assertions") || attributeIds.length === 0) return [];
	const placeholders = attributeIds.map(() => "?").join(", ");
	const rows = db
		.prepare(
			`SELECT a.*, e.name AS subject_entity_name
			 FROM epistemic_assertions a
			 JOIN entities e ON e.id = a.subject_entity_id AND e.agent_id = a.agent_id
			 WHERE a.agent_id = ? AND a.claim_attribute_id IN (${placeholders})
			 ORDER BY a.asserted_at DESC, a.created_at DESC
			 LIMIT ?`,
		)
		.all(agentId, ...attributeIds, MAX_PREMISE_LIMIT) as RawAssertionRow[];
	return rows.map((row) => {
		const evidenceRefs = [
			...parseJsonArray(row.evidence),
			...(row.source_kind || row.source_id || row.source_path
				? [
						{
							source_kind: row.source_kind,
							source_id: row.source_id,
							source_path: row.source_path,
						},
					]
				: []),
		]
			.map(parseReference)
			.filter((ref): ref is TraceReference => ref !== null);
		return {
			id: row.id,
			agentId: row.agent_id,
			subjectEntityId: row.subject_entity_id,
			subjectEntityName: row.subject_entity_name,
			claimAttributeId: row.claim_attribute_id,
			predicate: row.predicate,
			content: row.content,
			normalizedContent: row.normalized_content,
			speaker: row.speaker,
			assertedAt: row.asserted_at,
			confidence: row.confidence,
			evidence: publicEvidence(parseJsonArray(row.evidence)),
			sourceKind: row.source_kind,
			sourceId: row.source_id,
			sourcePath: row.source_path,
			sourceRoot: row.source_root,
			status: row.status,
			supersedesAssertionId: row.supersedes_assertion_id,
			archivedAt: row.archived_at,
			archivedBy: row.archived_by,
			archiveReason: row.archive_reason,
			createdBy: row.created_by,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
			evidenceRefs: mergeReferences(evidenceRefs).map((reference) => ({
				...reference,
				reference: publicReference(reference.reference),
			})),
		};
	});
}

function readReverse(
	db: ReadDb,
	params: {
		readonly agentId: string;
		readonly project: string | null;
		readonly memoryIds: readonly string[];
		readonly limit: number;
		readonly maxDepth: number;
	},
): { readonly items: ReverseTraceItem[]; readonly truncated: boolean; readonly maxDepthReached: number } {
	if (!tableExists(db, "derived_memory_sources") || params.memoryIds.length === 0 || params.maxDepth === 0) {
		return { items: [], truncated: false, maxDepthReached: 0 };
	}
	const visited = new Set(params.memoryIds);
	let frontier = [...visited];
	const items: ReverseTraceItem[] = [];
	let truncated = false;
	let maxDepthReached = 0;
	for (let depth = 1; depth <= params.maxDepth && frontier.length > 0 && items.length < params.limit; depth += 1) {
		const placeholders = frontier.map(() => "?").join(", ");
		const rows = db
			.prepare(
				`SELECT DISTINCT dms.derived_memory_id AS memory_id, ea.id AS attribute_id,
				        e.name AS entity_name, eas.name AS aspect_name, ea.group_key, ea.claim_key,
				        COALESCE(ea.content, m.content) AS content, COALESCE(ea.status, 'derived') AS status
				 FROM derived_memory_sources dms
				 JOIN memories m ON m.id = dms.derived_memory_id AND m.agent_id = dms.agent_id
				 LEFT JOIN entity_attributes ea ON ea.memory_id = m.id AND ea.agent_id = m.agent_id
				 LEFT JOIN entity_aspects eas ON eas.id = ea.aspect_id AND eas.agent_id = ea.agent_id
				 LEFT JOIN entities e ON e.id = eas.entity_id AND e.agent_id = eas.agent_id
				 WHERE dms.agent_id = ? AND dms.source_kind = 'memory' AND dms.source_id IN (${placeholders})
				   AND COALESCE(m.is_deleted, 0) = 0 AND m.visibility != 'archived' AND m.scope IS NULL
				   AND (? IS NULL OR m.project = ?)
				 ORDER BY m.updated_at DESC, m.id ASC
				 LIMIT ?`,
			)
			.all(
				params.agentId,
				...frontier,
				params.project,
				params.project,
				params.limit - items.length + 1,
			) as RawReverseRow[];
		if (rows.length > params.limit - items.length) truncated = true;
		const nextFrontier: string[] = [];
		for (const row of rows) {
			if (visited.has(row.memory_id)) continue;
			visited.add(row.memory_id);
			if (items.length < params.limit) {
				items.push({
					attributeId: row.attribute_id,
					memoryId: row.memory_id,
					entity: row.entity_name,
					aspect: row.aspect_name,
					groupKey: row.group_key,
					claimKey: row.claim_key,
					content: row.content,
					status: row.status,
					depth,
				});
				maxDepthReached = depth;
				nextFrontier.push(row.memory_id);
			}
		}
		if (depth === params.maxDepth && nextFrontier.length > 0) truncated = true;
		frontier = nextFrontier;
	}
	return { items, truncated, maxDepthReached };
}

export function explainOntologyClaim(accessor: DbAccessor, params: ExplainClaimParams): ClaimTraceResult {
	const started = performance.now();
	const versionLimit = boundedInteger(params.versionLimit, 20, MAX_VERSION_LIMIT, "versionLimit");
	const premiseLimit = boundedInteger(params.premiseLimit, 50, MAX_PREMISE_LIMIT, "premiseLimit");
	const reverseLimit = boundedInteger(params.reverseLimit, 50, MAX_REVERSE_LIMIT, "reverseLimit");
	const maxDepth = boundedDepth(params.maxDepth);
	const sessionKey = params.sessionKey?.trim() || null;
	const project = params.project?.trim() || null;
	const result = listEntityAttributesByPath(accessor, {
		agentId: params.agentId,
		entity: params.entity,
		aspect: params.aspect,
		group: params.group,
		claim: params.claim,
		kind: params.kind,
		status: "all",
		limit: versionLimit + 1,
		offset: 0,
	});
	if (result === null) throw new OntologyClaimTraceError("Claim path not found", 404);
	if (result.items.length === 0) throw new OntologyClaimTraceError("Claim path has no versions", 404);

	return accessor.withReadDb((db) => {
		if (project !== null) {
			// Graph rows are agent-scoped but do not carry a project column. A
			// project-scoped caller may only receive a claim whose linked semantic
			// memory proves the same project; otherwise fail closed before any
			// claim content, history, or assertion is returned.
			for (const attribute of result.items) requireProjectScopedAttribute(db, attribute, project);
		}
		const versions = result.items.slice(0, versionLimit).map((attribute) => traceVersion(db, attribute));
		const current = versions.filter((version) => version.attribute.status === "active");
		const currentContent = new Set(current.map((version) => version.attribute.normalizedContent));
		const assertions = readAssertions(
			db,
			params.agentId,
			versions.map((version) => version.attribute.id),
		);
		const contradictoryAssertions = assertions.filter(
			(assertion) => assertion.predicate === "denies" && assertion.status === "active",
		);
		const references = versions.flatMap((version) =>
			attributeReferences(
				db,
				version.attribute,
				readProposalEvidence(db, params.agentId, version.attribute.proposalId),
			),
		);
		references.push(...assertions.flatMap((assertion) => assertion.evidenceRefs));
		const uniqueReferences = mergeReferences(references);
		const premiseItems: TracePremise[] = [];
		let verifiedPremises = 0;
		let invalidatedPremises = 0;
		let unverifiedPremises = 0;
		for (const reference of uniqueReferences.slice(0, premiseLimit + 1)) {
			if (premiseItems.length >= premiseLimit) break;
			const evidence = sourceFromReference(db, {
				agentId: params.agentId,
				reference,
				project,
				sessionKey,
			});
			const derivedMemoryId = reference.derivedMemoryId ?? null;
			const depth = 0;
			premiseItems.push({ depth, derivedMemoryId, evidence });
			if (evidence.state === "available") {
				if (evidence.exactQuote !== null) verifiedPremises += 1;
				else unverifiedPremises += 1;
			} else if (evidence.state === "deleted" || evidence.state === "stale" || evidence.state === "incomplete") {
				invalidatedPremises += 1;
			}
		}
		const reverseTrace = readReverse(db, {
			agentId: params.agentId,
			project,
			memoryIds: versions
				.map((version) => version.attribute.memoryId)
				.filter((memoryId): memoryId is string => memoryId !== null),
			limit: reverseLimit,
			maxDepth,
		});
		const integrity: TraceIntegrity =
			invalidatedPremises > 0
				? "invalidated"
				: verifiedPremises === 0
					? "unverified"
					: unverifiedPremises > 0
						? "unverified"
						: "verified";
		const hasCompeting = currentContent.size > 1;
		return {
			entity: {
				...result.entity,
				proposalEvidence: publicEvidence(result.entity.proposalEvidence ?? []),
			},
			aspect: {
				...result.aspect,
				proposalEvidence: publicEvidence(result.aspect.proposalEvidence ?? []),
			},
			path: {
				groupKey: params.group,
				claimKey: params.claim,
				kind: params.kind ?? null,
			},
			current: {
				items: current,
				status: current.length === 0 ? "historical" : hasCompeting ? "competing" : "active",
			},
			versions: { items: versions, truncated: result.items.length > versionLimit },
			competing: { items: hasCompeting ? current : [], contradictoryAssertions },
			assertions,
			premises: {
				items: premiseItems,
				truncated: uniqueReferences.length > premiseLimit,
			},
			reverse: { items: reverseTrace.items, truncated: reverseTrace.truncated },
			authorization: {
				agentId: params.agentId,
				project,
				sessionKey,
				decisions: {
					agent: "allowed",
					project: project === null ? "unrestricted" : "allowed",
					session: sessionKey === null ? "unrestricted" : "allowed",
				},
				readPath: "recall",
			},
			integrity: {
				status: integrity,
				verifiedPremises,
				invalidatedPremises,
				unverifiedPremises,
				reason:
					integrity === "verified"
						? null
						: invalidatedPremises > 0
							? "one or more premise records were deleted, superseded, stale, or incomplete"
							: "the claim has no verified exact-quote premise",
			},
			traversal: {
				limits: { versionLimit, premiseLimit, reverseLimit, maxDepth },
				versionsVisited: versions.length,
				premisesVisited: premiseItems.length,
				reverseVisited: reverseTrace.items.length,
				maxDepthReached: reverseTrace.maxDepthReached,
				bounded: true,
			},
			latencyMs: Math.round((performance.now() - started) * 100) / 100,
		};
	});
}

export type { TraceAssertion, TraceEvidence, TracePremise, TraceVersion, ReverseTraceItem };
