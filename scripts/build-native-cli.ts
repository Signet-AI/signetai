#!/usr/bin/env bun

import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { arch, platform } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const outDir = join(root, "dist", "native");
const platformKey = process.env.SIGNET_NATIVE_PLATFORM ?? `${platform()}-${arch()}`;
const targetByPlatform: Record<string, string> = {
	"linux-x64": "x86_64-unknown-linux-gnu",
	"linux-arm64": "aarch64-unknown-linux-gnu",
	"darwin-x64": "x86_64-apple-darwin",
	"darwin-arm64": "aarch64-apple-darwin",
	"win32-x64": "x86_64-pc-windows-msvc",
};
const target = targetByPlatform[platformKey];
if (!target)
	throw new Error(`Unsupported native target ${platformKey}; choose an explicit supported platform/architecture`);
const binaryName = platformKey.startsWith("win32-") ? `signet-${platformKey}.exe` : `signet-${platformKey}`;
const outfile = join(outDir, binaryName);
const manifest = join(root, "platform", "rust-daemon", "Cargo.toml");
const daemonName = platformKey.startsWith("win32-") ? "signet-daemon.exe" : "signet-daemon";
const daemonBinary = join(root, "platform", "rust-daemon", "target", target, "release", daemonName);

if (!existsSync(manifest)) throw new Error(`Rust daemon manifest is missing: ${manifest}`);
mkdirSync(outDir, { recursive: true });
rmSync(outfile, { force: true });

try {
	execFileSync("cargo", ["build", "--release", "--target", target, "--manifest-path", manifest], {
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
const checksum = createHash("sha256").update(readFileSync(outfile)).digest("hex");
const provenance = join(outDir, `${binaryName}.provenance.json`);
writeFileSync(
	provenance,
	JSON.stringify(
		{
			artifact: outfile,
			target,
			platform: platformKey.split("-")[0],
			architecture: platformKey.split("-").slice(1).join("-"),
			sha256: checksum,
			sourceRevision:
				process.env.GITHUB_SHA ?? execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
		},
		null,
		2,
	) + "\n",
);
console.log(`Built native Rust daemon executable: ${outfile}`);
if (!process.env.SIGNET_NATIVE_PLATFORM) {
	const localName = platform() === "win32" ? "signet.exe" : "signet";
	const localPath = join(outDir, localName);
	copyFileSync(outfile, localPath);
	if (platform() !== "win32") chmodSync(localPath, 0o755);
	console.log(`Updated local smoke binary: ${localPath}`);
}
