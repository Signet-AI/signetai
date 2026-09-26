import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { platformVecPackage, runtimeDependencies } from "../scripts/stage-runtime.mjs";
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
	expect(source).toContain("workspace-migration-runner.ts");
	expect(source).toContain('"workspace-migration-runner.js"');
});
test("desktop runtime staging ships connector assets for harness install", () => {
	const source = readFileSync(join(import.meta.dir, "..", "scripts", "stage-runtime.mjs"), "utf8");
	expect(source).toContain('resolve(connectorsOut, "hermes-agent", "hermes-plugin")');

	const daemonManager = readFileSync(join(import.meta.dir, "daemon-manager.ts"), "utf8");
	expect(daemonManager).toContain("SIGNET_CONNECTOR_ASSETS_DIR");
});

test("stages Bun runtime dependencies without the Node-only SQLite fallback", () => {
	const daemonPkg = { dependencies: { "@firecrawl/anydoc": "^1.0.0", tiktoken: "^1.0.0" } };
	const corePkg = {
		dependencies: { "sqlite-vec": "^0.1.0" },
		optionalDependencies: {
			"better-sqlite3": "^11.0.0",
			"sqlite-vec-linux-x64": "^0.1.0",
		},
	};
	const dependencies = runtimeDependencies(daemonPkg, corePkg, "linux", "x64");
	expect(dependencies).toEqual({
		"@firecrawl/anydoc": "^1.0.0",
		tiktoken: "^1.0.0",
		"sqlite-vec": "^0.1.0",
		"sqlite-vec-linux-x64": "^0.1.0",
	});
	expect(dependencies).not.toHaveProperty("better-sqlite3");
});

test("selects the native sqlite-vec package for the target platform", () => {
	expect(platformVecPackage("darwin", "arm64")).toBe("sqlite-vec-darwin-arm64");
	expect(platformVecPackage("win32", "x64")).toBe("sqlite-vec-windows-x64");
});
