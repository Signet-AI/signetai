import { createRequire } from "node:module";
import type { WriteAuthor } from "./auth/audit-owner";
import { readScopeSql } from "./read-scope";
import {
	attempt,
	compartmentFor,
	compartmentForWrite,
	classificationsForWrite,
	type CompartmentWriteScope,
	deleteCompartmentVectors,
	syncEmbeddingCompartment,
	activeVectorProjectionTable,
} from "@signet/core";
import { type ReadDb, type WriteDb, readVecEmbeddingDimensions, prepareTypedStatement } from "./db-accessor";
let native: typeof import("@signet/native") | null = null;
try {
	const esmRequire = createRequire(import.meta.url);
	native = esmRequire("@signet/native");
} catch {}
export function vectorToBlob(vec: readonly number[]): Buffer {
	if (native !== null) {
		return native.vectorToBlob(vec as number[]);
	}
	const f32 = new Float32Array(vec);
	return Buffer.from(f32.buffer.slice(0));
}
export function countChanges(result: unknown): number {
	if (typeof result !== "object" || result === null) return 0;
	const row = result as { changes?: number };
	return typeof row.changes === "number" ? row.changes : 0;
}

function invalidateUmapCache(db: WriteDb): void {
	try {
		db.prepare("DELETE FROM umap_cache").run();
	} catch {}
}

function activeVecTable(db: ReadDb): "vec_embeddings" | "vec_embeddings_staging" | null {
	const table = activeVectorProjectionTable(db);
	try {
		const row = db.prepare("SELECT name FROM sqlite_master WHERE name = ? AND type = 'table'").get(table);
		return row != null ? table : null;
	} catch {
		return null;
	}
}
export function readLiveVecDimensions(db: ReadDb): number | null {
	let row: { sql: string } | undefined;
	try {
		row = db
			.prepare("SELECT sql FROM sqlite_master WHERE name = ? AND type = 'table'")
			.get(activeVectorProjectionTable(db)) as { sql: string } | undefined;
	} catch {
		return null;
	}
	return readVecEmbeddingDimensions(row?.sql);
}
export function syncVecInsert(db: WriteDb, embeddingId: string, vector: readonly number[]): void {
	invalidateUmapCache(db);
	const table = activeVecTable(db);
	if (table === null) return;
	attempt(() => syncEmbeddingCompartment(db, "embeddings", embeddingId, table, new Float32Array(vector)));
}
export function syncVecDeleteByEmbeddingIds(db: WriteDb, embeddingIds: readonly string[]): boolean {
	if (embeddingIds.length === 0) return true;
	invalidateUmapCache(db);
	const table = activeVecTable(db);
	if (table === null) return true;
	try {
		deleteCompartmentVectors(db, embeddingIds);
		return true;
	} catch {
		return false;
	}
}
export function syncVecDeleteBySourceId(db: WriteDb, sourceType: string, sourceId: string): void {
	invalidateUmapCache(db);
	const table = activeVecTable(db);
	if (table === null) return;
	try {
		const rows = db
			.prepare("SELECT id FROM embeddings WHERE source_type = ? AND source_id = ?")
			.all<{ id: string }>(sourceType, sourceId);
		if (rows.length === 0) return;
		deleteCompartmentVectors(
			db,
			rows.map((row) => row.id),
		);
	} catch {}
}
export function syncVecDeleteBySourceExceptHash(
	db: WriteDb,
	sourceType: string,
	sourceId: string,
	keepContentHash: string,
): void {
	invalidateUmapCache(db);
	const table = activeVecTable(db);
	if (table === null) return;
	try {
		const rows = db
			.prepare("SELECT id FROM embeddings WHERE source_type = ? AND source_id = ? AND content_hash <> ?")
			.all(sourceType, sourceId, keepContentHash) as Array<{ id: string }>;
		if (rows.length === 0) return;
		deleteCompartmentVectors(
			db,
			rows.map((row) => row.id),
		);
	} catch {}
}
export function resolveWriteCompartmentParameterInTx(
	db: WriteDb,
	value: Extract<import("./db-owner-protocol").DbOwnerParameter, { readonly type: "compartment" }>,
): number | null {
	const parent =
		value.parentMemoryId === undefined
			? value.scope.parentCompartment
			: evidenceCompartmentInTx(
					db,
					value.scope.agentId,
					[{ kind: "memory", id: value.parentMemoryId }],
					value.scope.parentCompartment,
				);
	return compartmentForWrite(db, { ...value.scope, parentCompartment: parent });
}
export interface CitationEvidence {
	readonly kind: "memory" | "transcript" | "artifact" | "summary" | "attribute";
	readonly id: string;
}
export type CitationDerivedKind =
	| "memory"
	| "reflection"
	| "contradiction"
	| "head_entry"
	| "head_revision"
	| "entity"
	| "dependency"
	| "aspect"
	| "telemetry"
	| "community";
