import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const desktopRoot = join(import.meta.dir, "..");

describe("desktop update packaging", () => {
	test("ships Electron updater support instead of a null update IPC", () => {
		const mainSource = readFileSync(join(import.meta.dir, "main.ts"), "utf8");
		expect(mainSource).toContain('ipcMain.handle("desktop:checkForUpdate", () => checkForDesktopUpdate');
		expect(mainSource).not.toContain('ipcMain.handle("desktop:checkForUpdate", () => null)');
	});

	test("shows the desktop window before daemon startup finishes", () => {
		const mainSource = readFileSync(join(import.meta.dir, "main.ts"), "utf8");
		const showDashboardReady = mainSource.slice(
			mainSource.indexOf("async function showDashboardReady"),
			mainSource.indexOf("async function prepareDaemonForDashboard"),
		);

		expect(showDashboardReady.indexOf("win.show()")).toBeLessThan(
			showDashboardReady.indexOf("await prepareDaemonForDashboard()"),
		);
		expect(mainSource).toContain("show: true");
		expect(showDashboardReady.indexOf("loadStartupWindow(win)")).toBeLessThan(
			showDashboardReady.indexOf("await prepareDaemonForDashboard()"),
		);
		expect(showDashboardReady).toContain("loadMainWindow(win)");
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

	test("fails closed for stable macOS artifacts without notarization", () => {
		const packageJson = JSON.parse(readFileSync(join(desktopRoot, "package.json"), "utf8"));
		const mac = packageJson.build.mac;
		expect(mac.hardenedRuntime).toBe(true);
		expect(mac.gatekeeperAssess).toBe(false);
		expect(mac.strictVerify).toBe(true);
		expect(mac.notarize).toBe(true);
		expect(mac.entitlements).toBe("build/entitlements.mac.plist");
		expect(mac.entitlementsInherit).toBe("build/entitlements.mac.inherit.plist");

		for (const name of ["entitlements.mac.plist", "entitlements.mac.inherit.plist"]) {
			const entitlements = readFileSync(join(desktopRoot, "build", name), "utf8");
			expect(entitlements).toContain("com.apple.security.cs.allow-jit");
			expect(entitlements).toContain("com.apple.security.cs.disable-library-validation");
		}

		const workflow = readFileSync(join(desktopRoot, "..", "..", ".github", "workflows", "desktop-build.yml"), "utf8");
		for (const secret of [
			"APPLE_ID",
			"APPLE_APP_SPECIFIC_PASSWORD",
			"APPLE_TEAM_ID",
			"APPLE_API_KEY",
			"APPLE_API_KEY_ID",
			"APPLE_API_ISSUER",
			"APPLE_KEYCHAIN_PROFILE",
		]) {
			expect(workflow).toContain(`secrets.${secret}`);
		}
		expect(workflow).toContain("macOS tag releases require Developer ID signing and notarization");
		expect(workflow).toContain("Stable macOS releases cannot use unsigned or self-signed artifacts");
		expect(workflow).toContain("bun run verify:macos");
		const verifier = readFileSync(join(desktopRoot, "scripts", "verify-macos-release.mjs"), "utf8");
		expect(verifier).toContain('run("xcrun", ["stapler", "validate"');
		expect(verifier).toContain('run("spctl", ["--assess", "--type", "execute"');
	});

	test("uses a Linux-safe Electron executable name", () => {
		const packageJson = JSON.parse(readFileSync(join(desktopRoot, "package.json"), "utf8"));
		expect(packageJson.build.executableName).toBe("signet");
		expect(packageJson.build.executableName).toMatch(/^[A-Za-z0-9._ -]+$/);
	});

	test("ships a full macOS app iconset", () => {
		if (process.platform !== "darwin") return;

		const outDir = join(Bun.env.TMPDIR ?? "/tmp", `signet-icon-${Date.now()}.iconset`);
		execFileSync("iconutil", ["-c", "iconset", join(desktopRoot, "icons", "icon.icns"), "-o", outDir]);
		const iconNames = execFileSync("find", [outDir, "-maxdepth", "1", "-type", "f"], { encoding: "utf8" });

		for (const name of [
			"icon_16x16.png",
			"icon_16x16@2x.png",
			"icon_32x32.png",
			"icon_32x32@2x.png",
			"icon_128x128.png",
			"icon_128x128@2x.png",
			"icon_256x256.png",
			"icon_256x256@2x.png",
			"icon_512x512.png",
			"icon_512x512@2x.png",
		]) {
			expect(iconNames).toContain(name);
		}
	});
});
