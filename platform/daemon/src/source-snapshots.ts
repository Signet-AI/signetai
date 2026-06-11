import type { Database } from "bun:sqlite";
import { SOURCE_CHUNK_SOURCE_TYPE, type SignetSourceEntry } from "@signetai/core";
import { getDbAccessor } from "./db-accessor";
import type { WriteDb } from "./db-accessor";
import { syncVecDeleteByEmbeddingIds } from "./db-helpers";
import { hashNormalizedBody } from "./memory-lineage";
import { indexSourceArtifactStructureInTx } from "./source-artifact-graph";

export const SOURCE_SNAPSHOT_VERSION = 1;

export interface SourceSnapshotArtifact {
	readonly sourcePath: string;
	readonly sourceSha256: string;
	readonly sourceKind: string;
	readonly sessionId: string;
	readonly sessionKey: string | null;
	readonly sessionToken: string;
	readonly project: string | null;
	readonly harness: string | null;
	readonly capturedAt: string;
	readonly startedAt: string | null;
	readonly endedAt: string | null;
	readonly manifestPath: string | null;
	readonly sourceNodeId: string | null;
	readonly memorySentence: string | null;
	readonly memorySentenceQuality: string | null;
	readonly content: string;
	readonly updatedAt: string;
	readonly sourceMtimeMs: number | null;
	readonly sourceId: string;
	readonly sourceRoot: string | null;
	readonly sourceExternalId: string | null;
	readonly sourceParentPath: string | null;
	readonly sourceMetaJson: string | null;
}

export interface SourceSnapshot {
	readonly version: typeof SOURCE_SNAPSHOT_VERSION;
	readonly exportedAt: string;
	readonly source: {
		readonly id: string;
		readonly kind: string;
		readonly name: string;
		readonly root: string;
	};
	readonly agentId: string;
	readonly artifacts: readonly SourceSnapshotArtifact[];
	readonly skipped: {
		readonly localDiscordArtifacts: number;
	};
}

export interface ExportSourceSnapshotOptions {
	readonly source: SignetSourceEntry;
	readonly agentId: string;
	readonly includeLocalDiscord?: boolean;
}

export interface ImportSourceSnapshotOptions {
	readonly source: SignetSourceEntry;
	readonly agentId: string;
	readonly snapshot: unknown;
	readonly includeLocalDiscord?: boolean;
}

export type ImportSourceSnapshotResult =
	| {
			readonly ok: true;
			readonly imported: number;
			readonly skipped: { readonly localDiscordArtifacts: number };
	  }
	| { readonly ok: false; readonly error: string };

interface ArtifactRow {
	readonly source_path: string;
	readonly source_sha256: string;
	readonly source_kind: string;
	readonly session_id: string;
	readonly session_key: string | null;
	readonly session_token: string;
	readonly project: string | null;
	readonly harness: string | null;
	readonly captured_at: string;
	readonly started_at: string | null;
	readonly ended_at: string | null;
	readonly manifest_path: string | null;
	readonly source_node_id: string | null;
	readonly memory_sentence: string | null;
	readonly memory_sentence_quality: string | null;
	readonly content: string;
	readonly updated_at: string;
	readonly source_mtime_ms: number | null;
	readonly source_id: string;
	readonly source_root: string | null;
	readonly source_external_id: string | null;
	readonly source_parent_path: string | null;
	readonly source_meta_json: string | null;
}

export function exportSourceSnapshot(options: ExportSourceSnapshotOptions): SourceSnapshot {
	const includeLocalDiscord = options.includeLocalDiscord === true;
	return getDbAccessor().withReadDb((db) => {
		let skippedLocal = 0;
		const artifacts = (
			db
				.prepare(
					`SELECT source_path, source_sha256, source_kind, session_id,
					        session_key, session_token, project, harness, captured_at,
					        started_at, ended_at, manifest_path, source_node_id,
					        memory_sentence, memory_sentence_quality, content,
					        updated_at, source_mtime_ms, source_id, source_root,
					        source_external_id, source_parent_path, source_meta_json
					   FROM memory_artifacts
					  WHERE agent_id = ?
					    AND source_id = ?
					    AND COALESCE(is_deleted, 0) = 0
					  ORDER BY source_path ASC`,
				)
				.all(options.agentId, options.source.id) as ArtifactRow[]
		).flatMap((row) => {
			const artifact = artifactFromRow(row);
			if (!includeLocalDiscord && isLocalDiscordArtifact(artifact)) {
				skippedLocal++;
				return [];
			}
			return [artifact];
		});

		return {
			version: SOURCE_SNAPSHOT_VERSION,
			exportedAt: new Date().toISOString(),
			source: {
				id: options.source.id,
				kind: options.source.kind,
				name: options.source.name,
				root: options.source.root,
			},
			agentId: options.agentId,
			artifacts,
			skipped: { localDiscordArtifacts: skippedLocal },
		};
	});
}

