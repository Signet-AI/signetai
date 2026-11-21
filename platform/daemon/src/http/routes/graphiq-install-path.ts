import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { materializeEmbeddedAssetTree } from "../../runtime/update/native-runtime-assets.js";

export function getInstallScriptPath(importMetaUrl: string = import.meta.url): string {
	const thisDir = dirname(fileURLToPath(importMetaUrl));
	const embeddedRoot = materializeEmbeddedAssetTree("graphiq");
	const candidates = [
		...(embeddedRoot ? [resolve(embeddedRoot, "scripts/install-graphiq.sh")] : []),
		resolve(thisDir, "../scripts/install-graphiq.sh"),
		resolve(thisDir, "../../../../../scripts/install-graphiq.sh"),
	];
	const bundled = candidates.find((candidate) => existsSync(candidate));
	if (bundled) return bundled;
	return resolve(thisDir, "../../../../../scripts/install-graphiq.sh");
}
