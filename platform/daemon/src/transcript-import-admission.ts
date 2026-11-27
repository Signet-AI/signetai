import { resolveImportSourceIdentity } from "./import-source-identity";
import { createHash, randomUUID } from "node:crypto";
import { addImportedSource, resolveDefaultBasePath } from "@signet/core";
import type { ClassificationActor } from "./classifications";
import type { WriteAuthor } from "./auth/audit-owner";
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
	readonly author: WriteAuthor;
	readonly agentId: string;
	readonly fileName: string;
	readonly bytes: Uint8Array;
	readonly duplicateMode?: "skip" | "replace" | "reimport";
	readonly workspaceRoot?: string;
	readonly classificationId?: string;
	readonly actor?: ClassificationActor;
}

export interface TranscriptImportAdmissionResult {
	readonly jobId: string;
	readonly fileId: string;
	readonly sourceId: string;
}

const checksum = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
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
			author: input.author,
			jobId,
			agentId: input.agentId,
			schemaId: "signet-export",
			duplicateMode: input.duplicateMode ?? "skip",
			files: [{ id: fileId, name: input.fileName }],
			classificationId: input.classificationId,
			actor: input.actor,
		});
		await beginTranscriptUpload(scope, input.bytes.byteLength);
		for (let offset = 0; offset < input.bytes.byteLength; offset += TRANSCRIPT_UPLOAD_BYTES) {
			const chunk = input.bytes.subarray(offset, Math.min(input.bytes.byteLength, offset + TRANSCRIPT_UPLOAD_BYTES));
			await appendTranscriptChunk(scope, offset, chunk, checksum(chunk));
		}
		const sealed = await sealTranscriptUpload(scope);
		if (!sealed.content_hash) throw new Error("transcript import did not seal");
		const identity = await resolveImportSourceIdentity({
			...input,
			jobId,
			contentHash: sealed.content_hash,
			newGeneration: input.duplicateMode === "reimport",
			workspaceRoot: input.workspaceRoot ?? resolveDefaultBasePath(),
		});
		const duplicate = identity.duplicate;
		const sourceId = identity.sourceId;
		await bindTranscriptSource(scope, sourceId, duplicate?.id);
		const added = addImportedSource(
			{
				fileName: input.fileName,
				writeIdentity: {
					agentId: input.agentId,
					authorUserId: input.author.userId,
					authorCredential: input.author.credential,
				},
				classificationKey: identity.classificationKey,
				contentRegistry: true,
				duplicateSourceId: duplicate?.id ?? null,
				contentHash: sealed.content_hash,
				format: "jsonl",
				agentId: input.agentId,
				duplicateMode: input.duplicateMode ?? "skip",
				importKey: `${jobId}:${fileId}:0`,
				sourceId,
			},
			input.workspaceRoot ?? resolveDefaultBasePath(),
		);
		if (!added.ok) throw new Error(added.error);
		if (added.source.id !== sourceId) await bindTranscriptSource(scope, added.source.id);
		const started = await controlImport(createOwnerTranscriptImportStore(), {
			jobId,
			agentId: input.agentId,
			control: "start",
		});
		if (!started) throw new Error("transcript import could not start");
		return { jobId, fileId, sourceId: added.source.id };
	});
}
