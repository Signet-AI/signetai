import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupTestTempDir, createTestTempDir } from "./test-temp-dir";

const leaked: string[] = [];
afterAll(() => {
	for (const dir of leaked) {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			// best-effort
		}
	}
});

describe("test-temp-dir (exit-safe cleanup)", () => {
	it("creates a temp dir under tmpdir with the given prefix", () => {
		const dir = createTestTempDir("signet-test-tempdir-");
		leaked.push(dir);
		expect(dir.startsWith(join(tmpdir(), "signet-test-tempdir-"))).toBe(true);
		expect(existsSync(dir)).toBe(true);
	});

	it("cleanupTestTempDir removes the dir and deregisters it", () => {
		const dir = createTestTempDir("signet-test-tempdir-");
		writeFileSync(join(dir, "marker.txt"), "x");
		cleanupTestTempDir(dir);
		expect(existsSync(dir)).toBe(false);
	});

	it("is idempotent when called twice (afterAll + exit handler)", () => {
		const dir = createTestTempDir("signet-test-tempdir-");
		writeFileSync(join(dir, "marker.txt"), "x");
		cleanupTestTempDir(dir);
		expect(() => cleanupTestTempDir(dir)).not.toThrow();
		expect(existsSync(dir)).toBe(false);
	});

	it("removes a supplied path even when it was not registered", () => {
		const other = mkdtempSync(join(tmpdir(), "signet-test-tempdir-other-"));
		leaked.push(other);
		cleanupTestTempDir(other);
		// The helper only deregisters dirs it created; an unregistered dir is
		// still removed by cleanupTestTempDir, so use it as the removal path.
		expect(existsSync(other)).toBe(false);
	});
});
