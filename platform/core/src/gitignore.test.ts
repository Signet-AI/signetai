import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isSignetGitTrackedPath, mergeSignetGitignoreEntries } from "./gitignore";

describe("mergeSignetGitignoreEntries", () => {
	it("adds a lightweight workspace block to empty content", () => {
		const merged = mergeSignetGitignoreEntries("");

		expect(merged).toContain("# BEGIN Signet lightweight workspace");
		expect(merged).toContain("*\n!*/");
		expect(merged).toContain("!**/*.md");
		expect(merged).toContain("!**/*.jsonl");
		expect(merged).toContain("!skills/**");
		expect(merged).toContain("!tools/**");
		expect(merged).toContain("!dreaming/**");
		expect(merged).toContain("memory/memories.db*");
		expect(merged).toContain("data/");
		expect(merged).toContain("runtime/");
		expect(merged).toContain("cache/");
		expect(merged).toContain("files/");
		expect(merged).toContain(".secrets/");
		expect(merged).toContain("workspace-layout.json");
		expect(merged).toContain(".workspace-layout-upgrade.json");
		expect(merged).toContain("memory/backups/");
		expect(merged).toContain("*.db");
		expect(merged).toContain("signetai/");
		expect(merged).toContain("# END Signet lightweight workspace");
	});

	it("ignores v2 storage roots without ignoring same-named folders inside notes", () => {
		const root = mkdtempSync(join(tmpdir(), "signet-gitignore-"));
		try {
			writeFileSync(join(root, ".gitignore"), mergeSignetGitignoreEntries(""));
			const ignored = (path: string): boolean =>
				spawnSync("git", ["-C", root, "check-ignore", "-q", "--no-index", path]).status === 0;
			expect(spawnSync("git", ["-C", root, "init", "-q"]).status).toBe(0);
			for (const path of ["data/legacy-memory/notes.md", "runtime/telemetry/events.json", "cache/index.json"])
				expect(ignored(path)).toBe(true);
			for (const path of ["memory/research/data/notes.md", "skills/web/data/schema.json", "tools/t/runtime/r.md"])
				expect(ignored(path)).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("preserves existing content and appends the managed block last", () => {
		const existing = ["# Existing", ".venv/", "", "!/memory/**", ""].join("\n");
		const merged = mergeSignetGitignoreEntries(existing);

		expect(merged.startsWith("# Existing\n.venv/\n\n!/memory/**\n\n# BEGIN Signet lightweight workspace")).toBe(true);
		expect(merged.trimEnd().endsWith("# END Signet lightweight workspace")).toBe(true);
		expect(merged.indexOf("memory/memories.db*")).toBeGreaterThan(merged.indexOf("!/memory/**"));
	});

	it("replaces an older managed block instead of appending duplicates", () => {
		const once = mergeSignetGitignoreEntries("# Existing\n");
		const twice = mergeSignetGitignoreEntries(once);

		expect(twice).toBe(once);
		expect(twice.match(/# BEGIN Signet lightweight workspace/g)?.length).toBe(1);
	});

	it("normalizes CRLF content while preserving non-managed rules", () => {
		const merged = mergeSignetGitignoreEntries("# Existing\r\n.venv/\r\n");

		expect(merged.startsWith("# Existing\r\n.venv/\r\n\r\n# BEGIN Signet lightweight workspace")).toBe(true);
	});

	it("allows the managed gitignore but rejects database backups", () => {
		expect(isSignetGitTrackedPath(".gitignore")).toBe(true);
		expect(isSignetGitTrackedPath(".sigignore")).toBe(true);
		expect(isSignetGitTrackedPath("AGENTS.md")).toBe(true);
		expect(isSignetGitTrackedPath("memory/session.jsonl")).toBe(true);
		expect(isSignetGitTrackedPath("memory/memories.db.bak-v1-1")).toBe(false);
		expect(isSignetGitTrackedPath("memory/backups/old.db")).toBe(false);
		expect(isSignetGitTrackedPath("node_modules/package.json")).toBe(false);
		expect(isSignetGitTrackedPath("app/node_modules/package.json")).toBe(false);
	});
});

describe("workspace layout upgrade record", () => {
	it("is never tracked by workspace git sync", () => {
		expect(isSignetGitTrackedPath(".workspace-layout-upgrade.json")).toBe(false);
	});
});
