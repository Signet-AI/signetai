import { constants as fsConstants } from "node:fs";
import { open } from "node:fs/promises";
import { TRANSCRIPT_IMPORT_LIMITS, signetExportV1Adapter, type SignetExportRecord } from "./transcript-import-adapter";
import { assertTranscriptImportPlatformSupported, openContainedTranscriptFile } from "./transcript-import-safe-fs";

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
export interface InventoryResult {
	readonly records: readonly InventoryRecord[];
	readonly blankLines: number;
	readonly malformedLines: number;
	readonly nextByteOffset: number;
	readonly nextOrdinal: number;
	readonly bytes: number;
	readonly complete: boolean;
}

/** Scan JSONL incrementally. checkpoint is a durable byte/ordinal pair, never a line number. */
export async function inventoryTranscriptFile(
	path: string,
	checkpoint: { readonly byteOffset: number; readonly ordinal: number } = { byteOffset: 0, ordinal: 0 },
	batchSize = TRANSCRIPT_IMPORT_LIMITS.maxRecordsPerBatch,
	onBatch?: (records: readonly InventoryRecord[], checkpoint: { byteOffset: number; ordinal: number }) => Promise<void>,
	workspaceRoot?: string,
): Promise<InventoryResult> {
	assertTranscriptImportPlatformSupported();
	if (batchSize < 1 || batchSize > TRANSCRIPT_IMPORT_LIMITS.maxRecordsPerBatch)
		throw new Error("batchSize exceeds bounded import limit");
	const handle =
		workspaceRoot === undefined
			? await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
			: await openContainedTranscriptFile(workspaceRoot, path, fsConstants.O_RDONLY);
	const records: InventoryRecord[] = [];
	let buffer = Buffer.alloc(0);
	let offset = checkpoint.byteOffset;
	let ordinal = checkpoint.ordinal;
	let lineNumber = checkpoint.ordinal;
	let blankLines = 0;
	let malformedLines = 0;
	let eof = false;
	let batch: InventoryRecord[] = [];
	const decoder = new TextDecoder("utf-8", { fatal: true });
	try {
		const info = await handle.stat();
		if (checkpoint.byteOffset > info.size) throw new Error("checkpoint is beyond file size");
		while (!eof) {
			const chunk = Buffer.allocUnsafe(64 * 1024);
			const read = await handle.read(chunk, 0, chunk.length, offset + buffer.length);
			eof = read.bytesRead === 0;
			if (read.bytesRead > 0) buffer = Buffer.concat([buffer, chunk.subarray(0, read.bytesRead)]);
			let newline = buffer.indexOf(0x0a);
			while (newline >= 0) {
				const raw = buffer.subarray(0, newline);
				buffer = buffer.subarray(newline + 1);
				const start = offset;
				offset += newline + 1;
				lineNumber++;
				const line = raw.length > 0 && raw[raw.length - 1] === 0x0d ? raw.subarray(0, raw.length - 1) : raw;
				if (line.length === 0 || /^\s*$/.test(line.toString("utf8"))) {
					blankLines++;
					newline = buffer.indexOf(0x0a);
					continue;
				}
				ordinal++;
				const rawHash = await sha256(raw);
				let item: InventoryRecord;
				try {
					if (raw.length > TRANSCRIPT_IMPORT_LIMITS.maxRecordBytes) throw new Error("oversized_record");
					const value = signetExportV1Adapter.parse(JSON.parse(decoder.decode(line)));
					item = { ordinal, lineNumber, byteOffset: start, byteLength: newline + 1, rawHash, status: "pending", value };
				} catch (error) {
					malformedLines++;
					item = {
						ordinal,
						lineNumber,
						byteOffset: start,
						byteLength: newline + 1,
						rawHash,
						status: "rejected",
						rejectionCode: error instanceof Error ? error.message : "malformed_record",
					};
				}
				records.push(item);
				batch.push(item);
				if (batch.length === batchSize) {
					await onBatch?.(batch, { byteOffset: offset, ordinal });
					batch = [];
				}
				newline = buffer.indexOf(0x0a);
			}
			if (eof && buffer.length > 0) {
				const raw = buffer;
				buffer = Buffer.alloc(0);
				const start = offset;
				offset += raw.length;
				lineNumber++;
				if (!/^\s*$/.test(raw.toString("utf8"))) {
					ordinal++;
					const rawHash = await sha256(raw);
					let item: InventoryRecord;
					try {
						if (raw.length > TRANSCRIPT_IMPORT_LIMITS.maxRecordBytes) throw new Error("oversized_record");
						const value = signetExportV1Adapter.parse(JSON.parse(decoder.decode(raw)));
						item = {
							ordinal,
							lineNumber,
							byteOffset: start,
							byteLength: raw.length,
							rawHash,
							status: "pending",
							value,
						};
					} catch (error) {
						malformedLines++;
						item = {
							ordinal,
							lineNumber,
							byteOffset: start,
							byteLength: raw.length,
							rawHash,
							status: "rejected",
							rejectionCode: error instanceof Error ? error.message : "malformed_record",
						};
					}
					records.push(item);
					batch.push(item);
				} else blankLines++;
			}
		}
		if (batch.length) await onBatch?.(batch, { byteOffset: offset, ordinal });
		const finalInfo = await handle.stat();
		return {
			records,
			blankLines,
			malformedLines,
			nextByteOffset: offset,
			nextOrdinal: ordinal,
			bytes: finalInfo.size,
			complete: offset === finalInfo.size,
		};
	} finally {
		await handle.close();
	}
}
async function sha256(value: Uint8Array): Promise<string> {
	const { createHash } = await import("node:crypto");
	return createHash("sha256").update(value).digest("hex");
}
