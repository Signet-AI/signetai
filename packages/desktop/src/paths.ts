import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { app } from "electron";

const distDir = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(distDir, "..");
const repoRoot = resolve(appRoot, "../..");

export function appResourcePath(...parts: readonly string[]): string {
	return app.isPackaged ? join(process.resourcesPath, ...parts) : join(appRoot, "resources", ...parts);
}

export function bunPath(): string {
	const bundled = appResourcePath("runtime", process.platform === "win32" ? "bun.exe" : "bun");
	if (existsSync(bundled)) return bundled;
	return process.platform === "win32" ? "bun.exe" : "bun";
}

export function daemonRoot(): string {
	const bundled = appResourcePath("daemon");
	if (existsSync(join(bundled, "dist", "daemon.js"))) return bundled;
	return resolve(repoRoot, "packages/daemon");
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
	const bundled = appResourcePath("icons", name);
	if (existsSync(bundled)) return bundled;
	return join(appRoot, "icons", name);
}

export function preloadPath(): string {
	return join(distDir, "preload.js");
}
