import { dirname, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveRuntimeAsset, resolveRuntimeAssetDirectory } from "@signet/core";
import { app } from "electron";

const distDir = dirname(fileURLToPath(import.meta.url));
const appRoot = normalize(resolve(distDir, ".."));

function assertSafePath(base: string, target: string): string {
	const normalized = normalize(target);
	const rel = relative(normalize(base), normalized);
	if (rel.startsWith("..") || resolve(rel) === rel) {
		throw new Error(`Path traversal blocked: ${target} escapes ${base}`);
	}
	return normalized;
}

export function appResourcePath(...parts: readonly string[]): string {
	const base = app.isPackaged ? process.resourcesPath : join(appRoot, "resources");
	return assertSafePath(base, join(base, ...parts));
}

export function bunPath(): string {
	const executable = process.platform === "win32" ? "bun.exe" : "bun";
	return resolveRuntimeAsset(appResourcePath("runtime", executable), import.meta.url);
}

export function daemonRoot(): string {
	return resolveRuntimeAssetDirectory(appResourcePath("daemon"), import.meta.url);
}

export function daemonEntry(): string {
	return resolveRuntimeAsset(join(daemonRoot(), "dist", "daemon.js"), import.meta.url);
}

export function dashboardRoot(): string {
	return join(daemonRoot(), "dashboard");
}

export function dashboardIndex(): string {
	return join(dashboardRoot(), "index.html");
}

export function iconPath(name: string): string {
	const sanitized = name.replace(/[/\\]/g, "");
	const target = app.isPackaged
		? appResourcePath("icons", sanitized)
		: assertSafePath(appRoot, join(appRoot, "icons", sanitized));
	return resolveRuntimeAsset(target, import.meta.url);
}

export function preloadPath(): string {
	return assertSafePath(distDir, join(distDir, "preload.cjs"));
}
