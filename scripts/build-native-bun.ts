#!/usr/bin/env bun

import { mkdirSync } from "node:fs";
import { arch, platform } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { copyFileSync, chmodSync } from "node:fs";

const root = join(import.meta.dir, "..");
const outDir = join(root, "dist", "native");
const platformKey = process.env.SIGNET_NATIVE_PLATFORM ?? `${platform()}-${arch()}`;
const binaryName = platform() === "win32" ? `signet-${platformKey}.exe` : `signet-${platformKey}`;
const outfile = join(outDir, binaryName);

mkdirSync(outDir, { recursive: true });

const result = spawnSync(
	"bun",
	[
		"build",
		"--compile",
		"--target=bun",
		"--outfile",
		outfile,
		"--external",
		"better-sqlite3",
		"--external",
		"@1password/sdk",
		"surfaces/cli/src/cli.ts",
	],
	{
		cwd: root,
		stdio: "inherit",
		windowsHide: true,
	},
);

if (result.status !== 0) {
	process.exit(result.status ?? 1);
}

console.log(`Built native Bun executable: ${outfile}`);

if (!process.env.SIGNET_NATIVE_PLATFORM) {
	const localName = platform() === "win32" ? "signet.exe" : "signet";
	const localPath = join(outDir, localName);
	copyFileSync(outfile, localPath);
	if (platform() !== "win32") chmodSync(localPath, 0o755);
	console.log(`Updated local smoke binary: ${localPath}`);
}
