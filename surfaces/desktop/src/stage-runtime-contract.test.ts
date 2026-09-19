import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";

/**
 * The packaged native daemon resolves its dashboard and connector assets from
 * the rust-daemon resource tree. Keep staging focused on those native assets.
 */
test("desktop runtime staging ships the native daemon and dashboard", () => {
	const source = readFileSync(join(import.meta.dir, "..", "scripts", "stage-runtime.mjs"), "utf8");
	expect(source).toContain('"rust-daemon"');
	expect(source).toContain("dashboardBuild");
	expect(source).not.toContain("bun install");
	expect(source).not.toContain("platform/daemon");
	expect(source).not.toContain("dist/daemon.js");
	expect(source).toContain("nativeDaemonPath");
});
/**
 * The hermes-agent connector copies its Python plugin from an on-disk
 * hermes-plugin directory that is NOT bundled into the daemon JS. Without
 * staging it and pointing SIGNET_CONNECTOR_ASSETS_DIR at the staged tree,
 * harness install fails with "could not refresh the Hermes repo Signet
 * provider" in the packaged desktop app.
 */
test("desktop runtime staging ships connector assets for harness install", () => {
	const source = readFileSync(join(import.meta.dir, "..", "scripts", "stage-runtime.mjs"), "utf8");
	expect(source).toContain('resolve(connectorsOut, "hermes-agent", "hermes-plugin")');

	const daemonManager = readFileSync(join(import.meta.dir, "daemon-manager.ts"), "utf8");
	expect(daemonManager).toContain("SIGNET_CONNECTOR_ASSETS_DIR");
});
