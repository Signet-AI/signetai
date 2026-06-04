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

	test("uses architecture-specific macOS update channels", () => {
		const updateSource = readFileSync(join(import.meta.dir, "desktop-updates.ts"), "utf8");

		expect(updateSource).toContain("autoUpdater.channel = channel");
		expect(updateSource).toContain('if (platform !== "darwin") return null;');
		expect(updateSource).toContain('return arch === "arm64" ? "latest-arm64" : "latest-x64";');
	});

	test("publishes metadata and mac zip artifacts required by electron-updater", () => {
		const packageJson = JSON.parse(readFileSync(join(desktopRoot, "package.json"), "utf8"));
		expect(packageJson.dependencies["electron-updater"]).toBeString();
		expect(packageJson.build.publish).toContainEqual({ provider: "github", owner: "Signet-AI", repo: "signetai" });
		expect(packageJson.build.mac.target).toContain("zip");

		const workflow = readFileSync(join(desktopRoot, "..", "..", ".github", "workflows", "desktop-build.yml"), "utf8");
		expect(workflow).toContain("surfaces/desktop/release/*.zip");
		expect(workflow).toContain("surfaces/desktop/release/latest*.yml");
		expect(workflow).toContain("Normalize macOS updater metadata");
		expect(workflow).toContain('mv latest-mac.yml "latest-${{ matrix.arch }}-mac.yml"');
	});

	test("requires official signing for public desktop tag releases", () => {
		const workflow = readFileSync(join(desktopRoot, "..", "..", ".github", "workflows", "desktop-build.yml"), "utf8");

		expect(workflow).toContain("IS_TAG_RELEASE: ${{ startsWith(github.ref, 'refs/tags/v') && '1' || '0' }}");
		expect(workflow).toContain(
			'if [ "${IS_TAG_RELEASE}" = "1" ] && [ "${requires_signing}" -eq 1 ] && [ "${has_official}" -ne 1 ]; then',
		);
		expect(workflow).toContain("Public desktop tag releases require official signing secrets");
		expect(workflow.indexOf('if [ "${IS_TAG_RELEASE}" = "1" ]')).toBeLessThan(
			workflow.indexOf('if [ "${mode}" = "official" ] && [ "${requires_signing}" -eq 0 ]; then'),
		);
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
