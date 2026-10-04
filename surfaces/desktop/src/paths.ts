import { existsSync } from "node:fs";
import { dirname, join, normalize, relative, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveLaunchdExecutable } from "@signet/core";
import { app } from "electron";

const distDir = dirname(fileURLToPath(import.meta.url));
const appRoot = normalize(resolve(distDir, ".."));
const repoRoot = normalize(resolve(appRoot, "../.."));

interface BunPathInput {
	readonly bundled: string;
	readonly platform?: NodeJS.Platform;
	readonly environment?: NodeJS.ProcessEnv;
	readonly home?: string;
	readonly exists?: (path: string) => boolean;
}

function windowsBunFallback(environment: NodeJS.ProcessEnv, home: string, exists: (path: string) => boolean): string {
	const userProfile = environment.USERPROFILE?.trim() || environment.HOME?.trim() || home;
	const localAppData = environment.LOCALAPPDATA?.trim() || win32.join(userProfile, "AppData", "Local");
	const bunInstall = environment.BUN_INSTALL?.trim();
	const candidates = [
		...(bunInstall ? [win32.join(bunInstall, "bin", "bun.exe")] : []),
		win32.join(userProfile, ".bun", "bin", "bun.exe"),
		win32.join(localAppData, "bun", "bin", "bun.exe"),
	];
	return candidates.find(exists) ?? win32.join(userProfile, ".bun", "bin", "bun.exe");
}

export function resolveBunPath({
	bundled,
	platform = process.platform,
	environment = process.env,
	home = process.env.HOME ?? "",
	exists = existsSync,
}: BunPathInput): string {
	if (exists(bundled)) return bundled;
	if (platform === "win32") return windowsBunFallback(environment, home, exists);
	return resolveLaunchdExecutable("bun", { environment, home });
}

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
	return resolveBunPath({ bundled: appResourcePath("runtime", executable) });
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