export function importSourceSnapshot(options: ImportSourceSnapshotOptions): ImportSourceSnapshotResult {
	const snapshot = parseSourceSnapshot(options.snapshot);
	if (snapshot.ok === false) return snapshot;
	if (snapshot.value.source.id !== options.source.id) {
		return { ok: false, error: `Snapshot source id ${snapshot.value.source.id} does not match ${options.source.id}` };
	}
	if (snapshot.value.source.kind !== options.source.kind) {
		return {
			ok: false,
			error: `Snapshot source kind ${snapshot.value.source.kind} does not match ${options.source.kind}`,
		};
	}

	const includeLocalDiscord = options.includeLocalDiscord === true;
	const artifacts: SourceSnapshotArtifact[] = [];
	let skippedLocal = 0;
	for (const artifact of snapshot.value.artifacts) {
		if (artifact.sourceId !== options.source.id) {
			return { ok: false, error: `Snapshot artifact ${artifact.sourcePath} belongs to ${artifact.sourceId}` };
		}
		if (hashNormalizedBody(artifact.content) !== artifact.sourceSha256) {
			return { ok: false, error: `Snapshot artifact checksum mismatch: ${artifact.sourcePath}` };
		}
		if (!includeLocalDiscord && isLocalDiscordArtifact(artifact)) {
			skippedLocal++;
			continue;
		}
		artifacts.push(artifact);
	}

	try {
		getDbAccessor().withWriteTx((db) => {
			const writeDb = db as WriteDb as Database;
			const conflict = findPathOwnershipConflict(writeDb, artifacts, options.agentId, options.source.id);
			if (conflict) throw new Error(conflict);
			purgeImportScopeGraph(writeDb, options.source.id, options.agentId, options.source.root, includeLocalDiscord);
			deleteImportScope(writeDb, options.source.id, options.agentId, includeLocalDiscord);
			purgeImportScopeChunks(writeDb, options.source.id, options.agentId, includeLocalDiscord);
			const stmt = writeDb.prepare(
				`INSERT INTO memory_artifacts (
				agent_id, source_path, source_sha256, source_kind, session_id,
				session_key, session_token, project, harness, captured_at,
				started_at, ended_at, manifest_path, source_node_id,
				memory_sentence, memory_sentence_quality, content, updated_at,
				source_mtime_ms, source_id, source_root, source_external_id,
				source_parent_path, source_meta_json
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(agent_id, source_path) DO UPDATE SET
				source_sha256 = excluded.source_sha256,
				source_kind = excluded.source_kind,
				session_id = excluded.session_id,
				session_key = excluded.session_key,
				session_token = excluded.session_token,
				project = excluded.project,
				harness = excluded.harness,
				captured_at = excluded.captured_at,
				started_at = excluded.started_at,
				ended_at = excluded.ended_at,
				manifest_path = excluded.manifest_path,
				source_node_id = excluded.source_node_id,
				memory_sentence = excluded.memory_sentence,
				memory_sentence_quality = excluded.memory_sentence_quality,
				content = excluded.content,
				updated_at = excluded.updated_at,
				source_mtime_ms = excluded.source_mtime_ms,
				source_id = excluded.source_id,
				source_root = excluded.source_root,
				source_external_id = excluded.source_external_id,
				source_parent_path = excluded.source_parent_path,
				source_meta_json = excluded.source_meta_json,
				is_deleted = 0,
				deleted_at = NULL
			WHERE memory_artifacts.source_id = excluded.source_id`,
			);
			for (const artifact of artifacts) {
				stmt.run(
					options.agentId,
					artifact.sourcePath,
					artifact.sourceSha256,
					artifact.sourceKind,
					artifact.sessionId,
					artifact.sessionKey,
					artifact.sessionToken,
					artifact.project,
					artifact.harness,
					artifact.capturedAt,
					artifact.startedAt,
					artifact.endedAt,
					artifact.manifestPath,
					artifact.sourceNodeId,
					artifact.memorySentence,
					artifact.memorySentenceQuality,
					artifact.content,
					artifact.updatedAt,
					artifact.sourceMtimeMs,
					artifact.sourceId,
					artifact.sourceRoot,
					artifact.sourceExternalId,
					artifact.sourceParentPath,
					artifact.sourceMetaJson,
				);
				if (indexesSnapshotArtifactGraph(artifact)) {
					indexSourceArtifactStructureInTx(
						db as WriteDb,
						{
							agentId: options.agentId,
							sourceId: artifact.sourceId,
							sourceKind: artifact.sourceKind,
							sourceRoot: artifact.sourceRoot ?? options.source.root,
							sourceParentPath: artifact.sourceParentPath ?? undefined,
							sourcePath: artifact.sourcePath,
							displayName: sourceArtifactDisplayName(artifact),
							content: artifact.content,
						},
						artifact.updatedAt,
					);
				}
			}
		});
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}

	return { ok: true, imported: artifacts.length, skipped: { localDiscordArtifacts: skippedLocal } };
}

