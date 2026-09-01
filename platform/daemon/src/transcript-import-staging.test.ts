import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stageTranscriptStream } from "./transcript-import-staging";

describe("managed transcript staging", () => {
	test("publishes only after streaming, fsync and atomic rename", async () => {
		const root = await mkdtemp(join(tmpdir(), "signet-stage-"));
		try {
			const result = await stageTranscriptStream(
				root,
				"source-1",
				(async function* () {
					yield new TextEncoder().encode("one\n");
					yield new TextEncoder().encode("two\n");
				})(),
			);
			expect(result.managedPath).toBe("imports/transcripts/source-1/source.jsonl");
			expect(result.sizeBytes).toBe(8);
			expect(await readFile(join(root, result.managedPath), "utf8")).toBe("one\ntwo\n");
			expect(await readdir(join(root, "imports/transcripts/source-1"))).toEqual(["source.jsonl"]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("removes a partial upload when the body stream fails", async () => {
		const root = await mkdtemp(join(tmpdir(), "signet-stage-failure-"));
		try {
			await expect(
				stageTranscriptStream(
					root,
					"source-2",
					(async function* () {
						yield new TextEncoder().encode("partial\n");
						throw new Error("body stream failed");
					})(),
				),
			).rejects.toThrow("body stream failed");
			expect(await readdir(join(root, "imports", "transcripts", "source-2"))).toEqual([]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
