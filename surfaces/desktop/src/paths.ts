import { existsSync } from "node:fs";
import { dirname, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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

export function daemonRoot(): string {
	return appResourcePath("rust-daemon");
}

export function daemonEntry(): string {
	const executable = process.platform === "win32" ? "signet-daemon.exe" : "signet-daemon";
	return join(daemonRoot(), `${process.platform}-${process.arch}`, executable);
}

export function dashboardRoot(): string {
	return join(daemonRoot(), "dashboard");
}

export function dashboardIndex(): string {
	return join(dashboardRoot(), "index.html");
}

export function iconPath(name: string): string {
	const sanitized = name.replace(/[/\\]/g, "");
	const bundled = appResourcePath("icons", sanitized);
	if (existsSync(bundled)) return bundled;
	return assertSafePath(appRoot, join(appRoot, "icons", sanitized));
}

export function preloadPath(): string {
	return assertSafePath(distDir, join(distDir, "preload.cjs"));
}