function findPathOwnershipConflict(
	db: Database,
	artifacts: readonly SourceSnapshotArtifact[],
	agentId: string,
	sourceId: string,
): string | null {
	const stmt = db.prepare("SELECT source_id FROM memory_artifacts WHERE agent_id = ? AND source_path = ? LIMIT 1");
	for (const artifact of artifacts) {
		const row = stmt.get(agentId, artifact.sourcePath) as { source_id: string | null } | undefined;
		if (row && row.source_id !== sourceId) {
			return `Snapshot artifact path is already owned by another source: ${artifact.sourcePath}`;
		}
	}
	return null;
}

function deleteImportScope(db: Database, sourceId: string, agentId: string, includeLocalDiscord: boolean): void {
	if (includeLocalDiscord) {
		db.prepare("DELETE FROM memory_artifacts WHERE agent_id = ? AND source_id = ?").run(agentId, sourceId);
		return;
	}
	const rows = db
		.prepare(
			`SELECT source_path, source_meta_json
			   FROM memory_artifacts
			  WHERE agent_id = ?
			    AND source_id = ?`,
		)
		.all(agentId, sourceId) as Array<{ source_path: string; source_meta_json: string | null }>;
	const stmt = db.prepare("DELETE FROM memory_artifacts WHERE agent_id = ? AND source_path = ?");
	for (const row of rows) {
		if (isLocalDiscordArtifact({ sourcePath: row.source_path, sourceMetaJson: row.source_meta_json })) continue;
		stmt.run(agentId, row.source_path);
	}
}

function purgeImportScopeChunks(db: Database, sourceId: string, agentId: string, includeLocalDiscord: boolean): void {
	const prefix = `${sourceId}:`;
	const rows = db
		.prepare(
			`SELECT id, source_id, chunk_text
			   FROM embeddings
			  WHERE agent_id = ?
			    AND source_type = ?
			    AND source_id >= ?
			    AND source_id < ?`,
		)
		.all(agentId, SOURCE_CHUNK_SOURCE_TYPE, prefix, `${prefix}\uffff`) as Array<{
		id: string;
		source_id: string;
		chunk_text: string | null;
	}>;
	const ids = rows.filter((row) => includeLocalDiscord || !isLocalDiscordChunk(row)).map((row) => row.id);
	syncVecDeleteByEmbeddingIds(db as WriteDb, ids);
	const stmt = db.prepare("DELETE FROM embeddings WHERE id = ?");
	for (const id of ids) stmt.run(id);
}

