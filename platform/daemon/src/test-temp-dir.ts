/**
 * Test temp-dir helper with exit-safe cleanup.
 *
 * Test suites that exercise the real daemon (real SQLite DBs, background
 * workers) can leave 100MB+ temp dirs behind when `bun test` is interrupted
 * — `afterAll` never runs on SIGINT/SIGTERM/timeout, and the sqlite
 * WAL/journal left in the temp dir is never reclaimed. This helper creates
 * the dir and registers process-exit cleanup so interrupted runs still
 * remove it (best-effort; SIGKILL cannot be trapped).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Create a temp dir and guarantee it is removed when the process exits. */
export function createTestTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	installCleanupHandlers();
	registered.add(dir);
	return dir;
}

const registered = new Set<string>();
let cleanupHandlersInstalled = false;

function cleanupRegisteredDirs(): void {
	for (const dir of registered) {
		registered.delete(dir);
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			// Best-effort only — never mask the original failure.
		}
	}
}

function installCleanupHandlers(): void {
	if (cleanupHandlersInstalled) return;
	cleanupHandlersInstalled = true;
	process.on("exit", cleanupRegisteredDirs);
	// SIGINT/SIGTERM: clean every registered dir, then exit with the
	// conventional signal status. One process-wide handler avoids leaving
	// later dirs behind when process.exit stops listener dispatch.
	process.once("SIGINT", () => {
		cleanupRegisteredDirs();
		process.exit(130);
	});
	process.once("SIGTERM", () => {
		cleanupRegisteredDirs();
		process.exit(143);
	});
}

/** Remove a temp dir now (used by afterAll for normal-path cleanup). */
export function cleanupTestTempDir(dir: string): void {
	if (registered.has(dir)) registered.delete(dir);
	try {
		rmSync(dir, { recursive: true, force: true });
	} catch {
		// Best-effort only.
	}
}
