import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = fileURLToPath(new URL("../../", import.meta.url));
const unixInstaller = readFileSync(join(rootDir, "web/marketing/public/install.sh"), "utf8");
const windowsInstaller = readFileSync(join(rootDir, "web/marketing/public/install.ps1"), "utf8");

describe("installer PATH persistence regression guard", () => {
	it("persists Bun and npm global bins for future Unix shells", () => {
		expect(unixInstaller).toContain("persist_path_dir");
		expect(unixInstaller).toContain('persist_path_dir "$BUN_BIN"');
		expect(unixInstaller).toContain('persist_path_dir "$BUN_INSTALL/bin"');
		expect(unixInstaller).toContain("npm_global_bin");
		expect(unixInstaller).toContain('persist_path_dir "$NPM_GLOBAL_BIN"');
		expect(unixInstaller).toContain("string escape -- $argv[1]");
		expect(unixInstaller).toContain("fish_add_path -- %s");
		expect(unixInstaller).toContain("printf -v escaped '%q'");
		expect(unixInstaller).toContain('export PATH=%s:"$PATH"');
	});

	it("persists Bun and npm global bins to the Windows user PATH", () => {
		expect(windowsInstaller).toContain("function Add-UserPathEntry");
		expect(windowsInstaller).toContain('[Environment]::SetEnvironmentVariable("Path", $newPath, "User")');
		expect(windowsInstaller).not.toContain("if (-not (Test-Path $dir)) { return }");
		expect(windowsInstaller).toContain("Get-Command bun");
		expect(windowsInstaller).toContain("Split-Path -Parent $bunCommand.Source");
		expect(windowsInstaller).toContain("Add-UserPathEntry $bunBin");
		expect(windowsInstaller).toContain('Add-UserPathEntry (Join-Path $env:APPDATA "npm")');
	});
});
