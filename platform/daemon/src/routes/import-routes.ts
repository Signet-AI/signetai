import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import type { Context } from "hono";
import type { Hono } from "hono";
import { getPeerAddress } from "../auth/middleware";
import { type DocumentImportStatus, importDocument } from "../document-import-service";
import { IMPORT_MAX_BATCH_BYTES, IMPORT_MAX_FILES, IMPORT_MAX_FILE_BYTES } from "../import-normalizer";
import type { DurableImportAdmission } from "../import-inbox";

const MAX_MULTIPART_OVERHEAD = 1 * 1024 * 1024;
const MAX_MULTIPART_BYTES = IMPORT_MAX_BATCH_BYTES + MAX_MULTIPART_OVERHEAD;

class ImportPayloadTooLargeError extends Error {}

export interface ImportRouteDeps {
	readonly durableImportAdmission: DurableImportAdmission;
}

export function registerImportRoutes(app: Hono, deps: ImportRouteDeps): void {
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
		// Transcript JSONL has a separate durable importer with byte-offset
		// checkpoints and transcript-specific duplicate semantics. Never let the
		// generic document normalizer create a second transcript path.
		if ([...uploadedEntries.map((file) => file.name), ...pathEntries].some((name) => /\.jsonl$/i.test(name)))
			return c.json({ error: "Transcript JSONL must be uploaded through /api/sources/imports" }, 400);
		if (uploadedEntries.length + pathEntries.length > IMPORT_MAX_FILES)
			return c.json({ error: `Import accepts at most ${IMPORT_MAX_FILES} files` }, 413);

		const duplicateModeValue = form.get("duplicateMode");
		const duplicateMode =
			duplicateModeValue === "replace" || duplicateModeValue === "reimport" ? duplicateModeValue : "skip";
		const statuses: DocumentImportStatus[] = [];
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
			const fileBytes = new Uint8Array(await file.arrayBuffer());
			let admission: Awaited<ReturnType<DurableImportAdmission["admit"]>> | undefined;
			try {
				admission = await deps.durableImportAdmission.admit({
					fileName: file.name,
					bytes: fileBytes,
					contentType: file.type,
				});
				await deps.durableImportAdmission.begin(admission.key);
				const result = await importDocument({
					fileName: file.name,
					bytes: fileBytes,
					contentType: file.type,
					duplicateMode,
					maxPersistedBytes: IMPORT_MAX_BATCH_BYTES - normalizedBatchBytes,
				});
				normalizedBatchBytes += result.persistedBytes;
				await deps.durableImportAdmission.complete({
					key: admission.key,
					status: result.status.status,
					...(result.status.status === "failed"
						? { error: result.status.error }
						: { sourceId: result.status.sourceId }),
				});
				statuses.push(result.status);
				if (result.status.status === "imported") imported++;
			} catch (error) {
				const message = error instanceof Error ? error.message : "durable import failed";
				if (admission)
					await deps.durableImportAdmission
						.complete({ key: admission.key, status: "failed", error: message })
						.catch(() => {});
				statuses.push({ fileName: file.name, status: "failed", error: message });
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
