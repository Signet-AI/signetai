import { homedir } from "node:os";
import { join, normalize, sep } from "node:path";

function stripTrailingSeparator(path) {
	const normalized = normalize(path);
	return normalized.length > 1 && normalized.endsWith(sep) ? normalized.slice(0, -1) : normalized;
}

function containsPath(root, path) {
	const normalizedRoot = stripTrailingSeparator(root);
	const normalizedPath = stripTrailingSeparator(path);
	return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}${sep}`);
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

export function isBunGlobalPackageDir(packageDir, env = process.env, homeDir = homedir()) {
	return bunGlobalPackageRoots(env, homeDir).some((root) => containsPath(root, packageDir));
}

export function shouldRunCliWithBun({
	isBunRuntime,
	packageDir,
	bunAvailable,
	env = process.env,
	homeDir = homedir(),
}) {
	return !isBunRuntime && bunAvailable && isBunGlobalPackageDir(packageDir, env, homeDir);
}
