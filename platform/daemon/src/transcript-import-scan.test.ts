import { expect, test } from "bun:test";
import { scanTranscriptBatch } from "./transcript-import-scan";
import { TRANSCRIPT_IMPORT_LIMITS } from "./transcript-import-adapter";

test("checkpoints exact byte offsets and line numbers across small UTF-8 chunks", async () => {
	const record = JSON.stringify({
		source: "signet",
		id: "id",
		harness: "h",
		agent_id: "a",
		session_key: "s",
		project: null,
		timestamp: "2024-01-01",
		message_count: 1,
		messages: [{ role: "user", content: "🌍\n  exact" }],
	});
	const bytes = Buffer.from(`\r\n${record}\r\nbad\n${record}`);
	const result = await scanTranscriptBatch(async (offset) => bytes.subarray(offset, offset + 7), bytes.length, {
		byteOffset: 0,
		ordinal: 0,
		lineNumber: 0,
	});
	expect(result.records.map((row) => [row.lineNumber, row.status])).toEqual([
		[2, "pending"],
		[3, "rejected"],
		[4, "pending"],
	]);
	expect(result.checkpoint).toEqual({ byteOffset: bytes.length, ordinal: 3, lineNumber: 4 });
	expect(result.records[0]?.value?.messages[0]?.content).toBe("🌍\n  exact");
});

test("rejects an oversized line while retaining only bounded chunks and resumes after a batch", async () => {
	const size = TRANSCRIPT_IMPORT_LIMITS.maxRecordBytes + 100;
	const block = Buffer.alloc(64 * 1024, 120);
	let reads = 0;
	const result = await scanTranscriptBatch(
		async (offset) => {
			reads++;
			return block.subarray(0, Math.min(block.length, size - offset));
		},
		size,
		{ byteOffset: 0, ordinal: 0, lineNumber: 0 },
	);
	expect(reads).toBeGreaterThan(256);
	expect(result.records).toMatchObject([{ status: "rejected", rejectionCode: "oversized_record", byteLength: size }]);
	const many = Buffer.from("bad\n".repeat(60));
	const first = await scanTranscriptBatch(async (offset) => many.subarray(offset), many.length, {
		byteOffset: 0,
		ordinal: 0,
		lineNumber: 0,
	});
	expect(first.records.length).toBe(25);
	expect(first.complete).toBe(false);
	const second = await scanTranscriptBatch(async (offset) => many.subarray(offset), many.length, first.checkpoint);
	expect(second.records[0]?.ordinal).toBe(26);
});
