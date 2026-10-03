import { copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const legacyIcon = join(dirname(fileURLToPath(import.meta.url)), "..", "icons", "icon.icns");

// electron-builder bundles the .icns that actool emits beside Assets.car, which tops out at
// 128px@2x. macOS 26+ reads Assets.car, but older releases fall back to this file, so swap in
// the full-resolution render from scripts/render-mac-icon.sh before the app is signed.
export default async function afterPack(context) {
	if (context.electronPlatformName !== "darwin") return;
	const appName = `${context.packager.appInfo.productFilename}.app`;
	copyFileSync(legacyIcon, join(context.appOutDir, appName, "Contents", "Resources", "icon.icns"));
}
