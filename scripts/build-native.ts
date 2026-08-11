/**
 * Cross-platform native build script.
 * Checks for cargo availability before attempting to build the Rust native module.
 */
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const nativeDir = join(import.meta.dir, "..", "platform", "native");

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
} catch {
	console.error("[signet] native build failed (set SIGNET_SKIP_NATIVE_BUILD=1 to skip)");
	process.exit(1);
}
