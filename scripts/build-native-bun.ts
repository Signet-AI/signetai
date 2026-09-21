#!/usr/bin/env bun

/** Build the CLI-only Bun executable used by release packaging.
 *
 * This entrypoint deliberately compiles surfaces/cli/src/cli.ts only. The
 * Rust daemon/core are not bundled, and no TypeScript daemon workers or
 * fallback runtime are emitted.
 */
import { chmodSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { arch, platform } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const outDir = join(root, "dist", "native");
const platformKey = process.env.SIGNET_NATIVE_PLATFORM?.trim() || `${platform()}-${arch()}`;
const targetByPlatform: Record<string, string> = {
	"linux-x64": "bun-linux-x64",
	"linux-arm64": "bun-linux-arm64",
	"darwin-x64": "bun-darwin-x64",
	"darwin-arm64": "bun-darwin-arm64",
	"win32-x64": "bun-windows-x64",
};
const target = targetByPlatform[platformKey];
if (!target) throw new Error(`Unsupported native compile platform: ${platformKey}`);
const binaryName = platformKey === "win32-x64" ? `signet-${platformKey}.exe` : `signet-${platformKey}`;
const outfile = join(outDir, binaryName);
mkdirSync(outDir, { recursive: true });
rmSync(outfile, { force: true });
// Bun.build's compile option is the programmatic form of `bun build --compile`.
const result = await Bun.build({
	entrypoints: [join(root, "surfaces", "cli", "src", "cli.ts")],
	compile: {
		target: target as "bun-linux-x64" | "bun-linux-arm64" | "bun-darwin-x64" | "bun-darwin-arm64" | "bun-windows-x64",
		outfile,
	},
});
if (!result.success) {
	for (const log of result.logs) console.error(log);
	process.exit(1);
}
if (!existsSync(outfile)) throw new Error(`Native CLI build did not produce ${outfile}`);
if (platform() !== "win32") chmodSync(outfile, 0o755);
if (!process.env.SIGNET_NATIVE_PLATFORM && platformKey === `${platform()}-${arch()}`) {
	const localName = platform() === "win32" ? "signet.exe" : "signet";
	const localPath = join(outDir, localName);
	const { copyFileSync } = await import("node:fs");
	copyFileSync(outfile, localPath);
	if (platform() !== "win32") chmodSync(localPath, 0o755);
}
console.log(`Built CLI-only Bun executable: ${outfile}`);
