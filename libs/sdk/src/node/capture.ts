import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { SignetError } from "../errors.js";

export async function captureRemoteSessionEnd(body: unknown, signal?: AbortSignal): Promise<unknown> {
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
		if (before.size > 4 * 1024 * 1024)
			throw new SignetError(
				"Transcript exceeds 4 MiB inline capture limit; file reference retained in outbox for chunked-upload retry",
				"transcript_capture_deferred",
			);
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
