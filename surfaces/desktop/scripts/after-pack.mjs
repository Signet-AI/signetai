import { execFileSync } from "node:child_process";
import { copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const assetCatalog = join(dirname(fileURLToPath(import.meta.url)), "..", "build", "Assets.car");

export default async function afterPack(context) {
	if (context.electronPlatformName !== "darwin") return;
	const contents = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, "Contents");
	copyFileSync(assetCatalog, join(contents, "Resources", "Assets.car"));
	execFileSync("plutil", ["-replace", "CFBundleIconName", "-string", "Icon", join(contents, "Info.plist")]);
}