function purgeImportScopeGraph(
	db: Database,
	sourceId: string,
	agentId: string,
	sourceRoot: string,
	includeLocalDiscord: boolean,
): void {
	const entityRows = db
		.prepare(
			`SELECT id, source_path
			   FROM entities
			  WHERE agent_id = ?
			    AND source_id = ?`,
		)
		.all(agentId, sourceId) as Array<{ id: string; source_path: string | null }>;
	const entityIds = entityRows
		.filter((row) => shouldPurgeImportedSourcePath(row.source_path, sourceRoot, includeLocalDiscord))
		.map((row) => row.id);

	const attrRows = db
		.prepare(
			`SELECT id, source_path
			   FROM entity_attributes
			  WHERE agent_id = ?
			    AND source_id = ?`,
		)
		.all(agentId, sourceId) as Array<{ id: string; source_path: string | null }>;
	const depRows = db
		.prepare(
			`SELECT id, source_path
			   FROM entity_dependencies
			  WHERE agent_id = ?
			    AND source_id = ?`,
		)
		.all(agentId, sourceId) as Array<{ id: string; source_path: string | null }>;
	const communityRows = db
		.prepare(
			`SELECT id, source_path
			   FROM entity_communities
			  WHERE agent_id = ?
			    AND source_id = ?`,
		)
		.all(agentId, sourceId) as Array<{ id: string; source_path: string | null }>;

	const deleteAspect = db.prepare("DELETE FROM entity_aspects WHERE agent_id = ? AND entity_id = ?");
	for (const entityId of entityIds) deleteAspect.run(agentId, entityId);

	const deleteAttr = db.prepare("DELETE FROM entity_attributes WHERE agent_id = ? AND id = ?");
	for (const row of attrRows) {
		if (shouldPurgeImportedSourcePath(row.source_path, sourceRoot, includeLocalDiscord))
			deleteAttr.run(agentId, row.id);
	}

	const deleteDep = db.prepare("DELETE FROM entity_dependencies WHERE agent_id = ? AND id = ?");
	for (const row of depRows) {
		if (shouldPurgeImportedSourcePath(row.source_path, sourceRoot, includeLocalDiscord)) deleteDep.run(agentId, row.id);
	}

	const deleteCommunity = db.prepare("DELETE FROM entity_communities WHERE agent_id = ? AND id = ?");
	for (const row of communityRows) {
		if (shouldPurgeImportedSourcePath(row.source_path, sourceRoot, includeLocalDiscord)) {
			deleteCommunity.run(agentId, row.id);
		}
	}

	const deleteEntity = db.prepare("DELETE FROM entities WHERE agent_id = ? AND id = ?");
	for (const entityId of entityIds) deleteEntity.run(agentId, entityId);
}

function shouldPurgeImportedSourcePath(
	sourcePath: string | null,
	sourceRoot: string,
	includeLocalDiscord: boolean,
): boolean {
	if (includeLocalDiscord) return true;
	if (sourcePath === sourceRoot) return false;
	return !isLocalDiscordArtifact({ sourcePath: sourcePath ?? "", sourceMetaJson: null });
}

function indexesSnapshotArtifactGraph(artifact: SourceSnapshotArtifact): boolean {
	return !["source_discord_checkpoint", "source_discord_failure", "source_github_failure"].includes(
		artifact.sourceKind,
	);
}

function sourceArtifactDisplayName(artifact: SourceSnapshotArtifact): string | undefined {
	if (!artifact.sourceMetaJson) return undefined;
	try {
		const parsed = JSON.parse(artifact.sourceMetaJson) as unknown;
		if (!isRecord(parsed)) return undefined;
		for (const key of ["name", "username", "filename", "title"] as const) {
			const value = parsed[key];
			if (typeof value === "string" && value.trim().length > 0) return value.trim();
		}
	} catch {
		return undefined;
	}
	return undefined;
}

function artifactFromRow(row: ArtifactRow): SourceSnapshotArtifact {
	return {
		sourcePath: row.source_path,
		sourceSha256: row.source_sha256,
		sourceKind: row.source_kind,
		sessionId: row.session_id,
		sessionKey: row.session_key,
		sessionToken: row.session_token,
		project: row.project,
		harness: row.harness,
		capturedAt: row.captured_at,
		startedAt: row.started_at,
		endedAt: row.ended_at,
		manifestPath: row.manifest_path,
		sourceNodeId: row.source_node_id,
		memorySentence: row.memory_sentence,
		memorySentenceQuality: row.memory_sentence_quality,
		content: row.content,
		updatedAt: row.updated_at,
		sourceMtimeMs: row.source_mtime_ms,
		sourceId: row.source_id,
		sourceRoot: row.source_root,
		sourceExternalId: row.source_external_id,
		sourceParentPath: row.source_parent_path,
		sourceMetaJson: row.source_meta_json,
	};
}

