import { existsSync } from "node:fs";
import { dirname, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { app } from "electron";

const distDir = dirname(fileURLToPath(import.meta.url));
const appRoot = normalize(resolve(distDir, ".."));
const repoRoot = normalize(resolve(appRoot, "../.."));

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
	const bundled = appResourcePath("runtime", executable);
	if (existsSync(bundled)) return bundled;
	return executable;
}

export function daemonRoot(): string {
	const bundled = appResourcePath("daemon");
	if (existsSync(join(bundled, "dist", "daemon.js"))) return bundled;
	return assertSafePath(repoRoot, resolve(repoRoot, "platform/daemon"));
}

export function daemonEntry(): string {
	return join(daemonRoot(), "dist", "daemon.js");
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
