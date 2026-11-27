import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	MAX_INLINE_TRANSCRIPT_BYTES,
	MAX_TRANSCRIPT_UPLOAD_BYTES,
	TRANSCRIPT_UPLOAD_TAIL_BYTES,
	sha256Hex,
	transcriptUploadEnd,
	transcriptUploadRanges,
	transcriptUploadStart,
} from "./transcript-upload";

function bytes(value: string): Uint8Array {
	return new TextEncoder().encode(value);
}

function sha(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

test("uses 4 MiB inline, 1 MiB ranges and a 64 KiB tail", () => {
	expect(MAX_INLINE_TRANSCRIPT_BYTES).toBe(4194304);
	expect(MAX_TRANSCRIPT_UPLOAD_BYTES).toBe(1048576);
	expect(TRANSCRIPT_UPLOAD_TAIL_BYTES).toBe(65536);
});

test("hashes bytes as lowercase hex SHA-256", async () => {
	expect(await sha256Hex(bytes("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
	expect(await sha256Hex(bytes(""))).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
});

test("ends the upload after the last newline", () => {
	expect(transcriptUploadEnd(bytes('{"a":1}\n{"b"'))).toBe(8);
	expect(transcriptUploadEnd(bytes('{"a":1}\n'))).toBe(8);
	expect(transcriptUploadEnd(bytes('{"a":1}\n{"b":2}\n'))).toBe(16);
	expect(transcriptUploadEnd(bytes("no newline"))).toBe(0);
	expect(transcriptUploadEnd(bytes(""))).toBe(0);
});

test("splits an upload into ranges of at most 1 MiB", () => {
	expect(transcriptUploadRanges(0, 0)).toEqual([]);
	expect(transcriptUploadRanges(8, 8)).toEqual([]);
	expect(transcriptUploadRanges(9, 8)).toEqual([]);
	expect(transcriptUploadRanges(0, 10)).toEqual([{ start: 0, end: 10 }]);
	expect(transcriptUploadRanges(100, 1048676)).toEqual([{ start: 100, end: 1048676 }]);
	expect(transcriptUploadRanges(100, 1048677)).toEqual([
		{ start: 100, end: 1048676 },
		{ start: 1048676, end: 1048677 },
	]);
	expect(transcriptUploadRanges(0, 2097157)).toEqual([
		{ start: 0, end: 1048576 },
		{ start: 1048576, end: 2097152 },
		{ start: 2097152, end: 2097157 },
	]);
});

test("starts a first upload at generation 0", async () => {
	const state = { committedOffset: 0, generation: null, tailSha256: null };
	const result = await transcriptUploadStart(state, bytes('{"a":1}\n'));
	expect(result).toEqual({ generation: 0, offset: 0 });
});

test("resumes when the committed tail still matches", async () => {
	const bytesValue = bytes('{"a":1}\n{"b":2}\n');
	const tailHash = sha('{"a":1}\n');
	const state = { committedOffset: 8, generation: 3, tailSha256: tailHash };
	const result = await transcriptUploadStart(state, bytesValue);
	expect(result).toEqual({ generation: 3, offset: 8 });
});

test("restarts with the next generation when the committed tail changed", async () => {
	const bytesValue = bytes('{"a":1}\n{"b":2}\n');
	const tailHash = sha('{"z":9}\n');
	const state = { committedOffset: 8, generation: 3, tailSha256: tailHash };
	const result = await transcriptUploadStart(state, bytesValue);
	expect(result).toEqual({ generation: 4, offset: 0 });
});

test("restarts when the committed offset passes the last newline", async () => {
	const bytesValue1 = bytes('{"a":1}\n{"b"');
	const tailHash1 = sha('{"a":1}\n{"b"');
	const state1 = { committedOffset: 12, generation: 3, tailSha256: tailHash1 };
	const result1 = await transcriptUploadStart(state1, bytesValue1);
	expect(result1).toEqual({ generation: 4, offset: 0 });

	const bytesValue2 = bytes('{"a":1}\n');
	const tailHash2 = sha('{"a":1}\n');
	const state2 = { committedOffset: 20, generation: 3, tailSha256: tailHash2 };
	const result2 = await transcriptUploadStart(state2, bytesValue2);
	expect(result2).toEqual({ generation: 4, offset: 0 });
});

test("compares only the last 64 KiB before the committed offset", async () => {
	const bytesValue = bytes("x".repeat(199999) + "\n");
	const tailHash1 = sha("x".repeat(65536));
	const state1 = { committedOffset: 150000, generation: 1, tailSha256: tailHash1 };
	const result1 = await transcriptUploadStart(state1, bytesValue);
	expect(result1).toEqual({ generation: 1, offset: 150000 });

	const tailHash2 = sha("x".repeat(150000));
	const state2 = { committedOffset: 150000, generation: 1, tailSha256: tailHash2 };
	const result2 = await transcriptUploadStart(state2, bytesValue);
	expect(result2).toEqual({ generation: 2, offset: 0 });
});