const EVIDENCE_ROWS = {
	memory: { table: "memories", key: "id", session: "NULL", source: "source_id" },
	transcript: { table: "session_transcripts", key: "session_key", session: "session_key", source: "source_id" },
	artifact: { table: "memory_artifacts", key: "source_path", session: "session_key", source: "source_id" },
	summary: { table: "session_summaries", key: "id", session: "session_key", source: "source_ref" },
	attribute: { table: "entity_attributes", key: "id", session: "NULL", source: "source_id" },
} as const;
export class MissingEvidenceError extends Error {
	constructor(
		readonly evidence: CitationEvidence,
		readonly agentId: string,
	) {
		super("evidence_missing");
	}
}
export function evidenceCompartmentInTx(
	db: WriteDb,
	agentId: string,
	evidence: readonly CitationEvidence[],
	parentCompartment?: number | null,
): number | null {
	let compartment = compartmentForWrite(db, { agentId, parentCompartment });
	for (const ref of evidence) {
		const source = EVIDENCE_ROWS[ref.kind];
		const row = prepareTypedStatement<{
			compartment_id: number | null;
			session_key: string | null;
			source_id: string | null;
		}>(
			db,
			`SELECT compartment_id,${source.session} AS session_key,${source.source} AS source_id FROM ${source.table} WHERE ${source.key}=? AND agent_id=?`,
		).get(ref.id, agentId);
		if (!row) throw new MissingEvidenceError(ref, agentId);
		const inherited = compartmentForWrite(db, {
			agentId,
			sessionKey: typeof row.session_key === "string" ? row.session_key : null,
			sourceId: typeof row.source_id === "string" ? row.source_id : null,
			memoryId: ref.kind === "memory" ? ref.id : null,
			parentCompartment: typeof row.compartment_id === "number" ? row.compartment_id : null,
		});
		if (inherited !== null) {
			const labels = prepareTypedStatement<{ classification_id: string }>(
				db,
				"SELECT classification_id FROM compartment_members WHERE compartment_id IN (?,?)",
			).all(compartment, inherited);
			const ids = labels.flatMap((row) => (typeof row.classification_id === "string" ? [row.classification_id] : []));
			compartment = compartmentFor(db, ids);
		}
	}
	return compartment;
}
export function recordEvidenceCitationsInTx(
	db: WriteDb,
	input: {
		readonly agentId: string;
		readonly derivedKind: CitationDerivedKind;
		readonly derivedId: string;
		readonly evidence: readonly CitationEvidence[];
	},
): number | null {
	const compartment = evidenceCompartmentInTx(db, input.agentId, input.evidence);
	const insert = db.prepare(
		"INSERT OR IGNORE INTO evidence_citations(derived_kind,derived_id,agent_id,evidence_kind,evidence_id) VALUES(?,?,?,?,?)",
	);
	for (const ref of input.evidence) insert.run(input.derivedKind, input.derivedId, input.agentId, ref.kind, ref.id);
	return compartment;
}
export function tableExists(db: { prepare(sql: string): { get(...args: unknown[]): unknown } }, name: string): boolean {
	return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) != null;
}

export function memoryWriteDedupeSql(
	db: ReadDb,
	input: { readonly writeScope: CompartmentWriteScope; readonly author: WriteAuthor },
	alias = "memories",
): { readonly sql: string; readonly params: readonly unknown[] } {
	const scope = readScopeSql(alias, {
		reach: { kind: "own", agentId: input.writeScope.agentId },
		compartments: "all",
		projects: null,
		...(input.author.userId ? { inFlightUserId: input.author.userId } : {}),
	});
	const key = classificationsForWrite(db, input.writeScope).join(",");
	return {
		sql: `${scope.sql} AND COALESCE((SELECT key FROM compartments WHERE id=${alias}.compartment_id),'')=? AND (? IS NULL OR NOT EXISTS(SELECT 1 FROM compartment_members cm WHERE cm.compartment_id=${alias}.compartment_id AND NOT EXISTS(SELECT 1 FROM classification_audience ca WHERE ca.classification_id=cm.classification_id AND ((ca.principal_kind='user' AND ca.principal_id=?) OR (ca.principal_kind='group' AND ca.principal_id IN (SELECT group_id FROM group_members WHERE user_id=?))))))`,
		params: [...scope.args, key, input.author.userId, input.author.userId, input.author.userId],
	};
}

