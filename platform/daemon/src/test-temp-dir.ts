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
	registerExitCleanup(dir);
	return dir;
}

const registered = new Set<string>();

function registerExitCleanup(dir: string): void {
	if (registered.has(dir)) return;
	registered.add(dir);

	const cleanup = (): void => {
		if (!registered.has(dir)) return;
		registered.delete(dir);
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			// Best-effort only — never mask the original failure.
		}
	};

	process.on("exit", cleanup);
	// SIGINT/SIGTERM: run cleanup, then re-raise so the process still exits
	// with the conventional signal semantics.
	for (const signal of ["SIGINT", "SIGTERM"] as const) {
		process.on(signal as NodeJS.Signals, () => {
			cleanup();
			process.exit(128 + (signal === "SIGINT" ? 2 : 15));
		});
	}
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
