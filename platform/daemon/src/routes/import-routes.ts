import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import { addImportedSource, loadSourcesConfig, markSourceIndexed, removeSource } from "@signet/core";
import type { Context } from "hono";
import type { Hono } from "hono";
import { resolveDaemonAgentId } from "../agent-id";
import { getPeerAddress } from "../auth/middleware";
import { getDbAccessor } from "../db-accessor";
import {
	IMPORT_MAX_BATCH_BYTES,
	IMPORT_MAX_FILES,
	IMPORT_MAX_FILE_BYTES,
	normalizeImportedFile,
} from "../import-normalizer";
import { markImportedSourceUnsupported } from "../imported-source-lifecycle";
import {
	type ImportExtractionOutcome,
	persistImportedSourceOutcome,
	readImportedSourceOutcome,
} from "../imported-source-outcome";
import { logger } from "../logger";
import { indexExternalMemoryArtifact } from "../memory-lineage";
import { enqueueDreamingAttentionInTx } from "../pipeline/dreaming-attention";
import { indexSourceArtifactStructure } from "../source-artifact-graph";
import { purgeSourceOwnedRows } from "../source-purge";

const MAX_MULTIPART_OVERHEAD = 1 * 1024 * 1024;
const MAX_MULTIPART_BYTES = IMPORT_MAX_BATCH_BYTES + MAX_MULTIPART_OVERHEAD;

class ImportPayloadTooLargeError extends Error {}

type ImportFileStatus =
	| {
			readonly fileName: string;
			readonly status: "imported";
			readonly sourceId: string;
			readonly format: string;
			readonly duplicate: boolean;
			readonly extraction: ImportExtractionOutcome;
	  }
	| {
			readonly fileName: string;
			readonly status: "duplicate";
			readonly sourceId: string;
			readonly extraction?: ImportExtractionOutcome;
	  }
	| { readonly fileName: string; readonly status: "failed"; readonly error: string };

