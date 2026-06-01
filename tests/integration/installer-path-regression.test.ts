import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = fileURLToPath(new URL("../../", import.meta.url));
const unixInstaller = readFileSync(join(rootDir, "web/marketing/public/install.sh"), "utf8");
const windowsInstaller = readFileSync(join(rootDir, "web/marketing/public/install.ps1"), "utf8");

describe("installer regression guard", () => {
	it("delegates Unix installs to the native bundle instead of package-manager setup", () => {
		expect(unixInstaller).toContain("releases/download/bundle-latest/install.sh");
		expect(unixInstaller).toContain('curl -fsSL "$INSTALLER_URL" | bash');
		expect(unixInstaller).not.toContain("persist_path_dir");
		expect(unixInstaller).not.toContain("npm_global_bin");
		expect(unixInstaller).not.toContain("bun add -g signetai");
		expect(unixInstaller).not.toContain("npm install -g signetai");
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
