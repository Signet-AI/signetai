import { statSync, existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function modulePath(origin: string | URL): string {
	return origin instanceof URL || origin.startsWith("file:") ? fileURLToPath(origin) : resolve(origin);
}

export function resolveRuntimePackageRoot(origin: string | URL): string {
	let directory = dirname(modulePath(origin));
	for (let depth = 0; depth < 12; depth++) {
		if (existsSync(join(directory, "package.json"))) return directory;
		const parent = dirname(directory);
		if (parent === directory) break;
		directory = parent;
	}
	throw new Error(`Missing runtime package metadata for ${String(origin)}`);
}

function requireAsset(path: string, name: string, directory: boolean): string {
	const info = statSync(path, { throwIfNoEntry: false });
	if (!info || (directory ? !info.isDirectory() : !info.isFile())) {
		throw new Error(`Missing runtime asset ${name}: ${path}`);
	}
	return path;
}

function validateName(name: string): void {
	if (!name || name.includes("\0") || (!isAbsolute(name) && name.split(/[\\/]/).includes(".."))) {
		throw new TypeError(`Invalid runtime asset name: ${name}`);
	}
	if (/\.tsx?$/.test(name)) throw new TypeError(`Runtime assets must be built, not source files: ${name}`);
}

export function resolveRuntimeAsset(name: string, origin: string | URL): string {
	validateName(name);
	const path = isAbsolute(name) ? name : join(resolveRuntimePackageRoot(origin), "dist", name);
	return requireAsset(path, name, false);
}

export function resolveRuntimeAssetDirectory(name: string, origin: string | URL): string {
	validateName(name);
	const path = isAbsolute(name) ? name : join(resolveRuntimePackageRoot(origin), name);
	return requireAsset(path, name, true);
}
