import { spawnSync } from "node:child_process";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	readlinkSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface DesktopCommandOptions {
	readonly repo?: string;
}

export interface DesktopInstallOptions extends DesktopCommandOptions {
	readonly skipBuild?: boolean;
}

export interface DesktopBuildResult {
	readonly repo: string;
	readonly releaseDir: string;
}

export interface DesktopLinuxInstallResult extends DesktopBuildResult {
	readonly appImage: string;
	readonly binary: string;
	readonly desktopEntry: string;
	readonly icon: string;
}

interface DesktopCommandContext {
	readonly cwd?: string;
	readonly env?: NodeJS.ProcessEnv;
	readonly home?: string;
	readonly platform?: NodeJS.Platform;
	readonly runner?: CommandRunner;
}

interface CommandResult {
	readonly status: number | null;
	readonly signal?: NodeJS.Signals | null;
	readonly error?: Error;
}

type CommandRunner = (
	cmd: string,
	args: readonly string[],
	opts: { readonly cwd: string; readonly env: NodeJS.ProcessEnv },
) => CommandResult;

const defaultRunner: CommandRunner = (cmd, args, opts) =>
	spawnSync(cmd, [...args], {
		cwd: opts.cwd,
		env: opts.env,
		stdio: "inherit",
	});

export function resolveDesktopSourceCheckout(
	repo: string | undefined,
	ctx: Pick<DesktopCommandContext, "cwd" | "env" | "home"> = {},
): string {
	const explicit = repo?.trim() || ctx.env?.SIGNET_SOURCE_DIR?.trim();
	const candidates = explicit
		? [explicit]
		: [
				ctx.cwd ?? process.cwd(),
				dirname(fileURLToPath(import.meta.url)),
				join(ctx.home ?? homedir(), "signet", "signetai"),
				join(ctx.home ?? homedir(), "signet", "signetai4"),
			].flatMap((candidate) => ancestorCandidates(candidate));

	for (const candidate of candidates) {
		const resolved = resolve(candidate);
		if (isDesktopSourceCheckout(resolved)) {
			return resolved;
		}
	}

	const hint = explicit
		? `Not a Signet source checkout: ${resolve(explicit)}`
		: "Could not find a Signet source checkout. Run from the repo root, set SIGNET_SOURCE_DIR, or pass --repo <path>.";
	throw new Error(hint);
}

export function buildDesktopFromSource(
	options: DesktopCommandOptions = {},
	ctx: DesktopCommandContext = {},
): DesktopBuildResult {
	const repo = resolveDesktopSourceCheckout(options.repo, ctx);
	const runner = ctx.runner ?? defaultRunner;
	const env = ctx.env ?? process.env;

	runChecked(runner, "bun", ["install"], repo, env);
	runChecked(runner, "bun", ["run", "build:desktop"], repo, env);

	return { repo, releaseDir: desktopReleaseDir(repo) };
}

export function installDesktopFromSource(
	options: DesktopInstallOptions = {},
	ctx: DesktopCommandContext = {},
): DesktopLinuxInstallResult {
	const repo = resolveDesktopSourceCheckout(options.repo, ctx);
	if (!options.skipBuild) {
		buildDesktopFromSource({ repo }, ctx);
	}

	const platform = ctx.platform ?? process.platform;
	if (platform !== "linux") {
		throw new Error(
			`signet desktop install currently installs native launchers on Linux/Arch only. Build artifacts are in ${desktopReleaseDir(repo)}.`,
		);
	}

	return installLinuxDesktopApp(repo, ctx.home ?? homedir());
}

export function installLinuxDesktopApp(repo: string, home: string): DesktopLinuxInstallResult {
	const releaseDir = desktopReleaseDir(repo);
	const source = findLinuxAppImage(releaseDir, process.arch);
	if (!source) {
		throw new Error(
			`No matching Linux ${process.arch} AppImage found in ${releaseDir}. Run signet desktop build first.`,
		);
	}

	const appDir = join(home, ".local", "share", "signet", "desktop");
	const binDir = join(home, ".local", "bin");
	const applicationsDir = join(home, ".local", "share", "applications");
	const iconsDir = join(home, ".local", "share", "icons", "hicolor", "512x512", "apps");
	mkdirSync(appDir, { recursive: true });
	mkdirSync(binDir, { recursive: true });
	mkdirSync(applicationsDir, { recursive: true });
	mkdirSync(iconsDir, { recursive: true });

	const appImage = join(appDir, "Signet.AppImage");
	copyFileSync(source, appImage);
	chmodSync(appImage, 0o755);

	const icon = join(iconsDir, "signet.png");
	copyFileSync(join(repo, "packages", "desktop", "icons", "icon.png"), icon);

	const binary = join(binDir, "signet-desktop");
	replaceSymlink(binary, appImage);

	const desktopEntry = join(applicationsDir, "signet.desktop");
	writeFileSync(desktopEntry, desktopEntryContent(binary, icon));

	return { repo, releaseDir, appImage, binary, desktopEntry, icon };
}

