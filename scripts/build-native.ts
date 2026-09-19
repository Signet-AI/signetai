/**
 * Cross-platform native build script.
 * Builds the native vector module and the Rust daemon, then stages the daemon
 * in the installed package layout used by the npm wrapper.
 */
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cpSync, chmodSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const nativeDir = join(import.meta.dir, "..", "platform", "native");
const root = join(import.meta.dir, "..");
const daemonManifest = join(root, "platform", "rust-daemon", "Cargo.toml");
const daemonBinary = join(
	root,
	"platform",
	"rust-daemon",
	"target",
	"release",
	process.platform === "win32" ? "signet-daemon.exe" : "signet-daemon",
);
const stagedDaemon = join(
	root,
	"dist",
	"signetai",
	"runtime",
	"daemon",
	process.platform === "win32" ? "signet-daemon.exe" : "signet-daemon",
);

if (process.env.SIGNET_SKIP_NATIVE_BUILD === "1") {
	console.log("[signet] skipping native build (SIGNET_SKIP_NATIVE_BUILD=1)");
	process.exit(0);
}

if (!existsSync(nativeDir)) {
	console.error("[signet] native build failed: platform/native was not found");
	process.exit(1);
}

// Check if cargo is available
try {
	const locator = process.platform === "win32" ? "where" : "which";
	execSync(`${locator} cargo`, { stdio: "ignore", windowsHide: true });
} catch {
	console.error("[signet] native build failed: cargo is required (set SIGNET_SKIP_NATIVE_BUILD=1 to skip)");
	process.exit(1);
}

// Build the native module
try {
	execSync("bun run build", { cwd: nativeDir, stdio: "inherit" });
	execSync(`cargo build --release --manifest-path ${JSON.stringify(daemonManifest)}`, { cwd: root, stdio: "inherit" });
	rmSync(join(stagedDaemon, ".."), { recursive: true, force: true });
	mkdirSync(join(stagedDaemon, ".."), { recursive: true });
	cpSync(daemonBinary, stagedDaemon);
	if (process.platform !== "win32") chmodSync(stagedDaemon, 0o755);
	console.log(`[signet] staged Rust daemon: ${stagedDaemon}`);
} catch {
	console.error("[signet] native build failed (set SIGNET_SKIP_NATIVE_BUILD=1 to skip)");
	process.exit(1);
}
