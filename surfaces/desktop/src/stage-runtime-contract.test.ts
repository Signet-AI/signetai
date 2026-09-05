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
	expect(source).toContain("for (const entry of readdirSync(daemonDist))");
	expect(source).not.toContain('for (const name of ["daemon.js"');
	const daemonManifest = readFileSync(
		join(import.meta.dir, "..", "..", "..", "platform", "daemon", "package.json"),
		"utf8",
	);
	const daemonPkg = JSON.parse(daemonManifest) as { dependencies?: Record<string, string> };
	expect(source).toContain('"tiktoken"');
	expect(typeof daemonPkg.dependencies?.tiktoken).toBe("string");
});
