#!/usr/bin/env node

import { copyFileSync, existsSync, linkSync, mkdirSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { chmod } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { detectNativePlatform, nativePlatforms } from "../bin/native-platforms.js";

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));

function isWorkspacePackage() {
	const workspaceRoot = dirname(dirname(packageDir));
	if (basename(dirname(packageDir)) !== "dist") return false;
	try {
		const rootPackageJson = JSON.parse(readFileSync(join(workspaceRoot, "package.json"), "utf8"));
		const workspaces = rootPackageJson.workspaces;
		return Array.isArray(workspaces) && workspaces.includes("dist/*");
	} catch {
		return false;
	}
}

function placeBinary(source, destination) {
	try {
		linkSync(source, destination);
	} catch (err) {
		if (err?.code === "EEXIST") {
			unlinkSync(destination);
			try {
				linkSync(source, destination);
			} catch {
				copyFileSync(source, destination);
			}
			return;
		}

		if (err?.code === "EXDEV" || err?.code === "EPERM") {
			copyFileSync(source, destination);
			return;
		}

		throw err;
	}
}

async function main() {
	if (process.env.SIGNET_SKIP_NATIVE_POSTINSTALL === "1" || isWorkspacePackage()) {
		console.log("Skipping Signet native binary linking in workspace install.");
		return;
	}

	const platform = detectNativePlatform();
	const nativePackage = nativePlatforms[platform];
	const source = join(packageDir, "native", platform, nativePackage.binaryName);

	if (!existsSync(source)) {
		console.error(`Signet native binary is missing from the npm package: ${source}`);
		return;
	}

	const installDir = join(packageDir, "native");
	mkdirSync(installDir, { recursive: true });
	const destination = join(installDir, process.platform === "win32" ? "signet.exe" : "signet");
	try {
		placeBinary(source, destination);
		if (process.platform !== "win32") {
			await chmod(destination, 0o755);
		}
		console.log(`Linked bundled Signet native binary for ${platform}`);
	} catch (err) {
		rmSync(destination, { force: true });
		throw err;
	}
}

main().catch((err) => {
	console.error(`Signet native install failed: ${err.message}`);
	process.exit(1);
});
