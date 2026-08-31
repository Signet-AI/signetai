import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inventoryTranscriptFile } from "./transcript-import-inventory";

const line = (id: string) =>
	JSON.stringify({
		id,
		source: "signet",
		harness: "h",
		agent_id: "a",
		session_key: id,
		project: null,
		timestamp: "2026-01-01T00:00:00Z",
		message_count: 1,
		messages: [{ role: "user", content: ` ${id} ` }],
	});

describe("transcript import inventory invariants", () => {
	test("tracks CRLF, LF, final line, blanks and byte restart checkpoints", async () => {
		const dir = await mkdtemp(join(tmpdir(), "signet-import-"));
		const path = join(dir, "source.jsonl");
		await writeFile(path, `${line("one")}\r\n\n${line("two")}\nnot-json`);
		try {
			const batches: number[] = [];
			const result = await inventoryTranscriptFile(path, undefined, 25, async (batch) => batches.push(batch.length));
			expect(result.records).toHaveLength(3);
			expect(result.blankLines).toBe(1);
			expect(result.malformedLines).toBe(1);
			expect(result.complete).toBe(true);
			expect(result.nextByteOffset).toBe(Buffer.byteLength(await Bun.file(path).text()));
			expect(batches).toEqual([3]);
			const checkpoint = result.records[1];
			if (checkpoint == null) throw new Error("missing checkpoint record");
			const resumed = await inventoryTranscriptFile(path, { byteOffset: checkpoint.byteOffset, ordinal: 1 });
			expect(resumed.records[0]?.value?.id).toBe("two");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
