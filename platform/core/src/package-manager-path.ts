import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import type { PackageManagerFamily } from "./package-manager";

interface PackageManagerPathInferenceOptions {
	readonly realPath?: string;
	readonly env?: Readonly<Record<string, string | undefined>>;
	readonly home?: string;
	readonly platform?: NodeJS.Platform;
}

export function normalizeExecutablePath(path: string, platform: NodeJS.Platform): string {
	const normalized = (platform === "win32" ? win32 : posix).resolve(path).replaceAll("\\", "/");
	return platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function pathIsWithin(path: string, root: string, platform: NodeJS.Platform): boolean {
	const pathApi = platform === "win32" ? win32 : posix;
	const rel = pathApi.relative(normalizeExecutablePath(root, platform), normalizeExecutablePath(path, platform));
	return rel === "" || (!rel.startsWith("..") && !pathApi.isAbsolute(rel));
}

/** Shared package-manager ownership inference for active and discovered executables. */
export function inferPackageManagerFromExecutable(
	executablePath: string | undefined,
	options: PackageManagerPathInferenceOptions = {},
): PackageManagerFamily | null {
	if (!executablePath) return null;

	const env = options.env ?? process.env;
	const home = options.home ?? homedir();
	const platform = options.platform ?? process.platform;
	const pathApi = platform === "win32" ? win32 : posix;
	const candidate = normalizeExecutablePath(executablePath, platform);
	const resolved = normalizeExecutablePath(options.realPath ?? executablePath, platform);
	const bunRoot = env.BUN_INSTALL?.trim() || pathApi.join(home, ".bun");
	const bunBinRoot = env.BUN_INSTALL_BIN?.trim() || pathApi.join(bunRoot, "bin");
	const bunGlobalRoot = env.BUN_INSTALL_GLOBAL_DIR?.trim() || pathApi.join(bunRoot, "install", "global");
	const pnpmHome = env.PNPM_HOME?.trim();
	const yarnRoot = env.YARN_GLOBAL_FOLDER?.trim();
	const npmPrefix = env.npm_config_prefix?.trim() ?? env.NPM_CONFIG_PREFIX?.trim();
	const npmBinRoot = npmPrefix ? (platform === "win32" ? npmPrefix : pathApi.join(npmPrefix, "bin")) : null;
	const windowsNpmRoot =
		platform === "win32" ? pathApi.join(env.APPDATA?.trim() || pathApi.join(home, "AppData", "Roaming"), "npm") : null;

	if (
		pathIsWithin(candidate, bunBinRoot, platform) ||
		pathIsWithin(resolved, bunGlobalRoot, platform) ||
		candidate.includes("/.bun/bin/") ||
		resolved.includes("/.bun/install/global/")
	) {
		return "bun";
	}
	if (
		(pnpmHome && pathIsWithin(candidate, pnpmHome, platform)) ||
		candidate.includes("/.pnpm/") ||
		resolved.includes("/.pnpm/") ||
		resolved.includes("/pnpm/global/")
	) {
		return "pnpm";
	}
	if (
		pathIsWithin(candidate, pathApi.join(home, ".yarn", "bin"), platform) ||
		(yarnRoot && pathIsWithin(resolved, yarnRoot, platform)) ||
		candidate.includes("/.yarn/bin/") ||
		resolved.includes("/.config/yarn/global/") ||
		resolved.includes("/.yarn/global/")
	) {
		return "yarn";
	}
	if (
		(npmBinRoot && pathIsWithin(candidate, npmBinRoot, platform)) ||
		(windowsNpmRoot && pathIsWithin(candidate, windowsNpmRoot, platform)) ||
		(windowsNpmRoot && pathIsWithin(resolved, pathApi.join(windowsNpmRoot, "node_modules"), platform)) ||
		resolved.includes("/.npm-global/") ||
		resolved.includes("/lib/node_modules/")
	) {
		return "npm";
	}
	return null;
}
