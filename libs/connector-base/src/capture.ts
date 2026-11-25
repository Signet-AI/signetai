import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isJsonObject } from "./config";

export async function captureRemoteSessionEnd(body: unknown): Promise<unknown> {
	if (!isJsonObject(body) || typeof body.transcriptPath !== "string" || !body.transcriptPath) return body;
	const handle = await open(body.transcriptPath, constants.O_RDONLY | constants.O_NONBLOCK);
	try {
		const before = await handle.stat();
		if (!before.isFile() || before.size > 4 * 1024 * 1024)
			throw new Error(
				"Remote transcript capture requires a regular file of at most 4 MiB; original evidence was not removed",
			);
		const buffer = Buffer.alloc(before.size);
		let offset = 0;
		while (offset < buffer.length) {
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
