import { describe, expect, test } from "bun:test";
import { constants as fsConstants } from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openContainedTranscriptFile } from "./transcript-import-safe-fs";
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
	test("rejects symlinked workspace components without writing outside the root", async () => {
		const root = await mkdtemp(join(tmpdir(), "signet-stage-symlink-"));
		const outside = await mkdtemp(join(tmpdir(), "signet-stage-outside-"));
		try {
			await symlink(outside, join(root, "imports"));
			await expect(
				stageTranscriptStream(
					root,
					"source-escape",
					(async function* () {
						yield new TextEncoder().encode("must stay inside\n");
					})(),
				),
			).rejects.toThrow("symlink");
			expect(await readdir(outside)).toEqual([]);
		} finally {
			await rm(root, { recursive: true, force: true });
			await rm(outside, { recursive: true, force: true });
		}
	});

	test("keeps a held parent descriptor inside the root when a component is replaced", async () => {
		const root = await mkdtemp(join(tmpdir(), "signet-stage-race-"));
		const outside = await mkdtemp(join(tmpdir(), "signet-stage-race-outside-"));
		const candidate = join(root, "imports", "transcripts", "source-race", "source.jsonl");
		try {
			await stageTranscriptStream(
				root,
				"source-race",
				(async function* () {
					yield new TextEncoder().encode("inside\n");
				})(),
			);
			const outsidePath = join(outside, "transcripts", "source-race", "source.jsonl");
			await mkdir(join(outside, "transcripts", "source-race"), { recursive: true });
			await writeFile(outsidePath, "outside\n");

			const handle = await openContainedTranscriptFile(root, candidate, fsConstants.O_RDONLY, undefined, async () => {
				await rename(join(root, "imports"), join(root, "imports-held"));
				await symlink(outside, join(root, "imports"));
			});
			try {
				expect(await handle.readFile("utf8")).toBe("inside\n");
			} finally {
				await handle.close();
			}
		} finally {
			await rm(root, { recursive: true, force: true });
			await rm(outside, { recursive: true, force: true });
		}
	});
});
