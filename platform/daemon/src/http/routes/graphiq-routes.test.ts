import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getInstallScriptPath } from "./graphiq-install-path.js";

const thisDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(thisDir, "../../../../../");
const sourceScript = resolve(repoRoot, "scripts/install-graphiq.sh");
const pkgScript = resolve(repoRoot, "dist/signetai/scripts/install-graphiq.sh");
const pkgJsonPath = resolve(repoRoot, "dist/signetai/package.json");

describe("getInstallScriptPath", () => {
	test("returns a path that points to an existing install-graphiq.sh", () => {
		const path = getInstallScriptPath();
		expect(existsSync(path)).toBe(true);
		expect(path).toMatch(/scripts\/install-graphiq\.sh$/);
	});

	test("install-graphiq.sh exists in repo root scripts directory", () => {
		expect(existsSync(sourceScript)).toBe(true);
	});

	test("install-graphiq.sh exists in signetai package scripts directory", () => {
		expect(existsSync(pkgScript)).toBe(true);
	});

	test("source and package scripts are identical", () => {
		expect(readFileSync(sourceScript, "utf-8")).toBe(readFileSync(pkgScript, "utf-8"));
	});

	test("signetai package.json includes scripts in files array", () => {
		const pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf-8"));
		expect(pkgJson.files).toContain("scripts");
	});

	test("copy:scripts build step exists in package.json", () => {
		const pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf-8"));
		expect(pkgJson.scripts["copy:scripts"]).toBeDefined();
		expect(pkgJson.scripts.prebuild).toContain("copy:scripts");
	});

	test("production resolver finds script when placed in bundled dist layout", () => {
		const fakePkg = join(thisDir, "__test_pkg_layout__");
		const fakeDist = join(fakePkg, "dist");
		const fakeScripts = join(fakePkg, "scripts");
		mkdirSync(fakeDist, { recursive: true });
		mkdirSync(fakeScripts, { recursive: true });
		writeFileSync(join(fakeDist, "daemon.js"), "// bundle\n");
		const scriptContent = "#!/bin/sh\necho test\n";
		writeFileSync(join(fakeScripts, "install-graphiq.sh"), scriptContent);
		try {
			const result = getInstallScriptPath(`file://${join(fakeDist, "daemon.js")}`);
			expect(existsSync(result)).toBe(true);
			expect(readFileSync(result, "utf-8")).toBe(scriptContent);
		} finally {
			rmSync(fakePkg, { recursive: true, force: true });
		}
	});
});
