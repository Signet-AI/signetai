import { describe, expect, it, mock } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Every native-memory read fails with EDEADLK (the iCloud-dataless / locked
// sync-file signature) so the regression exercises the skip + consolidated
// warning path without touching a real evicted vault.
let readAttempts = 0;
mock.module("node:fs/promises", () => ({
	lstat: async () => ({ isSymbolicLink: () => false }),
	stat: async () => ({ isFile: () => true, mtimeMs: Date.now() }),
	readdir: async () => [],
	readFile: async () => {
		readAttempts++;
		throw Object.assign(new Error("EDEADLK: resource deadlock avoided"), { code: "EDEADLK" });
	},
}));

import { initDbAccessor } from "./db-accessor";
import { logger } from "./logger";
import { indexNativeMemoryFile, isDatalessReadError, obsidianNativeMemorySource } from "./native-memory-sources";

describe("dataless / EDEADLK native artifact reads (#1161)", () => {
	it("classifies dataless read errors", () => {
		expect(isDatalessReadError("EDEADLK: resource deadlock avoided")).toBe(true);
		expect(isDatalessReadError("read error EIO on iosurface")).toBe(true);
		expect(isDatalessReadError("EACCES: permission denied")).toBe(false);
		expect(isDatalessReadError("ENOENT: no such file")).toBe(false);
		// The errno code is authoritative, and an ordinary failure on a path
		// containing "eio" must not be misclassified as dataless (#1161).
		expect(
			isDatalessReadError(
				Object.assign(new Error("EACCES: permission denied, open '/vault/veio/note.md'"), { code: "EACCES" }),
			),
		).toBe(false);
		expect(isDatalessReadError(Object.assign(new Error("deadlock"), { code: "EDEADLK" }))).toBe(true);
	});

	it("backs off after an EDEADLK read and logs one consolidated warning for the batch", async () => {
		const dir = mkdtempSync(join(tmpdir(), "signet-dataless-"));
		writeFileSync(join(dir, "agent.yaml"), "name: DatalessTest\n");
		process.env.SIGNET_PATH = dir;
		initDbAccessor(join(dir, "memory", "memories.db"));

		const warnCalls: string[] = [];
		const originalWarn = logger.warn;
		logger.warn = ((_category: unknown, message: unknown) => {
			warnCalls.push(String(message));
		}) as typeof logger.warn;

		try {
			const source = obsidianNativeMemorySource(dir);
			const first = join(dir, "note-a.md");
			const second = join(dir, "note-b.md");
			writeFileSync(first, "a");
			writeFileSync(second, "b");

			expect(await indexNativeMemoryFile(source, first)).toBe(false);
			// Immediately re-indexing the same file must be skipped by the
			// failure backoff — no second fs read attempt.
			expect(await indexNativeMemoryFile(source, first)).toBe(false);
			expect(await indexNativeMemoryFile(source, second)).toBe(false);

			expect(readAttempts).toBe(2);
			const datalessWarns = warnCalls.filter((m) => m.includes("dataless/locked-file error"));
			// Both files failed in the same window but only ONE warning was
			// emitted (the second failure consolidated into the counter).
			expect(datalessWarns.length).toBe(1);
			expect(datalessWarns[0]).toContain("Skipped");
			expect(datalessWarns[0]).toContain("on obsidian");
		} finally {
			logger.warn = originalWarn;
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
