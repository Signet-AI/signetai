import { createHash } from "node:crypto";
import { signetExportV1Adapter, TRANSCRIPT_IMPORT_LIMITS } from "./transcript-import-adapter";
import type { SignetExportRecord } from "./transcript-import-adapter";

export type InventoryStatus = "pending" | "rejected";
export interface InventoryRecord {
	readonly ordinal: number;
	readonly lineNumber: number;
	readonly byteOffset: number;
	readonly byteLength: number;
	readonly rawHash: string;
	readonly status: InventoryStatus;
	readonly value?: SignetExportRecord;
	readonly rejectionCode?: string;
}

export interface TranscriptCheckpoint {
	readonly byteOffset: number;
	readonly ordinal: number;
	readonly lineNumber: number;
}

/** One bounded batch per invocation; even an oversized line never accumulates in memory. */
export async function scanTranscriptBatch(
	read: (offset: number) => Promise<Uint8Array>,
	size: number,
	checkpoint: TranscriptCheckpoint,
): Promise<{
	readonly records: readonly InventoryRecord[];
	readonly checkpoint: TranscriptCheckpoint;
	readonly complete: boolean;
}> {
	let offset = checkpoint.byteOffset;
	let start = offset;
	let ordinal = checkpoint.ordinal;
	let lineNumber = checkpoint.lineNumber;
	let length = 0;
	let retained = 0;
	let parts: Uint8Array[] = [];
	let digest = createHash("sha256");
	const records: InventoryRecord[] = [];
	const finish = (newline: boolean): void => {
		lineNumber++;
		const rawHash = digest.digest("hex");
		const oversized = length > TRANSCRIPT_IMPORT_LIMITS.maxRecordBytes;
		const raw = oversized ? null : Buffer.concat(parts);
		if (raw !== null && /^\s*$/.test(raw.toString("utf8"))) return;
		ordinal++;
		const base = { ordinal, lineNumber, byteOffset: start, byteLength: length + (newline ? 1 : 0), rawHash };
		try {
			if (raw === null) throw new Error("oversized_record");
			const value = signetExportV1Adapter.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)));
			records.push({ ...base, status: "pending", value });
			retained += length;
		} catch (error) {
			records.push({
				...base,
				status: "rejected",
				rejectionCode:
					raw === null
						? "oversized_record"
						: error instanceof SyntaxError || error instanceof TypeError
							? "malformed"
							: "schema_invalid",
			});
		}
	};
	while (offset < size) {
		const bytes = await read(offset);
		if (!bytes.length || offset + bytes.length > size) throw new Error("source evidence truncated");
		let cursor = 0;
		while (cursor < bytes.length) {
			const found = bytes.indexOf(10, cursor);
			const end = found < 0 ? bytes.length : found;
			const part = bytes.subarray(cursor, end);
			digest.update(part);
			length += part.length;
			if (length <= TRANSCRIPT_IMPORT_LIMITS.maxRecordBytes) parts.push(Buffer.from(part));
			else parts = [];
			offset += part.length + (found < 0 ? 0 : 1);
			cursor = end + 1;
			if (found >= 0) {
				finish(true);
				start = offset;
				length = 0;
				parts = [];
				digest = createHash("sha256");
				if (
					records.length >= TRANSCRIPT_IMPORT_LIMITS.maxRecordsPerBatch ||
					retained >= TRANSCRIPT_IMPORT_LIMITS.maxCanonicalBatchBytes / 2 ||
					offset - checkpoint.byteOffset >= 1024 * 1024
				)
					return { records, checkpoint: { byteOffset: offset, ordinal, lineNumber }, complete: offset === size };
			}
		}
	}
	if (length) finish(false);
	return { records, checkpoint: { byteOffset: offset, ordinal, lineNumber }, complete: offset === size };
}
