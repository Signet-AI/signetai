import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { platformVecPackage } from "../scripts/stage-runtime.mjs";
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
test("desktop runtime staging ships connector assets for harness install", () => {
	const source = readFileSync(join(import.meta.dir, "..", "scripts", "stage-runtime.mjs"), "utf8");
	expect(source).toContain('resolve(connectorsOut, "hermes-agent", "hermes-plugin")');

	const daemonManager = readFileSync(join(import.meta.dir, "daemon-manager.ts"), "utf8");
	expect(daemonManager).toContain("SIGNET_CONNECTOR_ASSETS_DIR");
});

test("selects the native sqlite-vec package for the target platform", () => {
	expect(platformVecPackage("darwin", "arm64")).toBe("sqlite-vec-darwin-arm64");
	expect(platformVecPackage("win32", "x64")).toBe("sqlite-vec-windows-x64");
});
