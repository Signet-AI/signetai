import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
		} catch {}
	}
}

function installCleanupHandlers(): void {
	if (cleanupHandlersInstalled) return;
	cleanupHandlersInstalled = true;
	process.on("exit", cleanupRegisteredDirs);
	process.once("SIGINT", () => {
		cleanupRegisteredDirs();
		process.exit(130);
	});
	process.once("SIGTERM", () => {
		cleanupRegisteredDirs();
		process.exit(143);
	});
}
export function cleanupTestTempDir(dir: string): void {
	if (registered.has(dir)) registered.delete(dir);
	try {
		rmSync(dir, { recursive: true, force: true });
	} catch {}
}
