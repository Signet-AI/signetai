#!/usr/bin/env bun

import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { arch, platform } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const outDir = join(root, "dist", "native");
const platformKey = process.env.SIGNET_NATIVE_PLATFORM ?? `${platform()}-${arch()}`;
const binaryName = platformKey.startsWith("win32-") ? `signet-${platformKey}.exe` : `signet-${platformKey}`;
const outfile = join(outDir, binaryName);
const manifest = join(root, "platform", "rust-daemon", "Cargo.toml");
const daemonName = platformKey.startsWith("win32-") ? "signet-daemon.exe" : "signet-daemon";
const daemonBinary = join(root, "platform", "rust-daemon", "target", "release", daemonName);

if (!existsSync(manifest)) throw new Error(`Rust daemon manifest is missing: ${manifest}`);
mkdirSync(outDir, { recursive: true });
rmSync(outfile, { force: true });

try {
	execFileSync("cargo", ["build", "--release", "--manifest-path", manifest], {
		cwd: root,
		stdio: "inherit",
		windowsHide: true,
	});
} catch {
	console.error("[signet] native Rust daemon build failed");
	process.exit(1);
}

if (!existsSync(daemonBinary)) {
	console.error(`[signet] native Rust daemon artifact is missing: ${daemonBinary}`);
	process.exit(1);
}

copyFileSync(daemonBinary, outfile);
if (platform() !== "win32") chmodSync(outfile, 0o755);
console.log(`Built native Rust daemon executable: ${outfile}`);
if (!process.env.SIGNET_NATIVE_PLATFORM) {
	const localName = platform() === "win32" ? "signet.exe" : "signet";
	const localPath = join(outDir, localName);
	copyFileSync(outfile, localPath);
	if (platform() !== "win32") chmodSync(localPath, 0o755);
	console.log(`Updated local smoke binary: ${localPath}`);
}
