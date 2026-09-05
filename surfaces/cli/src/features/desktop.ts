import { spawnSync } from "node:child_process";
import {
	chmodSync,
	closeSync,
	copyFileSync,
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	readSync,
	readdirSync,
	readlinkSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveWorkspaceSourceRepoPath, syncWorkspaceSourceRepo } from "@signet/core";
import { resolveAgentsDir } from "../lib/workspace.js";

export interface DesktopCommandOptions {
	readonly repo?: string;
	readonly skipSourceSync?: boolean;
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
	readonly workspace: string;
}

export interface DesktopMacInstallResult extends DesktopBuildResult {
	readonly appBundle: string;
	readonly applicationsDir: string;
	readonly workspace: string;
}

export type DesktopInstallResult = DesktopLinuxInstallResult | DesktopMacInstallResult;

interface DesktopCommandContext {
	readonly cwd?: string;
	readonly env?: NodeJS.ProcessEnv;
	readonly home?: string;
	readonly platform?: NodeJS.Platform;
	readonly runner?: CommandRunner;
	readonly syncWorkspaceSourceRepo?: typeof syncWorkspaceSourceRepo;
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
	const candidates = explicit ? [explicit] : desktopSourceCheckoutCandidates(ctx);

	for (const candidate of candidates) {
		const resolved = resolve(candidate);
		if (isDesktopSourceCheckout(resolved)) {
			return resolved;
		}
	}

	const hint = explicit
		? `Not a Signet source checkout: ${resolve(explicit)}`
		: "Could not find a Signet source checkout. Run from the repo root, set SIGNET_SOURCE_DIR, pass --repo <path>, or keep the checkout at <configured Signet workspace>/signetai.";
	throw new Error(hint);
}

function desktopSourceCheckoutCandidates(ctx: Pick<DesktopCommandContext, "cwd" | "env">): string[] {
	const seen = new Set<string>();
	const candidates = [
		resolveWorkspaceSourceRepoPath(resolveAgentsDir(ctx.env ?? process.env).path),
		...[ctx.cwd ?? process.cwd(), dirname(fileURLToPath(import.meta.url))].flatMap((candidate) =>
			ancestorCandidates(candidate),
		),
	];
	return candidates.filter((candidate) => {
		const resolved = resolve(candidate);
		if (seen.has(resolved)) return false;
		seen.add(resolved);
		return true;
	});
}

function prepareDesktopSourceCheckout(options: DesktopCommandOptions, ctx: DesktopCommandContext): string {
	const env = ctx.env ?? process.env;
	const explicit = options.repo?.trim() || env.SIGNET_SOURCE_DIR?.trim();
	if (explicit || options.skipSourceSync) return resolveDesktopSourceCheckout(options.repo, ctx);

	const workspace = resolveAgentsDir(env).path;
	const sync = (ctx.syncWorkspaceSourceRepo ?? syncWorkspaceSourceRepo)(workspace, { cloneIfMissing: true });
	if (!["cloned", "pulled", "current"].includes(sync.status)) {
		throw new Error(`Could not update Signet source checkout before desktop build: ${sync.message}`);
	}
	return sync.path;
}

export function buildDesktopFromSource(
	options: DesktopCommandOptions = {},
	ctx: DesktopCommandContext = {},
): DesktopBuildResult {
	const repo = prepareDesktopSourceCheckout(options, ctx);
	const runner = ctx.runner ?? defaultRunner;
	const env = ctx.env ?? process.env;

	runChecked(runner, "bun", ["install"], repo, env);
	runChecked(runner, "bun", ["run", "build:desktop"], repo, env);

	return { repo, releaseDir: desktopReleaseDir(repo) };
}