function ancestorCandidates(path: string): string[] {
	const out: string[] = [];
	let current = resolve(path);
	for (;;) {
		out.push(current);
		const parent = dirname(current);
		if (parent === current) return out;
		current = parent;
	}
}

function isDesktopSourceCheckout(path: string): boolean {
	const rootPkgPath = join(path, "package.json");
	const desktopPkgPath = join(path, "packages", "desktop", "package.json");
	if (!existsSync(rootPkgPath) || !existsSync(desktopPkgPath)) {
		return false;
	}

	const rootPkg = readJson(rootPkgPath);
	const desktopPkg = readJson(desktopPkgPath);
	if (jsonString(rootPkg, "name") !== "signet" || jsonString(desktopPkg, "name") !== "@signet/desktop") {
		return false;
	}

	const workspaces = jsonStringArray(rootPkg, "workspaces");
	return (
		workspaces.includes("packages/*") &&
		workspaces.includes("packages/cli/dashboard") &&
		jsonString(desktopPkg, "main") === "dist/main.js" &&
		jsonString(jsonObject(desktopPkg, "build"), "appId") === "ai.signet.app"
	);
}

function readJson(path: string): unknown {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return null;
	}
}

function jsonObject(value: unknown, key: string): unknown {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const child = Reflect.get(value, key);
	return child && typeof child === "object" && !Array.isArray(child) ? child : null;
}

function jsonString(value: unknown, key: string): string | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const child = Reflect.get(value, key);
	return typeof child === "string" ? child : null;
}

function jsonStringArray(value: unknown, key: string): string[] {
	if (!value || typeof value !== "object" || Array.isArray(value)) return [];
	const child = Reflect.get(value, key);
	return Array.isArray(child) && child.every((item) => typeof item === "string") ? child : [];
}

function desktopReleaseDir(repo: string): string {
	return join(repo, "packages", "desktop", "release");
}

function runChecked(
	runner: CommandRunner,
	cmd: string,
	args: readonly string[],
	cwd: string,
	env: NodeJS.ProcessEnv,
): void {
	const result = runner(cmd, args, { cwd, env });
	if (result.error) {
		throw result.error;
	}
	if (result.status !== 0) {
		const suffix = result.signal ? ` (signal ${result.signal})` : "";
		throw new Error(`${cmd} ${args.join(" ")} failed with exit ${result.status ?? "unknown"}${suffix}`);
	}
}

function findLinuxAppImage(releaseDir: string, arch: string): string | null {
	if (!existsSync(releaseDir)) return null;
	let best: { path: string; mtime: number } | null = null;
	const allowedArchNames = linuxArtifactArchNames(arch);
	for (const entry of readdirSync(releaseDir, { withFileTypes: true })) {
		if (!entry.isFile()) continue;
		const match = /^Signet-.+-linux-([^.]+)\.AppImage$/.exec(entry.name);
		if (!match || !allowedArchNames.has(match[1])) continue;
		const path = join(releaseDir, entry.name);
		const mtime = statSync(path).mtimeMs;
		if (!best || mtime > best.mtime) {
			best = { path, mtime };
		}
	}
	return best?.path ?? null;
}

function linuxArtifactArchNames(arch: string): ReadonlySet<string> {
	switch (arch) {
		case "x64":
			return new Set(["x64", "x86_64", "amd64"]);
		case "arm64":
			return new Set(["arm64", "aarch64"]);
		default:
			return new Set([arch]);
	}
}

function replaceSymlink(path: string, target: string): void {
	try {
		const stat = lstatSync(path);
		if (!stat.isSymbolicLink()) {
			throw new Error(
				`Refusing to replace existing non-symlink launcher at ${path}. Remove it first if it is not needed.`,
			);
		}

		const current = resolve(dirname(path), readlinkSync(path));
		const ownedDir = dirname(target);
		if (current !== target && !current.startsWith(`${ownedDir}/`)) {
			throw new Error(
				`Refusing to replace launcher symlink at ${path} because it does not point at Signet's desktop install directory.`,
			);
		}

		rmSync(path, { force: true });
	} catch (err) {
		const code = err && typeof err === "object" && "code" in err ? err.code : undefined;
		if (code !== "ENOENT") {
			throw err;
		}
	}
	symlinkSync(target, path);
}

function desktopEntryContent(binary: string, icon: string): string {
	return `[Desktop Entry]
Type=Application
Name=Signet
Comment=Local-first identity, memory, and secrets for AI agents
Exec=${quoteDesktopPath(binary)} %U
Icon=${icon}
Terminal=false
Categories=Utility;Development;
StartupWMClass=Signet
`;
}

function quoteDesktopPath(path: string): string {
	return `"${path.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}