export function registerImportRoutes(app: Hono): void {
	app.post("/api/sources/import", async (c) => {
		const contentLength = Number.parseInt(c.req.header("content-length") ?? "", 10);
		if (Number.isFinite(contentLength) && contentLength > IMPORT_MAX_BATCH_BYTES + MAX_MULTIPART_OVERHEAD) {
			return c.json({ error: `Import batch exceeds the ${IMPORT_MAX_BATCH_BYTES} byte limit` }, 413);
		}

		let form: FormData;
		try {
			form = await boundedFormData(c.req.raw);
		} catch (error) {
			if (error instanceof ImportPayloadTooLargeError)
				return c.json({ error: `Import batch exceeds the ${IMPORT_MAX_BATCH_BYTES} byte limit` }, 413);
			return c.json({ error: "Expected a multipart form with files" }, 400);
		}
		const uploadedEntries = form.getAll("files").filter((entry): entry is File => entry instanceof File);
		const pathEntries = form
			.getAll("paths")
			.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
		if (pathEntries.length > 0 && !isLoopbackRequest(c))
			return c.json({ error: "Filesystem path imports are only available on a local daemon" }, 400);
		if (uploadedEntries.length + pathEntries.length === 0)
			return c.json({ error: "At least one file is required" }, 400);
		if (uploadedEntries.length + pathEntries.length > IMPORT_MAX_FILES)
			return c.json({ error: `Import accepts at most ${IMPORT_MAX_FILES} files` }, 413);

		const duplicateModeValue = form.get("duplicateMode");
		const duplicateMode =
			duplicateModeValue === "replace" || duplicateModeValue === "reimport" ? duplicateModeValue : "skip";
		const statuses: ImportFileStatus[] = [];
		const pathFiles: File[] = [];
		const uploadedBytes = uploadedEntries.reduce((total, file) => total + file.size, 0);
		let pathBytes = 0;
		for (const path of pathEntries) {
			try {
				const fileStat = await stat(path);
				if (!fileStat.isFile()) throw new Error("path is not a file");
				if (fileStat.size > IMPORT_MAX_FILE_BYTES) {
					statuses.push({
						fileName: basename(path),
						status: "failed",
						error: `File exceeds the ${IMPORT_MAX_FILE_BYTES} byte limit`,
					});
					continue;
				}
				pathBytes += fileStat.size;
				if (uploadedBytes + pathBytes > IMPORT_MAX_BATCH_BYTES)
					return c.json({ error: `Import batch exceeds the ${IMPORT_MAX_BATCH_BYTES} byte limit` }, 413);
				pathFiles.push(new File([new Uint8Array(await readFile(path))], basename(path)));
			} catch (error) {
				statuses.push({
					fileName: basename(path),
					status: "failed",
					error: error instanceof Error ? error.message : "Could not read file",
				});
			}
		}
		const entries = [...uploadedEntries, ...pathFiles];
		const totalBytes = entries.reduce((total, file) => total + file.size, 0);
		if (totalBytes > IMPORT_MAX_BATCH_BYTES)
			return c.json({ error: `Import batch exceeds the ${IMPORT_MAX_BATCH_BYTES} byte limit` }, 413);

		let imported = 0;
		let normalizedBatchBytes = 0;
		for (const file of entries) {
			if (file.size > IMPORT_MAX_FILE_BYTES) {
				statuses.push({
					fileName: file.name,
					status: "failed",
					error: `File exceeds the ${IMPORT_MAX_FILE_BYTES} byte limit`,
				});
				continue;
			}
			const normalized = await normalizeImportedFile(file.name, new Uint8Array(await file.arrayBuffer()), file.type);
			if (normalized.ok === false) {
				statuses.push({ fileName: file.name, status: "failed", error: normalized.error });
				continue;
			}
			const normalizedBytes = persistedImportBytes(normalized.value);
			if (normalizedBatchBytes + normalizedBytes > IMPORT_MAX_BATCH_BYTES) {
				statuses.push({
					fileName: file.name,
					status: "failed",
					error: `Normalized import batch exceeds the ${IMPORT_MAX_BATCH_BYTES} byte limit`,
				});
				continue;
			}
			normalizedBatchBytes += normalizedBytes;

			const agentsDir = process.env.SIGNET_PATH;
			const agentId = resolveDaemonAgentId();
			const replacedSource =
				duplicateMode === "replace"
					? loadSourcesConfig(agentsDir).sources.find(
							(source) =>
								source.kind === "import" &&
								source.providerSettings?.contentHash === normalized.value.contentHash &&
								source.providerSettings?.agentId === agentId,
						)
					: undefined;
			const added = addImportedSource(
				{
					fileName: normalized.value.fileName,
					contentHash: normalized.value.contentHash,
					format: normalized.value.format,
					agentId,
					duplicateMode: replacedSource === undefined ? duplicateMode : "reimport",
				},
				agentsDir,
			);
			if (added.ok === false) {
				statuses.push({ fileName: file.name, status: "failed", error: added.error });
				continue;
			}
			if (added.duplicate && duplicateMode === "skip" && hasIndexedSource(added.source.id, resolveDaemonAgentId())) {
				statuses.push({
					fileName: file.name,
					status: "duplicate",
					sourceId: added.source.id,
					extraction: readImportedSourceOutcome(added.source.id, agentId),
				});
				continue;
			}

			try {
				const sourcePath = `imports/${added.source.id}/${normalized.value.fileName}`;
				const sourceKind = `source_import_${normalized.value.format}`;
				const now = new Date().toISOString();

				indexExternalMemoryArtifact({
					agentId,
					sourcePath,
					sourceKind: normalized.value.format === "json" ? "source_import_json_projection" : sourceKind,
					harness: "dashboard-import",
					content: normalized.value.content,
					sourceMtimeMs: Date.now(),
					capturedAt: now,
					sourceId: added.source.id,
					sourceRoot: normalized.value.fileName,
					sourceExternalId: normalized.value.contentHash,
					sourceMeta: normalized.value.sourceMeta,
				});
				if (normalized.value.format === "json") {
					indexExternalMemoryArtifact({
						agentId,
						sourcePath: `${sourcePath}#canonical`,
						sourceKind: "source_import_json_canonical",
						harness: "dashboard-import",
						content: normalized.value.canonicalContent ?? normalized.value.content,
						sourceMtimeMs: Date.now(),
						capturedAt: now,
						sourceId: added.source.id,
						sourceRoot: normalized.value.fileName,
						sourceExternalId: normalized.value.contentHash,
						sourceMeta: { ...normalized.value.sourceMeta, representation: "structured-json-canonical" },
					});
				}
				const extraction = indexSourceArtifactStructure({
					agentId,
					sourceId: added.source.id,
					sourceKind,
					sourceRoot: normalized.value.fileName,
					sourcePath,
					displayName: normalized.value.fileName,
					content: normalized.value.content,
				});
				persistImportedSourceOutcome({
					agentId,
					sourceId: added.source.id,
					sourcePath,
					outcome: {
						documentEntityId: extraction.documentEntityId,
						aspectsCreated: extraction.aspectsCreated,
						attributesCreated: extraction.attributesCreated,
					},
				});
				for (const chunk of normalized.value.searchChunks) {
					const rowStart = typeof chunk.sourceMeta.rowStart === "number" ? chunk.sourceMeta.rowStart : 0;
					const rowEnd = typeof chunk.sourceMeta.rowEnd === "number" ? chunk.sourceMeta.rowEnd : rowStart;
					indexExternalMemoryArtifact({
						agentId,
						sourcePath: `${sourcePath}#rows-${rowStart}-${rowEnd}`,
						sourceKind: "source_import_csv_chunk",
						harness: "dashboard-import",
						content: chunk.content,
						sourceMtimeMs: Date.now(),
						capturedAt: now,
						sourceId: added.source.id,
						sourceRoot: normalized.value.fileName,
						sourceExternalId: normalized.value.contentHash,
						sourceMeta: { ...normalized.value.sourceMeta, ...chunk.sourceMeta },
					});
				}
				getDbAccessor().withWriteTx((db) => {
					enqueueDreamingAttentionInTx(db, {
						agentId,
						kind: "hygiene",
						subjectRef: `source:${added.source.id}`,
						details: { sourceId: added.source.id, sourceKind, reason: "import-completed" },
						priority: 40,
					});
				});
				if (replacedSource !== undefined) {
					try {
						markImportedSourceUnsupported({
							sourceId: replacedSource.id,
							agentId: resolveDaemonAgentId(),
							reason: "imported source replaced",
						});
					} catch (cleanupError) {
						logger.warn("documents", "Replaced dashboard import purge failed", {
							sourceId: replacedSource.id,
							error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
						});
					}
					const removed = removeSource(replacedSource.id, agentsDir);
					if (removed.ok === false)
						logger.warn("documents", "Replaced dashboard import config cleanup failed", {
							sourceId: replacedSource.id,
							error: removed.error,
						});
				}
				markSourceIndexed(added.source.id, now, agentsDir);
				imported += 1;
				statuses.push({
					fileName: file.name,
					status: "imported",
					sourceId: added.source.id,
					format: normalized.value.format,
					duplicate: added.duplicate,
					extraction: {
						documentEntityId: extraction.documentEntityId,
						aspectsCreated: extraction.aspectsCreated,
						attributesCreated: extraction.attributesCreated,
					},
				});
			} catch (error) {
				if (added.created) {
					try {
						purgeSourceOwnedRows({ sourceId: added.source.id, agentId: resolveDaemonAgentId() });
						removeSource(added.source.id, process.env.SIGNET_PATH);
					} catch (cleanupError) {
						logger.warn("documents", "Dashboard import cleanup failed", {
							sourceId: added.source.id,
							error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
						});
					}
				}
				logger.warn("documents", "Dashboard import failed after source registration", {
					sourceId: added.source.id,
					error: error instanceof Error ? error.message : String(error),
				});
				statuses.push({ fileName: file.name, status: "failed", error: "Could not persist imported source" });
			}
		}

		const failed = statuses.filter((status) => status.status === "failed").length;
		return c.json({ imported, failed, files: statuses }, failed > 0 ? 207 : 201);
	});
}

