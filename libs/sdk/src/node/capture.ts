import { constants } from "node:fs";
import { createHash } from "node:crypto";
import type { RequestOptions } from "../transport.js";
import { open, type FileHandle } from "node:fs/promises";
import { SignetError } from "../errors.js";

async function fileFingerprint(handle: FileHandle): Promise<string> {
	const info = await handle.stat({ bigint: true });
	return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(":");
}
export interface UploadState {
	readonly uploadId: string | null;
	readonly receivedBytes: number;
	readonly totalBytes: number;
	readonly sha256: string;
	readonly fingerprint: string;
}
export function parseUploadState(value: unknown): UploadState {
	if (
		typeof value !== "object" ||
		value === null ||
		!("uploadId" in value) ||
		!(value.uploadId === null || (typeof value.uploadId === "string" && /^[a-f0-9-]{36}$/.test(value.uploadId))) ||
		!("receivedBytes" in value) ||
		typeof value.receivedBytes !== "number" ||
		!Number.isSafeInteger(value.receivedBytes) ||
		value.receivedBytes < 0 ||
		!("totalBytes" in value) ||
		typeof value.totalBytes !== "number" ||
		!Number.isSafeInteger(value.totalBytes) ||
		value.totalBytes < 1 ||
		value.totalBytes > 64 * 1024 ** 3 ||
		value.receivedBytes > value.totalBytes ||
		!("sha256" in value) ||
		typeof value.sha256 !== "string" ||
		!/^[a-f0-9]{64}$/.test(value.sha256) ||
		!("fingerprint" in value) ||
		typeof value.fingerprint !== "string" ||
		value.fingerprint.length > 200
	)
		throw new Error("Invalid upload checkpoint");
	return {
		uploadId: value.uploadId,
		receivedBytes: value.receivedBytes,
		totalBytes: value.totalBytes,
		sha256: value.sha256,
		fingerprint: value.fingerprint,
	};
}
interface RemoteCapture {
	readonly state?: UploadState;
	readonly checkpoint: (state: UploadState) => Promise<void>;
	readonly request: (method: string, path: string, options: RequestOptions) => Promise<unknown>;
}
function progress(value: unknown, total: number): { uploadId: string; receivedBytes: number; chunkBytes: number } {
	if (
		typeof value !== "object" ||
		value === null ||
		!("uploadId" in value) ||
		typeof value.uploadId !== "string" ||
		!/^[a-f0-9-]{36}$/.test(value.uploadId) ||
		!("receivedBytes" in value) ||
		typeof value.receivedBytes !== "number" ||
		!Number.isSafeInteger(value.receivedBytes) ||
		value.receivedBytes < 0 ||
		value.receivedBytes > total ||
		!("chunkBytes" in value) ||
		typeof value.chunkBytes !== "number" ||
		!Number.isSafeInteger(value.chunkBytes) ||
		value.chunkBytes < 65536 ||
		value.chunkBytes > 1024 * 1024 ||
		value.chunkBytes % 65536 !== 0
	)
		throw new Error("Invalid upload progress");
	return { uploadId: value.uploadId, receivedBytes: value.receivedBytes, chunkBytes: value.chunkBytes };
}
export async function captureRemoteSessionEnd(
	body: unknown,
	signal?: AbortSignal,
	remote?: RemoteCapture,
): Promise<unknown> {
	if (
		typeof body !== "object" ||
		body === null ||
		Array.isArray(body) ||
		!("transcriptPath" in body) ||
		typeof body.transcriptPath !== "string" ||
		!body.transcriptPath
	)
		return body;
	signal?.throwIfAborted();
	const handle = await open(body.transcriptPath, constants.O_RDONLY | constants.O_NONBLOCK);
	try {
		const before = await handle.stat();
		if (!before.isFile())
			throw new Error("Transcript capture requires a regular file; file reference retained in outbox");
		if (before.size > 4 * 1024 * 1024 && !remote)
			throw new SignetError(
				"Transcript exceeds 4 MiB inline capture limit; file reference retained in outbox for chunked-upload retry",
				"transcript_capture_deferred",
			);
		if (before.size > 4 * 1024 * 1024 && remote) {
			if (before.size > 64 * 1024 ** 3) throw new RangeError("Transcript exceeds upload byte limit");
			const fingerprint = await fileFingerprint(handle);
			if (fingerprint.split(":")[2] !== String(before.size))
				throw new SignetError("Transcript changed before hashing", "transcript_source_changed");
			let state = remote.state;
			if (state && (state.fingerprint !== fingerprint || state.totalBytes !== before.size))
				throw new SignetError("Transcript changed since upload admission", "transcript_source_changed");
			if (!state) {
				const hash = createHash("sha256"),
					block = Buffer.alloc(256 * 1024);
				for (let offset = 0; offset < before.size; ) {
					signal?.throwIfAborted();
					const { bytesRead } = await handle.read(block, 0, Math.min(block.length, before.size - offset), offset);
					if (!bytesRead) throw new Error("Transcript changed during hashing");
					hash.update(block.subarray(0, bytesRead));
					offset += bytesRead;
				}
				if ((await fileFingerprint(handle)) !== fingerprint)
					throw new SignetError("Transcript changed during hashing", "transcript_source_changed");
				state = { uploadId: null, receivedBytes: 0, totalBytes: before.size, sha256: hash.digest("hex"), fingerprint };
				await remote.checkpoint(state);
			}
			const sessionKey = "sessionKey" in body ? body.sessionKey : "sessionId" in body ? body.sessionId : undefined;
			if (typeof sessionKey !== "string" || !("harness" in body) || typeof body.harness !== "string")
				throw new TypeError("Staged session-end requires harness and session identity");
			const base = "/api/hooks/session-end/uploads";
			let declaration: unknown;
			try {
				declaration =
					state.uploadId === null
						? await remote.request("POST", base, {
								body: {
									sessionKey,
									...("agentId" in body ? { agentId: body.agentId } : {}),
									harness: body.harness,
									totalBytes: state.totalBytes,
									sha256: state.sha256,
								},
								signal,
							})
						: await remote.request("GET", `${base}/${state.uploadId}`, { signal });
			} catch (error) {
				if (typeof error === "object" && error !== null && "status" in error && error.status === 404)
					throw new SignetError(
						"Upload unavailable; original transcript retained in outbox",
						"transcript_upload_unavailable",
					);
				throw error;
			}
			const current = progress(declaration, state.totalBytes);
			if (state.uploadId !== null && current.uploadId !== state.uploadId) throw new Error("Upload identity changed");
			state = { ...state, uploadId: current.uploadId, receivedBytes: current.receivedBytes };
			await remote.checkpoint(state);
			while (state.receivedBytes < state.totalBytes) {
				signal?.throwIfAborted();
				const block = Buffer.alloc(Math.min(current.chunkBytes, state.totalBytes - state.receivedBytes));
				let filled = 0;
				while (filled < block.length) {
					const { bytesRead } = await handle.read(block, filled, block.length - filled, state.receivedBytes + filled);
					if (!bytesRead) throw new Error("Transcript changed during upload");
					filled += bytesRead;
				}
				if ((await fileFingerprint(handle)) !== fingerprint)
					throw new SignetError("Transcript changed during upload", "transcript_source_changed");
				const reply = await remote.request("PATCH", `${base}/${state.uploadId}`, {
					rawBody: block,
					headers: {
						"upload-offset": String(state.receivedBytes),
						"upload-checksum": createHash("sha256").update(block).digest("hex"),
					},
					signal,
				});
				if (
					typeof reply !== "object" ||
					reply === null ||
					!("receivedBytes" in reply) ||
					typeof reply.receivedBytes !== "number" ||
					!Number.isSafeInteger(reply.receivedBytes) ||
					reply.receivedBytes < state.receivedBytes + block.length ||
					reply.receivedBytes > state.totalBytes
				)
					throw new Error("Invalid upload acknowledgement");
				state = { ...state, receivedBytes: reply.receivedBytes };
				await remote.checkpoint(state);
			}
			const payload = Object.fromEntries(
				Object.entries(body).filter(([key]) => key !== "transcriptPath" && key !== "transcript"),
			);
			return { ...payload, transcriptUpload: { uploadId: state.uploadId } };
		}
		const buffer = Buffer.alloc(before.size);
		let offset = 0;
		while (offset < buffer.length) {
			signal?.throwIfAborted();
			const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
			if (bytesRead === 0) throw new Error("Transcript changed during capture; retry session-end");
			offset += bytesRead;
		}
		const after = await handle.stat();
		if (after.size !== before.size || after.mtimeMs !== before.mtimeMs)
			throw new Error("Transcript changed during capture; retry session-end");
		const { transcriptPath: _path, ...payload } = body;
		return { ...payload, transcript: buffer.toString("utf8") };
	} finally {
		await handle.close();
	}
}
