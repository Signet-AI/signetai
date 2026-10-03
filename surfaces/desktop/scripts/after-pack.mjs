import { copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const legacyIcon = join(dirname(fileURLToPath(import.meta.url)), "..", "icons", "icon.icns");

export default async function afterPack(context) {
	if (context.electronPlatformName !== "darwin") return;
	const appName = `${context.packager.appInfo.productFilename}.app`;
	copyFileSync(legacyIcon, join(context.appOutDir, appName, "Contents", "Resources", "icon.icns"));
}
