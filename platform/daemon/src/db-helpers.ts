import { createRequire } from "node:module";
import {
	attempt,
	compartmentFor,
	compartmentForWrite,
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
			.all(sourceType, sourceId) as Array<{ id: string }>;
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
	| "telemetry";
const EVIDENCE_ROWS = {
	memory: { table: "memories", key: "id", session: "NULL", source: "source_id" },
	transcript: { table: "session_transcripts", key: "session_key", session: "session_key", source: "source_id" },
	artifact: { table: "memory_artifacts", key: "source_path", session: "session_key", source: "source_id" },
	summary: { table: "session_summaries", key: "id", session: "session_key", source: "source_ref" },
	attribute: { table: "entity_attributes", key: "id", session: "NULL", source: "source_id" },
} as const;
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
		if (!row) throw new Error("evidence_not_in_agent");
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