export function installDesktopFromSource(
	options: DesktopInstallOptions = {},
	ctx: DesktopCommandContext = {},
): DesktopInstallResult {
	const repo = options.skipBuild
		? resolveDesktopSourceCheckout(options.repo, ctx)
		: prepareDesktopSourceCheckout(options, ctx);
	const workspace = resolveAgentsDir(ctx.env ?? process.env).path;
	if (!options.skipBuild) {
		buildDesktopFromSource({ repo, skipSourceSync: true }, ctx);
	}

	const platform = ctx.platform ?? process.platform;
	if (platform === "darwin") {
		return installMacDesktopApp(repo, ctx.home ?? homedir(), workspace);
	}
	if (platform !== "linux") {
		throw new Error(
			`signet desktop install supports macOS and Linux installs. Build artifacts are in ${desktopReleaseDir(repo)}.`,
		);
	}

	return installLinuxDesktopApp(repo, ctx.home ?? homedir(), workspace);
}

const MAC_APP_MARKER = "ai.signet.app";

export function installMacDesktopApp(
	repo: string,
	home: string,
	workspace = resolveAgentsDir().path,
): DesktopMacInstallResult {
	const releaseDir = desktopReleaseDir(repo);
	const source = findMacAppBundle(releaseDir, process.arch);
	if (!source) {
		throw new Error(
			`No matching macOS ${process.arch} app bundle found in ${releaseDir}. Run signet desktop build first.`,
		);
	}

	const applicationsDir = join(home, "Applications");
	mkdirSync(applicationsDir, { recursive: true });
	const appBundle = join(applicationsDir, "Signet.app");
	replaceManagedAppBundle(source, appBundle);

	return { repo, releaseDir, appBundle, applicationsDir, workspace };
}

/**
 * Replaces an installed Signet.app through a staged swap. A pre-existing bundle
 * is only removed when it is Signet-owned (matching bundle id in its
 * Info.plist); foreign applications are never touched.
 */
function replaceManagedAppBundle(source: string, target: string): void {
	if (existsSync(target)) {
		if (!isSignetAppBundle(target)) {
			throw new Error(
				`Refusing to replace existing app at ${target} because it is not a Signet app bundle. Remove it first if it is not needed.`,
			);
		}
		rmSync(target, { recursive: true, force: true });
	}
	const parent = dirname(target);
	const tmp = join(parent, `.Signet.app.${process.pid}.${Date.now()}.tmp`);
	try {
		cpSync(source, tmp, { recursive: true });
		renameSync(tmp, target);
	} catch (err) {
		rmSync(tmp, { recursive: true, force: true });
		throw err;
	}
}

function isSignetAppBundle(path: string): boolean {
	try {
		const plist = readFileSync(join(path, "Contents", "Info.plist"), "utf8");
		return plist.includes(`<string>${MAC_APP_MARKER}</string>`);
	} catch {
		return false;
	}
}

function findMacAppBundle(releaseDir: string, arch: string): string | null {
	if (!existsSync(releaseDir)) return null;
	let best: { path: string; mtime: number } | null = null;
	// electron-builder's unpacked output lives in layout directories such as
	// release/mac/Signet.app or release/mac_arm64/Signet.app; recurse to a
	// bounded depth and verify the executable's Mach-O architecture so a
	// foreign-arch artifact is never installed.
	for (const candidate of macAppBundleCandidates(releaseDir, 3)) {
		if (!isSignetAppBundle(candidate)) continue;
		if (!macAppBundleMatchesArch(candidate, arch)) continue;
		const mtime = statSync(candidate).mtimeMs;
		if (!best || mtime > best.mtime) {
			best = { path: candidate, mtime: mtime };
		}
	}
	return best?.path ?? null;
}

