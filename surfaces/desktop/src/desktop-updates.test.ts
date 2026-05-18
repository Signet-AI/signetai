import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const desktopRoot = join(import.meta.dir, "..");

describe("desktop update packaging", () => {
	test("ships Electron updater support instead of a null update IPC", () => {
		const mainSource = readFileSync(join(import.meta.dir, "main.ts"), "utf8");
		expect(mainSource).toContain('ipcMain.handle("desktop:checkForUpdate", () => checkForDesktopUpdate');
		expect(mainSource).not.toContain('ipcMain.handle("desktop:checkForUpdate", () => null)');
	});

	test("loads electron-updater through CommonJS interop for packaged ESM", () => {
		const updateSource = readFileSync(join(import.meta.dir, "desktop-updates.ts"), "utf8");
		expect(updateSource).toContain("createRequire(import.meta.url)");
		expect(updateSource).not.toContain('autoUpdater } from "electron-updater"');
	});

	test("publishes metadata and mac zip artifacts required by electron-updater", () => {
		const packageJson = JSON.parse(readFileSync(join(desktopRoot, "package.json"), "utf8"));
		expect(packageJson.dependencies["electron-updater"]).toBeString();
		expect(packageJson.build.publish).toContainEqual({ provider: "github", owner: "Signet-AI", repo: "signetai" });
		expect(packageJson.build.mac.target).toContain("zip");

		const workflow = readFileSync(join(desktopRoot, "..", "..", ".github", "workflows", "desktop-build.yml"), "utf8");
		expect(workflow).toContain("surfaces/desktop/release/*.zip");
		expect(workflow).toContain("surfaces/desktop/release/latest*.yml");
	});
});