export function completeDerivedMemoryCitationsInTx(db: WriteDb, derivedMemoryId: string, agentId: string): void {
	const parent = prepareTypedStatement<{ compartment_id: number | null }>(
		db,
		"SELECT compartment_id FROM memories WHERE id=? AND agent_id=?",
	).get(derivedMemoryId, agentId);
	if (!parent) throw new Error("derived_memory_not_in_agent");
	const sources = prepareTypedStatement<{ source_kind: string; source_id: string }>(
		db,
		"SELECT source_kind,source_id FROM derived_memory_sources WHERE derived_memory_id=? AND agent_id=?",
	).all(derivedMemoryId, agentId);
	const evidence = sources.map(
		(source): CitationEvidence => ({
			kind: citationKind(source.source_kind),
			id: source.source_id,
		}),
	);
	const compartment = evidenceCompartmentInTx(db, agentId, evidence, parent.compartment_id);
	recordEvidenceCitationsInTx(db, { agentId, derivedKind: "memory", derivedId: derivedMemoryId, evidence });
	db.prepare("UPDATE memories SET compartment_id=? WHERE id=? AND agent_id=?").run(
		compartment,
		derivedMemoryId,
		agentId,
	);
	for (const [table, parentKey] of [
		["memory_hints", "memory_id"],
		["derived_memory_sources", "derived_memory_id"],
	] as const)
		db.prepare(`UPDATE ${table} SET compartment_id=? WHERE ${parentKey}=? AND agent_id=?`).run(
			compartment,
			derivedMemoryId,
			agentId,
		);
	for (const store of ["embeddings", "embeddings_staging"] as const) {
		const embeddings = prepareTypedStatement<{ id: string }>(
			db,
			`SELECT id FROM ${store} WHERE source_type='memory' AND source_id=?`,
		).all(derivedMemoryId);
		for (const embedding of embeddings) syncEmbeddingCompartment(db, store, embedding.id);
	}
}
export function citationKind(kind: string): CitationEvidence["kind"] {
	if (kind === "ontology_claim") return "attribute";
	if (kind === "memory" || kind === "artifact" || kind === "transcript" || kind === "summary") return kind;
	throw new Error(`Unsupported evidence kind: ${kind}`);
}

export function recallResultEvidenceInTx(
	db: WriteDb,
	agentId: string,
	item: { readonly id: string; readonly source?: string; readonly source_path?: string; readonly session_id?: string },
): readonly CitationEvidence[] {
	if (item.id.startsWith("ontology-claim:"))
		return [{ kind: "attribute", id: item.id.slice("ontology-claim:".length) }];
	if (item.id.startsWith("transcript:")) {
		const id = item.session_id ?? item.id.slice("transcript:".length);
		const rows = prepareTypedStatement<{ session_key: string }>(
			db,
			"SELECT session_key FROM session_transcripts WHERE agent_id=? AND (session_key=? OR session_id=? OR source_path=?)",
		).all(agentId, id, id, item.source_path ?? id);
		if (!rows.length) throw new Error("recall_evidence_not_in_agent");
		return rows.map((row) => ({ kind: "transcript", id: row.session_key }));
	}
	if (item.id.startsWith("source-chunk:") || item.id.startsWith("native-artifact:")) {
		const embeddingId = item.id.slice("source-chunk:".length);
		const rowid = item.id.slice("native-artifact:".length);
		const rows = prepareTypedStatement<{ source_path: string }>(
			db,
			"SELECT source_path FROM memory_artifacts WHERE agent_id=? AND (source_path=? OR rowid=? OR source_path IN (SELECT source_id FROM embeddings WHERE id=? AND agent_id=?))",
		).all(
			agentId,
			item.source_path ?? null,
			item.id.startsWith("native-artifact:") ? rowid : null,
			embeddingId,
			agentId,
		);
		const transcripts = item.id.startsWith("source-chunk:")
			? prepareTypedStatement<{ session_key: string }>(
					db,
					"SELECT session_key FROM session_transcripts WHERE agent_id=? AND source_path IN (SELECT source_id FROM embeddings WHERE id=? AND agent_id=?)",
				).all(agentId, embeddingId, agentId)
			: [];
		if (!rows.length && !transcripts.length) throw new Error("recall_evidence_not_in_agent");
		return [
			...rows.map((row): CitationEvidence => ({ kind: "artifact", id: row.source_path })),
			...transcripts.map((row): CitationEvidence => ({ kind: "transcript", id: row.session_key })),
		];
	}
	if (item.id.startsWith("constructed:") || item.source === "llm_summary" || item.id.startsWith("summary:"))
		throw new Error("recall_result_evidence_required");
	return [{ kind: "memory", id: item.id }];
}