function* macAppBundleCandidates(root: string, depth: number): Generator<string> {
	if (depth < 0) return;
	let entries: readonly import("node:fs").Dirent[];
	try {
		entries = readdirSync(root, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const path = join(root, entry.name);
		if (entry.name.endsWith(".app")) {
			yield path;
			continue;
		}
		if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
		yield* macAppBundleCandidates(path, depth - 1);
	}
}

/** Reads the Mach-O cputype from the bundle's main executable. */
function macAppBundleMatchesArch(path: string, arch: string): boolean {
	const executable = macBundleExecutable(path);
	if (executable === null) return false;
	let handle: number;
	try {
		handle = openSync(executable, "r");
	} catch {
		return false;
	}
	try {
		const header = Buffer.alloc(8);
		if (readSync(handle, header, 0, 8, 0) !== 8) return false;
		// The first 4 bytes are the magic; cputype follows. Byte-swapped
		// (CIGAM) forms mean the file was written in the opposite endianness
		// from the reader, so swap when reading the cputype field.
		const magicLE = header.readUInt32LE(0);
		const magicBE = header.readUInt32BE(0);
		const CPU_TYPE_X64 = 0x01000007;
		const CPU_TYPE_ARM64 = 0x0100000c;
		const expected = arch === "arm64" ? CPU_TYPE_ARM64 : CPU_TYPE_X64;
		if (magicLE === 0xfeedfacf) return header.readUInt32LE(4) === expected;
		if (magicBE === 0xfeedfacf) return header.readUInt32BE(4) === expected;
		return false;
	} finally {
		closeSync(handle);
	}
}

function macBundleExecutable(path: string): string | null {
	try {
		const plist = readFileSync(join(path, "Contents", "Info.plist"), "utf8");
		const match = /<key>CFBundleExecutable<\/key>\s*<string>([^<]+)<\/string>/.exec(plist);
		return match ? join(path, "Contents", "MacOS", match[1]) : null;
	} catch {
		return null;
	}
}

export function installLinuxDesktopApp(
	repo: string,
	home: string,
	workspace = resolveAgentsDir().path,
): DesktopLinuxInstallResult {
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
	installManagedAppImage(source, appImage);

	const icon = join(iconsDir, "signet.png");
	copyFileSync(join(repo, "surfaces", "desktop", "icons", "icon.png"), icon);

	const binary = join(binDir, "signet-desktop");
	writeManagedLauncher(binary, appImage, workspace);

	const desktopEntry = join(applicationsDir, "signet.desktop");
	writeFileSync(desktopEntry, desktopEntryContent(binary, icon));

	return { repo, releaseDir, appImage, binary, desktopEntry, icon, workspace };
}

function installManagedAppImage(source: string, target: string): void {
	const dir = dirname(target);
	const tmp = join(dir, `.Signet.AppImage.${process.pid}.${Date.now()}.tmp`);
	try {
		rmSync(tmp, { force: true });
		copyFileSync(source, tmp);
		chmodSync(tmp, 0o755);
		renameSync(tmp, target);
		chmodSync(target, 0o755);
	} catch (err) {
		rmSync(tmp, { force: true });
		throw err;
	}
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
	const desktopPkgPath = join(path, "surfaces", "desktop", "package.json");
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
		workspaces.includes("platform/*") &&
		workspaces.includes("surfaces/*") &&
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
	return join(repo, "surfaces", "desktop", "release");
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

const MANAGED_LAUNCHER_MARKER = "# signet-desktop managed launcher";

function writeManagedLauncher(path: string, target: string, workspace: string): void {
	const appDir = dirname(target);
	try {
		const stat = lstatSync(path);
		if (stat.isSymbolicLink()) {
			const current = resolve(dirname(path), readlinkSync(path));
			if (current !== target && !current.startsWith(`${appDir}/`)) {
				throw new Error(
					`Refusing to replace launcher symlink at ${path} because it does not point at Signet's desktop install directory.`,
				);
			}
			rmSync(path, { force: true });
		} else if (readFileSync(path, "utf8").includes(MANAGED_LAUNCHER_MARKER)) {
			rmSync(path, { force: true });
		} else {
			throw new Error(
				`Refusing to replace existing non-managed launcher at ${path}. Remove it first if it is not needed.`,
			);
		}
	} catch (err) {
		const code = err && typeof err === "object" && "code" in err ? err.code : undefined;
		if (code !== "ENOENT") {
			throw err;
		}
	}
	writeFileSync(path, launcherContent(target, workspace), { mode: 0o755 });
	chmodSync(path, 0o755);
}

function launcherContent(target: string, workspace: string): string {
	return `#!/usr/bin/env sh
${MANAGED_LAUNCHER_MARKER}
export SIGNET_PATH=${quoteShellPath(workspace)}
export SIGNET_WORKSPACE="$SIGNET_PATH"
exec ${quoteShellPath(target)} "$@"
`;
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

function quoteShellPath(path: string): string {
	return `'${path.replaceAll("'", "'\\''")}'`;
}
