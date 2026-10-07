import { type WriteDb, getDbAccessor } from "./db-accessor";

export interface ImportExtractionOutcome {
	readonly documentEntityId: string | null;
}

export function persistImportedSourceOutcome(input: {
	readonly agentId: string;
	readonly sourceId: string;
	readonly sourcePath: string;
	readonly outcome: ImportExtractionOutcome;
}): void {
	// @ts-expect-error LEGACY_SYNC_DB_ACCESS: withWriteTx migration site
	getDbAccessor().withWriteTx(
		(db: import("./db-accessor").WriteDb) => persistImportedSourceOutcomeInTx(db, input),
		"db:sources.import-outcome.write",
	);
}

export function persistImportedSourceOutcomeInTx(
	db: WriteDb,
	input: {
		readonly agentId: string;
		readonly sourceId: string;
		readonly sourcePath: string;
		readonly outcome: ImportExtractionOutcome;
	},
): void {
	const row = db
		.prepare(
			`SELECT source_meta_json
			   FROM memory_artifacts
			  WHERE agent_id = ?
			    AND source_id = ?
			    AND source_path = ?
			    AND COALESCE(is_deleted, 0) = 0
			  LIMIT 1`,
		)
		.get(input.agentId, input.sourceId, input.sourcePath) as { source_meta_json: string | null } | null | undefined;
	if (row == null) throw new Error("Imported source artifact is unavailable for extraction outcome persistence");
	const sourceMeta = parseJsonObject(row.source_meta_json) ?? {};
	db.prepare(
		`UPDATE memory_artifacts
		    SET source_meta_json = ?, updated_at = ?
		  WHERE agent_id = ?
		    AND source_id = ?
		    AND source_path = ?
		    AND COALESCE(is_deleted, 0) = 0`,
	).run(
		JSON.stringify({ ...sourceMeta, importExtraction: input.outcome }),
		new Date().toISOString(),
		input.agentId,
		input.sourceId,
		input.sourcePath,
	);
}

export function readImportedSourceOutcome(sourceId: string, agentId: string): ImportExtractionOutcome | undefined {
	// @ts-expect-error LEGACY_SYNC_DB_ACCESS: withReadDb migration site
	return getDbAccessor().withReadDb((db: import("./db-accessor").ReadDb) => {
		const row = db
			.prepare(
				`SELECT source_meta_json
				   FROM memory_artifacts
				  WHERE agent_id = ?
				    AND source_id = ?
				    AND source_kind LIKE 'source_import_%'
				    AND source_kind NOT IN ('source_import_json_canonical', 'source_import_csv_chunk')
				    AND COALESCE(is_deleted, 0) = 0
				  ORDER BY updated_at DESC, source_path ASC
				  LIMIT 1`,
			)
			.get(agentId, sourceId) as { source_meta_json: string | null } | null | undefined;
		return parseImportExtractionOutcome(parseJsonObject(row?.source_meta_json ?? null)?.importExtraction);
	}, "db:sources.import-outcome.read");
}

function parseImportExtractionOutcome(value: unknown): ImportExtractionOutcome | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const candidate = value as Record<string, unknown>;
	const documentEntityId = candidate.documentEntityId;
	if (documentEntityId !== null && (typeof documentEntityId !== "string" || documentEntityId.length === 0))
		return undefined;
	return { documentEntityId };
}

function parseJsonObject(value: string | null): Readonly<Record<string, unknown>> | null {
	if (!value) return null;
	try {
		const parsed = JSON.parse(value) as unknown;
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Readonly<Record<string, unknown>>)
			: null;
	} catch {
		return null;
	}
}
