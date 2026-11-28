import { expect, test } from "bun:test";
import { DbOwnerLineBuffer } from "./db-owner-line-buffer";

test("DB owner framing bounds fragmented and complete frames in UTF-8 bytes", () => {
	for (const terminated of [false, true]) {
		const buffer = new DbOwnerLineBuffer(8);
		expect(buffer.read("ΣΣ")).toEqual([]);
		expect(() => buffer.read(`ΣΣx${terminated ? "\n" : ""}`)).toThrow(
			expect.objectContaining({ code: "DB_OWNER_FRAME_TOO_LARGE" }),
		);
		expect(buffer.read("ready\n")).toEqual(["ready"]);
	}
});

test("DB owner framing preserves split records, empty lines and Unicode", () => {
	const buffer = new DbOwnerLineBuffer();
	expect(buffer.read('{"text":"')).toEqual([]);
	expect(buffer.read('Σ"}\n\n{"next":')).toEqual(['{"text":"Σ"}', ""]);
	expect(buffer.read('true}\n{"tail":1}')).toEqual(['{"next":true}']);
	expect(buffer.read("\n")).toEqual(['{"tail":1}']);
	expect(buffer.read("")).toEqual([]);
});

test("DB owner framing discards an interrupted owner's partial record", () => {
	const buffer = new DbOwnerLineBuffer();
	expect(buffer.read('{"old":')).toEqual([]);
	buffer.reset();
	expect(buffer.read('{"type":"ready"}\n')).toEqual(['{"type":"ready"}']);
});

test("DB owner framing receives a staged capture payload within its existing admission budget", () => {
	const buffer = new DbOwnerLineBuffer();
	const transcript = "x".repeat(10 * 1024 * 1024);
	const frame = JSON.stringify({ transcript, rawTranscript: transcript });
	const records: string[] = [];
	const started = performance.now();
	for (let offset = 0; offset < frame.length; offset += 1024) {
		records.push(...buffer.read(frame.slice(offset, offset + 1024)));
	}
	records.push(...buffer.read("\n"));
	expect(records).toEqual([frame]);
	expect(performance.now() - started).toBeLessThan(2_000);
});
