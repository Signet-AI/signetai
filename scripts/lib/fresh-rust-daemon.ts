import { existsSync, accessSync, constants } from "node:fs";
import { join } from "node:path";

/** Resolve only the current native Rust daemon; never fall back to TypeScript. */
export function resolveFreshRustDaemon(repoRoot: string, env: NodeJS.ProcessEnv = process.env): string {
	const explicit = env.SIGNET_RUST_DAEMON_BIN?.trim();
	if (explicit && /\.(?:js|ts|mjs|cjs)$/i.test(explicit)) {
		throw new Error("Native Signet daemon executable is required; JavaScript and TypeScript paths are not allowed.");
	}
	const candidates = explicit
		? [explicit]
		: [
				join(
					repoRoot,
					"platform",
					"rust-daemon",
					"target",
					"debug",
					process.platform === "win32" ? "signet-daemon.exe" : "signet-daemon",
				),
				join(
					repoRoot,
					"platform",
					"rust-daemon",
					"target",
					"release",
					process.platform === "win32" ? "signet-daemon.exe" : "signet-daemon",
				),
			];
	const binary = candidates.find((path) => {
		try {
			accessSync(path, constants.X_OK);
			return existsSync(path);
		} catch {
			return false;
		}
	});
	if (!binary)
		throw new Error(
			`fresh Rust daemon binary missing; set SIGNET_RUST_DAEMON_BIN or build platform/rust-daemon (${candidates.join(", ")})`,
		);
	return binary;
}
