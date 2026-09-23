import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { captureGitMetadata, restoreGitMetadata } from "./git-migration";

describe("migration Git metadata", () => {
	test("preserves root and nested repository metadata without mutating source", () => {
		const source = mkdtempSync(join(import.meta.dir, "git-migration-source-"));
		const destination = mkdtempSync(join(import.meta.dir, "git-migration-dest-"));
		mkdirSync(join(source, ".git", "refs", "remotes"), { recursive: true });
		mkdirSync(join(source, "skills", "one", ".git", "hooks"), { recursive: true });
		writeFileSync(join(source, ".git", "HEAD"), "ref: refs/heads/main\n");
		writeFileSync(join(source, ".git", "config"), "[core]\n\trepositoryformatversion = 0\n");
		writeFileSync(join(source, "skills", "one", ".git", "HEAD"), "ref: refs/heads/main\n");
		const before = readFileSync(join(source, ".git", "config"));
		const capture = captureGitMetadata(source, join(source, ".state"));
		restoreGitMetadata(capture, destination);
		expect(readFileSync(join(destination, ".git", "config"))).toEqual(before);
		expect(readFileSync(join(destination, "skills", "one", ".git", "HEAD"))).toEqual(
			readFileSync(join(source, "skills", "one", ".git", "HEAD")),
		);
		expect(readFileSync(join(source, ".git", "config"))).toEqual(before);
	});
});
