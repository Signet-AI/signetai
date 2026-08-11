import { getDbAccessor } from "./db-accessor";

export interface ImportExtractionOutcome {
	readonly documentEntityId: string | null;
	readonly aspectsCreated: number;
	readonly attributesCreated: number;
}

export function persistImportedSourceOutcome(input: {
	readonly agentId: string;
	readonly sourceId: string;
	readonly sourcePath: string;
	readonly outcome: ImportExtractionOutcome;
}): void {
	getDbAccessor().withWriteTx((db) => {
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
	});
}

export function readImportedSourceOutcome(sourceId: string, agentId: string): ImportExtractionOutcome | undefined {
	return getDbAccessor().withReadDb((db) => {
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
	});
}

function parseImportExtractionOutcome(value: unknown): ImportExtractionOutcome | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const candidate = value as Record<string, unknown>;
	const documentEntityId = candidate.documentEntityId;
	const aspectsCreated = candidate.aspectsCreated;
	const attributesCreated = candidate.attributesCreated;
	if (documentEntityId !== null && (typeof documentEntityId !== "string" || documentEntityId.length === 0))
		return undefined;
	if (!isNonNegativeInteger(aspectsCreated) || !isNonNegativeInteger(attributesCreated)) return undefined;
	return { documentEntityId, aspectsCreated, attributesCreated };
}

function isNonNegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
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
