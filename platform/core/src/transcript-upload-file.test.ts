import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withTranscriptFileSource } from "./transcript-upload-file";

const dirs: string[] = [];

function transcriptFile(content: string): string {
	const dir = mkdtempSync(join(tmpdir(), "signet-transcript-file-"));
	dirs.push(dir);
	const path = join(dir, "session.jsonl");
	writeFileSync(path, content);
	return path;
}

function text(value: Uint8Array): string {
	return new TextDecoder().decode(value);
}

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("reads the size and byte ranges of a transcript file", async () => {
	const path = transcriptFile('{"a":1}\n{"b":2}\n');
	const read = await withTranscriptFileSource(path, async (source) => ({
		size: source.size,
		head: text(await source.read(0, 8)),
		tail: text(await source.read(8, 16)),
		empty: text(await source.read(16, 16)),
	}));
	expect(read).toEqual({ size: 16, head: '{"a":1}\n', tail: '{"b":2}\n', empty: "" });
});

test("fails a read past the end of a file that shrank", async () => {
	const path = transcriptFile('{"a":1}\n{"b":2}\n');
	await expect(
		withTranscriptFileSource(path, async (source) => {
			truncateSync(path, 4);
			return await source.read(0, 16);
		}),
	).rejects.toThrow("file is shorter than the requested range: 4 of 16 bytes");
});

test("fails for a missing transcript file", async () => {
	const path = join(tmpdir(), `signet-missing-${process.pid}-${Date.now()}.jsonl`);
	await expect(withTranscriptFileSource(path, async (source) => source.size)).rejects.toMatchObject({ code: "ENOENT" });
});