function isLoopbackRequest(c: Context): boolean {
	const peer = getPeerAddress(c);
	if (peer === null) return false;
	const normalizedPeer = peer
		.trim()
		.toLowerCase()
		.replace(/^\[|\]$/g, "");
	return (
		normalizedPeer === "localhost" ||
		normalizedPeer === "127.0.0.1" ||
		normalizedPeer === "::1" ||
		normalizedPeer === "::ffff:127.0.0.1"
	);
}

function hasIndexedSource(sourceId: string, agentId: string): boolean {
	return getDbAccessor().withReadDb((db) => {
		const row = db
			.prepare(
				`SELECT 1 AS present
				 FROM memory_artifacts
				 WHERE agent_id = ? AND source_id = ? AND COALESCE(is_deleted, 0) = 0
				 LIMIT 1`,
			)
			.get(agentId, sourceId) as { present: number } | null | undefined;
		return row != null;
	});
}

function persistedImportBytes(value: {
	readonly content: string;
	readonly canonicalContent?: string;
	readonly format: string;
	readonly searchChunks: readonly { readonly content: string }[];
}): number {
	const encoder = new TextEncoder();
	const contentBytes = encoder.encode(value.content).byteLength;
	const canonicalBytes = value.format === "json" ? encoder.encode(value.canonicalContent ?? "").byteLength : 0;
	const chunkBytes = value.searchChunks.reduce((total, chunk) => total + encoder.encode(chunk.content).byteLength, 0);
	return contentBytes + canonicalBytes + chunkBytes;
}

async function boundedFormData(request: Request): Promise<FormData> {
	if (request.body === null) return request.formData();
	const body = new ReadableStream<Uint8Array>({
		async start(controller) {
			const reader = request.body?.getReader();
			if (reader === undefined) {
				controller.close();
				return;
			}
			let totalBytes = 0;
			try {
				while (true) {
					const next = await reader.read();
					if (next.done) {
						controller.close();
						return;
					}
					totalBytes += next.value.byteLength;
					if (totalBytes > MAX_MULTIPART_BYTES) {
						await reader.cancel();
						controller.error(new ImportPayloadTooLargeError());
						return;
					}
					controller.enqueue(next.value);
				}
			} catch (error) {
				controller.error(error);
			}
		},
	});
	const boundedRequest = new Request(request, {
		body,
		duplex: "half",
	} as RequestInit & { duplex: "half" });
	return boundedRequest.formData();
}