export function readSessionFinalizerAuthorInTx(
	db: Pick<WriteDb, "prepare">,
	agentId: string,
	sessionKey: string,
): WriteAuthor {
	const row = prepareTypedStatement<{ speaker_user_id: string | null }>(
		db,
		"SELECT speaker_user_id FROM session_transcripts WHERE session_key=? AND agent_id=?",
	).get(sessionKey, agentId);
	return { userId: row?.speaker_user_id ?? null, credential: "system" };
}
export function pruneSessionRecallEventsInTx(db: WriteDb, cutoff: string, limit: number): number {
	return db
		.prepare(
			"DELETE FROM session_recall_events WHERE rowid IN (SELECT rowid FROM session_recall_events WHERE created_at < ? ORDER BY rowid LIMIT ?) RETURNING rowid",
		)
		.all(cutoff, limit).length;
}

export function resetCommunityProjectionInTx(db: WriteDb, agentId: string): void {
	db.prepare("DELETE FROM evidence_citations WHERE derived_kind='community' AND agent_id=?").run(agentId);
	db.prepare("DELETE FROM entity_communities WHERE agent_id=?").run(agentId);
	db.prepare("UPDATE entities SET community_id=NULL WHERE agent_id=?").run(agentId);
}
export function writeCommunityProjectionInTx(
	db: WriteDb,
	input: {
		readonly id: string;
		readonly agentId: string;
		readonly name: string | null;
		readonly cohesion: number;
		readonly memberIds: readonly string[];
	},
): boolean {
	const labels = new Set<string>();
	const evidence: CitationEvidence[] = [];
	for (const id of input.memberIds) {
		const entity = prepareTypedStatement<{ compartment_id: number | null; source_id: string | null }>(
			db,
			"SELECT compartment_id,source_id FROM entities WHERE id=? AND agent_id=?",
		).get(id, input.agentId);
		if (!entity) throw new Error("community_entity_not_in_agent");
		for (const label of classificationsForWrite(db, {
			agentId: input.agentId,
			sourceId: entity.source_id,
			parentCompartment: entity.compartment_id,
		}))
			labels.add(label);
		evidence.push(
			...prepareTypedStatement<{ evidence_kind: CitationEvidence["kind"]; evidence_id: string }>(
				db,
				"SELECT evidence_kind,evidence_id FROM evidence_citations WHERE agent_id=? AND derived_kind='entity' AND derived_id=?",
			)
				.all(input.agentId, id)
				.map((row) => ({ kind: row.evidence_kind, id: row.evidence_id })),
		);
	}
	let compartment: number | null;
	try {
		compartment = evidenceCompartmentInTx(db, input.agentId, evidence, compartmentFor(db, [...labels]));
	} catch (error) {
		if (!(error instanceof MissingEvidenceError)) throw error;
		db.prepare("DELETE FROM evidence_citations WHERE agent_id=? AND evidence_kind=? AND evidence_id=?").run(
			error.agentId,
			error.evidence.kind,
			error.evidence.id,
		);
		return false;
	}
	db.prepare(
		"INSERT INTO entity_communities(id,agent_id,name,cohesion,member_count,created_at,updated_at,compartment_id) VALUES(?,?,?,?,?,datetime('now'),datetime('now'),?)",
	).run(input.id, input.agentId, input.name, input.cohesion, input.memberIds.length, compartment);
	recordEvidenceCitationsInTx(db, { agentId: input.agentId, derivedKind: "community", derivedId: input.id, evidence });
	return true;
}
