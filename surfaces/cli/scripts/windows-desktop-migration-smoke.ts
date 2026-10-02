import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { installWindowsDesktopApp } from "../src/features/desktop.js";

const [runnerTemp, localAppData] = process.argv.slice(2);
if (process.platform !== "win32" || !runnerTemp || !localAppData) {
	throw new Error("This smoke test requires the Windows runner and its isolated app-data path.");
}

const expectedLocalAppData = join(resolve(runnerTemp), "Local AppData");
if (resolve(localAppData) !== expectedLocalAppData) {
	throw new Error("The migration smoke test app-data path must stay inside RUNNER_TEMP/Local AppData.");
}

const legacyAppDir = join(expectedLocalAppData, "Programs", "@signetdesktop");
const legacyExecutable = join(legacyAppDir, "signet.exe");
const legacyPackage = join(legacyAppDir, "resources", "app.asar");
const legacyUninstaller = join(legacyAppDir, "Uninstall Signet.exe");
if (!existsSync(legacyExecutable) || !existsSync(legacyPackage) || !existsSync(legacyUninstaller)) {
	throw new Error("The real NSIS legacy install is incomplete; migration was not exercised.");
}

const result = installWindowsDesktopApp(
	process.cwd(),
	homedir(),
	join(resolve(runnerTemp), "migration-workspace"),
	expectedLocalAppData,
	{ platform: "win32" },
);
if (result.retiredLegacyAppDir !== legacyAppDir) {
	throw new Error(`Expected the legacy install to be retired at ${legacyAppDir}.`);
}
if (!existsSync(result.executable)) {
	throw new Error(`The managed desktop executable was not installed at ${result.executable}.`);
}
if (existsSync(legacyExecutable) || existsSync(legacyPackage) || existsSync(legacyUninstaller)) {
	throw new Error(`Legacy Signet files remain after migration at ${legacyAppDir}.`);
}

console.info("Real NSIS legacy migration passed through installWindowsDesktopApp.");