function parseSourceSnapshot(value: unknown): { ok: true; value: SourceSnapshot } | { ok: false; error: string } {
	if (!isRecord(value)) return { ok: false, error: "Snapshot must be a JSON object" };
	if (value.version !== SOURCE_SNAPSHOT_VERSION) return { ok: false, error: "Unsupported source snapshot version" };
	if (!isRecord(value.source)) return { ok: false, error: "Snapshot source must be an object" };
	const source = {
		id: readString(value.source, "id"),
		kind: readString(value.source, "kind"),
		name: readString(value.source, "name"),
		root: readString(value.source, "root"),
	};
	if (!source.id || !source.kind || !source.name || !source.root) {
		return { ok: false, error: "Snapshot source is missing id, kind, name, or root" };
	}
	const exportedAt = readString(value, "exportedAt");
	const agentId = readString(value, "agentId");
	if (!exportedAt || !agentId) return { ok: false, error: "Snapshot is missing exportedAt or agentId" };
	if (!Array.isArray(value.artifacts)) return { ok: false, error: "Snapshot artifacts must be an array" };

	const artifacts: SourceSnapshotArtifact[] = [];
	for (const artifact of value.artifacts) {
		const parsed = parseArtifact(artifact);
		if (parsed.ok === false) return parsed;
		artifacts.push(parsed.value);
	}

	const skipped = isRecord(value.skipped)
		? { localDiscordArtifacts: readNumber(value.skipped, "localDiscordArtifacts") ?? 0 }
		: { localDiscordArtifacts: 0 };
	return { ok: true, value: { version: SOURCE_SNAPSHOT_VERSION, exportedAt, source, agentId, artifacts, skipped } };
}

function parseArtifact(value: unknown): { ok: true; value: SourceSnapshotArtifact } | { ok: false; error: string } {
	if (!isRecord(value)) return { ok: false, error: "Snapshot artifact must be an object" };
	const required = {
		sourcePath: readString(value, "sourcePath"),
		sourceSha256: readString(value, "sourceSha256"),
		sourceKind: readString(value, "sourceKind"),
		sessionId: readString(value, "sessionId"),
		sessionToken: readString(value, "sessionToken"),
		content: readString(value, "content"),
		updatedAt: readString(value, "updatedAt"),
		sourceId: readString(value, "sourceId"),
		capturedAt: readString(value, "capturedAt"),
	};
	for (const [key, entry] of Object.entries(required)) {
		if (!entry) return { ok: false, error: `Snapshot artifact is missing ${key}` };
	}
	return {
		ok: true,
		value: {
			...required,
			sessionKey: readNullableString(value, "sessionKey"),
			project: readNullableString(value, "project"),
			harness: readNullableString(value, "harness"),
			startedAt: readNullableString(value, "startedAt"),
			endedAt: readNullableString(value, "endedAt"),
			manifestPath: readNullableString(value, "manifestPath"),
			sourceNodeId: readNullableString(value, "sourceNodeId"),
			memorySentence: readNullableString(value, "memorySentence"),
			memorySentenceQuality: readNullableString(value, "memorySentenceQuality"),
			sourceMtimeMs: readNullableNumber(value, "sourceMtimeMs"),
			sourceRoot: readNullableString(value, "sourceRoot"),
			sourceExternalId: readNullableString(value, "sourceExternalId"),
			sourceParentPath: readNullableString(value, "sourceParentPath"),
			sourceMetaJson: readNullableString(value, "sourceMetaJson"),
		},
	};
}

function isLocalDiscordArtifact(input: {
	readonly sourcePath: string;
	readonly sourceMetaJson: string | null;
}): boolean {
	if (input.sourcePath.startsWith("discord-cache://guild/@me/")) return true;
	if (!input.sourceMetaJson) return false;
	try {
		const parsed = JSON.parse(input.sourceMetaJson) as unknown;
		return isRecord(parsed) && parsed.guildId === "@me";
	} catch {
		return false;
	}
}

function isLocalDiscordChunk(input: {
	readonly source_id: string;
	readonly chunk_text: string | null;
}): boolean {
	if (input.source_id.includes("discord-cache://guild/@me/")) return true;
	if (!input.chunk_text) return false;
	return (
		input.chunk_text.includes("source_path: discord-cache://guild/@me/") || input.chunk_text.includes('"guildId":"@me"')
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, key: string): string {
	const value = record[key];
	return typeof value === "string" ? value : "";
}

function readNullableString(record: Record<string, unknown>, key: string): string | null {
	const value = record[key];
	return typeof value === "string" ? value : null;
}

function readNumber(record: Record<string, unknown>, key: string): number | null {
	const value = record[key];
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readNullableNumber(record: Record<string, unknown>, key: string): number | null {
	return readNumber(record, key);
}
