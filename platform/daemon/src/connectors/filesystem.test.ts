import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverFiles, matchConnectorPattern, matchGlob, readFileContent } from "./filesystem";

describe("globToRegex", () => {
	test("**/*.md matches root-level files", () => {
		expect(matchGlob("**/*.md", "AGENTS.md")).toBe(true);
		expect(matchGlob("**/*.md", "README.md")).toBe(true);
		expect(matchGlob("**/*.md", "notes.md")).toBe(true);
	});

	test("**/*.md matches nested files", () => {
		expect(matchGlob("**/*.md", "sub/file.md")).toBe(true);
		expect(matchGlob("**/*.md", "a/b/c/deep.md")).toBe(true);
	});

	test("**/*.txt matches by extension", () => {
		expect(matchGlob("**/*.txt", "file.txt")).toBe(true);
		expect(matchGlob("**/*.txt", "docs/notes.txt")).toBe(true);
		expect(matchGlob("**/*.txt", "file.md")).toBe(false);
	});

	test("*.md only matches root-level files", () => {
		expect(matchGlob("*.md", "AGENTS.md")).toBe(true);
		expect(matchGlob("*.md", "sub/file.md")).toBe(false);
		expect(matchGlob("*.md", "a/b/c.md")).toBe(false);
	});

	test("dotfiles match when explicitly in pattern", () => {
		expect(matchGlob("**/*.md", ".agents/SOUL.md")).toBe(true);
		expect(matchGlob("**/*.md", ".github/CONTRIBUTING.md")).toBe(true);
	});

	test("connector matching only includes dot paths for explicit dot patterns", () => {
		expect(matchConnectorPattern("**/*.md", ".agents/SOUL.md")).toBe(false);
		expect(matchConnectorPattern("**/*.md", ".github/CONTRIBUTING.md")).toBe(false);
		expect(matchConnectorPattern(".github/*.md", ".github/CONTRIBUTING.md")).toBe(true);
		expect(matchConnectorPattern("docs/.private/*.md", "docs/.private/notes.md")).toBe(true);
	});

	test("filesystem discovery descends into explicitly included dot directories", async () => {
		const root = mkdtempSync(join(tmpdir(), "signet-fs-connector-"));
		try {
			mkdirSync(join(root, ".github"), { recursive: true });
			mkdirSync(join(root, "docs", ".private"), { recursive: true });
			mkdirSync(join(root, ".agents"), { recursive: true });
			writeFileSync(join(root, ".github", "CONTRIBUTING.md"), "github");
			writeFileSync(join(root, "docs", ".private", "notes.md"), "private");
			writeFileSync(join(root, ".agents", "SOUL.md"), "agent");
			writeFileSync(join(root, "README.md"), "readme");

			const files = await discoverFiles({
				rootPath: root,
				patterns: [".github/*.md", "docs/.private/*.md"],
				ignorePatterns: [],
				maxFileSize: 1_048_576,
			});

			expect(files.map((file) => file.relativePath).sort()).toEqual([
				".github/CONTRIBUTING.md",
				"docs/.private/notes.md",
			]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("filesystem discovery keeps basename globs at connector root", async () => {
		const root = mkdtempSync(join(tmpdir(), "signet-fs-connector-"));
		try {
			mkdirSync(join(root, "sub"), { recursive: true });
			mkdirSync(join(root, "a", "b"), { recursive: true });
			writeFileSync(join(root, "README.md"), "root");
			writeFileSync(join(root, "sub", "file.md"), "nested");
			writeFileSync(join(root, "a", "b", "deep.md"), "deep");
			writeFileSync(join(root, "notes.txt"), "text");

			const files = await discoverFiles({
				rootPath: root,
				patterns: ["*.md"],
				ignorePatterns: [],
				maxFileSize: 1_048_576,
			});

			expect(files.map((file) => file.relativePath).sort()).toEqual(["README.md"]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("filesystem discovery reports oversized files without reading their contents", async () => {
		const root = mkdtempSync(join(tmpdir(), "signet-fs-connector-"));
		try {
			const path = join(root, "large.md");
			writeFileSync(path, Buffer.alloc(32, "x"));

			const files = await discoverFiles({
				rootPath: root,
				patterns: ["**/*.md"],
				ignorePatterns: [],
				maxFileSize: 16,
			});

			expect(files).toHaveLength(1);
			const file = files[0];
			expect(file?.size).toBe(32);
			if (!file) throw new Error("expected oversized file metadata");
			expect(await readFileContent(file, 16)).toBeNull();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("filesystem reads tiny files with huge configured size caps", async () => {
		const root = mkdtempSync(join(tmpdir(), "signet-fs-connector-"));
		try {
			const path = join(root, "tiny.md");
			writeFileSync(path, "tiny");

			const files = await discoverFiles({
				rootPath: root,
				patterns: ["**/*.md"],
				ignorePatterns: [],
				maxFileSize: Number.MAX_SAFE_INTEGER,
			});

			expect(files).toHaveLength(1);
			const file = files[0];
			if (!file) throw new Error("expected tiny file metadata");
			expect(await readFileContent(file, Number.MAX_SAFE_INTEGER)).toBe("tiny");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("filesystem discovery yields to the event loop during a deep and wide traversal", async () => {
		const root = mkdtempSync(join(tmpdir(), "signet-fs-connector-responsive-"));
		let timer: ReturnType<typeof setInterval> | undefined;
		try {
			for (let depth = 0; depth < 12; depth += 1) {
				const directory = join(root, ...Array.from({ length: depth + 1 }, (_, index) => `d${index}`));
				mkdirSync(directory, { recursive: true });
				for (let index = 0; index < 20; index += 1) writeFileSync(join(directory, `file-${index}.md`), "content");
			}

			let ticks = 0;
			timer = setInterval(() => {
				ticks += 1;
			}, 1);
			const files = await discoverFiles({
				rootPath: root,
				patterns: ["**/*.md"],
				ignorePatterns: [],
				maxFileSize: 1_048_576,
			});

			expect(files.length).toBe(240);
			expect(ticks).toBeGreaterThan(0);
		} finally {
			if (timer !== undefined) clearInterval(timer);
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("filesystem discovery supports bounded pages and abortable traversal", async () => {
		const root = mkdtempSync(join(tmpdir(), "signet-fs-connector-page-"));
		try {
			for (let index = 0; index < 8; index += 1) writeFileSync(join(root, `file-${index}.md`), "content");
			const controller = new AbortController();
			controller.abort();
			await expect(
				discoverFiles(
					{ rootPath: root, patterns: ["**/*.md"], ignorePatterns: [], maxFileSize: 1_048_576 },
					{ maxResults: 2, signal: controller.signal },
				),
			).rejects.toThrow("aborted");

			const all = await discoverFiles({
				rootPath: root,
				patterns: ["**/*.md"],
				ignorePatterns: [],
				maxFileSize: 1_048_576,
			});
			const page = await discoverFiles(
				{ rootPath: root, patterns: ["**/*.md"], ignorePatterns: [], maxFileSize: 1_048_576 },
				{ maxResults: 3, skipResults: 2 },
			);
			expect(page).toHaveLength(3);
			expect(page.map((file) => file.relativePath).sort()).toEqual(
				all
					.slice(2, 5)
					.map((file) => file.relativePath)
					.sort(),
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("*.md does not match .env", () => {
		expect(matchGlob("**/*.md", ".env")).toBe(false);
	});

	test("exact path pattern only matches root", () => {
		expect(matchGlob("AGENTS.md", "AGENTS.md")).toBe(true);
		expect(matchGlob("AGENTS.md", "sub/AGENTS.md")).toBe(false);
	});
});
