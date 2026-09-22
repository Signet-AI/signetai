import { createHash, randomUUID } from "node:crypto";
import { addImportedSource, resolveDefaultBasePath } from "@signet/core";
import {
	appendTranscriptChunk,
	beginTranscriptUpload,
	bindTranscriptSource,
	sealTranscriptUpload,
	TRANSCRIPT_UPLOAD_BYTES,
	type TranscriptUploadScope,
} from "./transcript-import-bytes";
import { withTranscriptImportOperationLock } from "./transcript-import-operation-lock";
import { controlImport, createJob, createOwnerTranscriptImportStore } from "./transcript-import-store";

export interface TranscriptImportAdmissionInput {
	readonly agentId: string;
	readonly fileName: string;
	readonly bytes: Uint8Array;
	readonly duplicateMode?: "skip" | "replace" | "reimport";
	readonly workspaceRoot?: string;
}

export interface TranscriptImportAdmissionResult {
	readonly jobId: string;
	readonly fileId: string;
	readonly sourceId: string;
}

const checksum = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** Stage exact JSONL bytes through the canonical transcript import state machine. */
export async function stageTranscriptImport(
	input: TranscriptImportAdmissionInput,
): Promise<TranscriptImportAdmissionResult> {
	if (!input.agentId || !input.fileName || !/\.jsonl$/i.test(input.fileName))
		throw new Error("canonical transcript import requires a JSONL file and agent scope");
	if (input.bytes.byteLength === 0) throw new Error("transcript import is empty");

	return withTranscriptImportOperationLock("transcript-import", async () => {
		const jobId = randomUUID();
		const fileId = randomUUID();
		const scope: TranscriptUploadScope = { agentId: input.agentId, jobId, fileId, generation: 0 };
		await createJob({
			jobId,
			agentId: input.agentId,
			schemaId: "signet-export",
			duplicateMode: input.duplicateMode ?? "skip",
			files: [{ id: fileId, name: input.fileName }],
		});
		await beginTranscriptUpload(scope, input.bytes.byteLength);
		for (let offset = 0; offset < input.bytes.byteLength; offset += TRANSCRIPT_UPLOAD_BYTES) {
			const chunk = input.bytes.subarray(offset, Math.min(input.bytes.byteLength, offset + TRANSCRIPT_UPLOAD_BYTES));
			await appendTranscriptChunk(scope, offset, chunk, checksum(chunk));
		}
		const sealed = await sealTranscriptUpload(scope);
		if (!sealed.content_hash) throw new Error("transcript import did not seal");
		const added = addImportedSource(
			{
				fileName: input.fileName,
				contentHash: sealed.content_hash,
				format: "jsonl",
				agentId: input.agentId,
				duplicateMode: input.duplicateMode ?? "skip",
				importKey: `${jobId}:${fileId}:0`,
			},
			input.workspaceRoot ?? resolveDefaultBasePath(),
		);
		if (!added.ok) throw new Error(added.error);
		await bindTranscriptSource(scope, added.source.id);
		const started = await controlImport(createOwnerTranscriptImportStore(), {
			jobId,
			agentId: input.agentId,
			control: "start",
		});
		if (!started) throw new Error("transcript import could not start");
		return { jobId, fileId, sourceId: added.source.id };
	});
}
