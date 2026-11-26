import { afterEach, describe, expect, it } from "bun:test";
import { constants, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openContainedTranscriptFile, removeContainedTranscriptPath } from "./transcript-import-safe-fs";

const roots: string[] = [];

function makeRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "signet-safe-fs-"));
	roots.push(root);
	mkdirSync(join(root, "dir"));
	return root;
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("contained transcript files", () => {
	it("creates a missing file with the requested mode and opens an existing one", async () => {
		const root = makeRoot();
		const path = join(root, "dir", "new.jsonl");
		const created = await openContainedTranscriptFile(root, path, constants.O_RDWR | constants.O_CREAT, 0o600);
		await created.write("one\n");
		await created.close();
		expect(statSync(path).mode & 0o777).toBe(0o600);

		const reopened = await openContainedTranscriptFile(root, path, constants.O_RDWR | constants.O_CREAT, 0o600);
		await reopened.write("two\n", 4);
		await reopened.close();
		expect(Bun.file(path).size).toBe(8);
	});

	it("removes an empty directory and keeps a non-empty one", async () => {
		const root = makeRoot();
		const full = join(root, "dir", "full");
		mkdirSync(full);
		writeFileSync(join(full, "keep.jsonl"), "x\n");

		await expect(removeContainedTranscriptPath(root, full, { directory: true })).rejects.toThrow();
		expect(existsSync(join(full, "keep.jsonl"))).toBe(true);

		await removeContainedTranscriptPath(root, join(full, "keep.jsonl"), { force: true });
		await removeContainedTranscriptPath(root, full, { directory: true });
		expect(existsSync(full)).toBe(false);
		await removeContainedTranscriptPath(root, full, { directory: true, force: true });
	});
});
