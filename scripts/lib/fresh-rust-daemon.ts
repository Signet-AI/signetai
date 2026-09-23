import { existsSync, accessSync, constants } from "node:fs";
import { join } from "node:path";

const executableName = process.platform === "win32" ? "signet-daemon.exe" : "signet-daemon";

function requireExecutable(path: string): string {
	try {
		accessSync(path, constants.X_OK);
		if (existsSync(path)) return path;
	} catch {
		// Fall through to the stable error below.
	}
	throw new Error(`fresh Rust daemon binary missing: ${path}`);
}

/** Resolve only the current native Rust daemon; never fall back to TypeScript. */
export function resolveFreshRustDaemon(repoRoot: string, env: NodeJS.ProcessEnv = process.env): string {
	const explicit = env.SIGNET_RUST_DAEMON_BIN?.trim();
	if (explicit && /\.(?:js|ts|mjs|cjs)$/i.test(explicit)) {
		throw new Error("Native Signet daemon executable is required; JavaScript and TypeScript paths are not allowed.");
	}
	if (explicit) {
		if (/\.(?:js|ts|mjs|cjs)$/i.test(explicit)) {
			throw new Error("Native Signet daemon executable is required; JavaScript and TypeScript paths are not allowed.");
		}
		return requireExecutable(explicit);
	}
	const target = `${process.platform}-${process.arch}`;
	const packagedRoot = join(repoRoot, "dist", "signetai", "runtime", "rust-daemon");
	const packaged = join(packagedRoot, target, executableName);
	const dashboard = join(packagedRoot, "dashboard", "index.html");
	if (existsSync(packaged)) {
		if (!existsSync(dashboard)) throw new Error(`dashboard runtime asset missing: ${dashboard}`);
		return requireExecutable(packaged);
	}
	if (existsSync(dashboard)) {
		throw new Error(`fresh Rust daemon binary missing (packaged Rust daemon binary missing): ${packaged}`);
	}

	// A native checkout binary is valid for development, but never substitutes for
	// the staged artifact once an installed package provides one.
	for (const profile of ["debug", "release"]) {
		const checkout = join(repoRoot, "platform", "rust-daemon", "target", profile, executableName);
		if (existsSync(checkout)) return requireExecutable(checkout);
	}
	throw new Error(`fresh Rust daemon binary missing (packaged Rust daemon binary missing): ${packaged}`);
}
