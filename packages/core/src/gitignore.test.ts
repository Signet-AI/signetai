import { describe, expect, it } from "bun:test";
import { SIGNET_GIT_PROTECTED_PATHS, mergeSignetGitignoreEntries } from "./gitignore";

describe("mergeSignetGitignoreEntries", () => {
	it("adds the protected database entries to empty content", () => {
		expect(mergeSignetGitignoreEntries("")).toBe(
			["# Signet generated data", ...SIGNET_GIT_PROTECTED_PATHS, ""].join("\n"),
		);
	});

	it("preserves existing content and appends only missing entries", () => {
		const existing = ["# Existing", ".venv/", "", "memory/memories.db-wal", ""].join("\n");

		expect(mergeSignetGitignoreEntries(existing)).toBe(
			[
				"# Existing",
				".venv/",
				"",
				"memory/memories.db-wal",
				"",
				"# Signet generated data",
				"memory/memories.db",
				"memory/memories.db-shm",
				"memory/memories.db-journal",
				"signetai/",
				"",
			].join("\n"),
		);
	});

	it("is idempotent when all entries are already present", () => {
		const existing = ["# Signet generated data", ...SIGNET_GIT_PROTECTED_PATHS, ""].join("\n");

		expect(mergeSignetGitignoreEntries(existing)).toBe(existing);
	});

	it("preserves CRLF content when no entries are missing", () => {
		const existing = ["# Signet generated data", ...SIGNET_GIT_PROTECTED_PATHS, ""].join("\r\n");

		expect(mergeSignetGitignoreEntries(existing)).toBe(existing);
	});
});
