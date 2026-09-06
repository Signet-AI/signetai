import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";

/**
 * The packaged daemon resolves every worker (db-owner, harness install,
 * dreaming tokens, transcript recovery, ...) as a sibling of daemon.js, and
 * resolves tiktoken's WASM from the staged node_modules. The staging script
 * must therefore copy the whole built dist directory rather than a hardcoded
 * file list, and must stage tiktoken.
 */
test("desktop runtime staging ships the full daemon dist and tiktoken", () => {
	const source = readFileSync(join(import.meta.dir, "..", "scripts", "stage-runtime.mjs"), "utf8");
	expect(source).toContain('for (const entry of readdirSync(daemonDist))');
	expect(source).not.toContain('for (const name of ["daemon.js"');
	const daemonManifest = readFileSync(join(import.meta.dir, "..", "..", "..", "platform", "daemon", "package.json"), "utf8");
	const daemonPkg = JSON.parse(daemonManifest) as { dependencies?: Record<string, string> };
	expect(source).toContain('"tiktoken"');
	expect(typeof daemonPkg.dependencies?.tiktoken).toBe("string");
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
