export const MAX_INLINE_TRANSCRIPT_BYTES = 4 * 1024 * 1024;
export const MAX_TRANSCRIPT_UPLOAD_BYTES = 1024 * 1024;
export const TRANSCRIPT_UPLOAD_TAIL_BYTES = 64 * 1024;

export interface TranscriptUploadStatus {
	readonly committedOffset: number;
	readonly generation: number | null;
	readonly tailSha256: string | null;
}

export interface TranscriptUploadStart {
	readonly generation: number;
	readonly offset: number;
}

export interface TranscriptUploadRange {
	readonly start: number;
	readonly end: number;
}

export function transcriptUploadTailStart(end: number): number {
	return Math.max(0, end - TRANSCRIPT_UPLOAD_TAIL_BYTES);
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes)));
	return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function transcriptUploadEnd(bytes: Uint8Array): number {
	return bytes.lastIndexOf(0x0a) + 1;
}

export function transcriptUploadRanges(offset: number, end: number): readonly TranscriptUploadRange[] {
	const ranges: TranscriptUploadRange[] = [];
	for (let start = offset; start < end; start += MAX_TRANSCRIPT_UPLOAD_BYTES) {
		ranges.push({ start, end: Math.min(end, start + MAX_TRANSCRIPT_UPLOAD_BYTES) });
	}
	return ranges;
}

export async function transcriptUploadStart(
	state: TranscriptUploadStatus,
	bytes: Uint8Array,
): Promise<TranscriptUploadStart> {
	if (state.generation === null) return { generation: 0, offset: 0 };
	const offset = state.committedOffset;
	if (offset <= transcriptUploadEnd(bytes)) {
		const tail = bytes.subarray(transcriptUploadTailStart(offset), offset);
		if ((await sha256Hex(tail)) === state.tailSha256) return { generation: state.generation, offset };
	}
	return { generation: state.generation + 1, offset: 0 };
}
