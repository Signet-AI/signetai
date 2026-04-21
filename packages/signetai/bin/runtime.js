import { homedir } from "node:os";
import { join, normalize } from "node:path";

function stripTrailingSeparator(path) {
	const normalized = normalize(path.replaceAll("\\", "/")).replaceAll("\\", "/");
	return normalized.length > 1 && normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}

function caseInsensitivePathPlatform(platform) {
	return platform === "darwin" || platform === "win32";
}

function comparablePath(path, platform) {
	const normalized = stripTrailingSeparator(path);
	return caseInsensitivePathPlatform(platform) ? normalized.toLowerCase() : normalized;
}

function containsPath(root, path, platform) {
	const normalizedRoot = comparablePath(root, platform);
	const normalizedPath = comparablePath(path, platform);
	return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`);
}

export function bunGlobalPackageRoots(env = process.env, homeDir = homedir()) {
	const roots = [];
	const bunInstall = typeof env.BUN_INSTALL === "string" ? env.BUN_INSTALL.trim() : "";

	if (bunInstall) {
		roots.push(join(bunInstall, "install", "global", "node_modules", "signetai"));
	}

	roots.push(join(homeDir, ".bun", "install", "global", "node_modules", "signetai"));

	return Array.from(new Set(roots.map(stripTrailingSeparator)));
}

export function isBunGlobalPackageDir(packageDir, env = process.env, homeDir = homedir(), platform = process.platform) {
	return bunGlobalPackageRoots(env, homeDir).some((root) => containsPath(root, packageDir, platform));
}

export function shouldRunCliWithBun({
	isBunRuntime,
	packageDir,
	bunAvailable,
	env = process.env,
	homeDir = homedir(),
	platform = process.platform,
}) {
	return !isBunRuntime && bunAvailable && isBunGlobalPackageDir(packageDir, env, homeDir, platform);
}
