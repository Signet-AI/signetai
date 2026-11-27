import { type FileHandle, open } from "node:fs/promises";
import type { TranscriptSource } from "./transcript-upload";

export async function readFileRange(
	handle: FileHandle,
	position: number,
	length: number,
): Promise<Uint8Array<ArrayBuffer>> {
	const bytes = new Uint8Array(length);
	let filled = 0;
	while (filled < length) {
		const { bytesRead } = await handle.read(bytes, filled, length - filled, position + filled);
		if (bytesRead === 0) throw new Error(`file is shorter than the requested range: ${filled} of ${length} bytes`);
		filled += bytesRead;
	}
	return bytes;
}

export async function withTranscriptFileSource<T>(
	path: string,
	use: (source: TranscriptSource) => Promise<T>,
): Promise<T> {
	const handle = await open(path, "r");
	try {
		const { size } = await handle.stat();
		return await use({ size, read: (start, end) => readFileRange(handle, start, end - start) });
	} finally {
		await handle.close();
	}
}
