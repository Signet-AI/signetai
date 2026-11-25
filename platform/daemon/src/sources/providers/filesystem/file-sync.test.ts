import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileIfChanged, writeFileIfChangedAsync } from "./file-sync";

describe("writeFileIfChanged", () => {
	it("skips writing when content is unchanged", () => {
		const dir = mkdtempSync(join(tmpdir(), "signet-file-sync-"));
		try {
			const path = join(dir, "workspace", "AGENTS.md");
			mkdirSync(join(dir, "workspace"), { recursive: true });

			expect(writeFileIfChanged(path, "alpha")).toBe(true);
			const firstMtimeMs = statSync(path).mtimeMs;

			expect(writeFileIfChanged(path, "alpha")).toBe(false);
			const secondMtimeMs = statSync(path).mtimeMs;

			expect(secondMtimeMs).toBe(firstMtimeMs);
			expect(readFileSync(path, "utf-8")).toBe("alpha");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("writes when content changes", () => {
		const dir = mkdtempSync(join(tmpdir(), "signet-file-sync-"));
		try {
			const path = join(dir, "workspace", "AGENTS.md");
			mkdirSync(join(dir, "workspace"), { recursive: true });

			expect(writeFileIfChanged(path, "alpha")).toBe(true);
			expect(writeFileIfChanged(path, "beta")).toBe(true);
			expect(readFileSync(path, "utf-8")).toBe("beta");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("writeFileIfChangedAsync", () => {
	it("skips writing when content is unchanged", async () => {
		const dir = mkdtempSync(join(tmpdir(), "signet-file-sync-"));
		try {
			const path = join(dir, "workspace", "AGENTS.md");
			mkdirSync(join(dir, "workspace"), { recursive: true });

			expect(await writeFileIfChangedAsync(path, "alpha")).toBe(true);
			const firstMtimeMs = statSync(path).mtimeMs;

			expect(await writeFileIfChangedAsync(path, "alpha")).toBe(false);
			const secondMtimeMs = statSync(path).mtimeMs;

			expect(secondMtimeMs).toBe(firstMtimeMs);
			expect(readFileSync(path, "utf-8")).toBe("alpha");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("writes when content changes", async () => {
		const dir = mkdtempSync(join(tmpdir(), "signet-file-sync-"));
		try {
			const path = join(dir, "workspace", "AGENTS.md");
			mkdirSync(join(dir, "workspace"), { recursive: true });

			expect(await writeFileIfChangedAsync(path, "alpha")).toBe(true);
			expect(await writeFileIfChangedAsync(path, "beta")).toBe(true);
			expect(readFileSync(path, "utf-8")).toBe("beta");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
