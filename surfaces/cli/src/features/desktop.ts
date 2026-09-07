import { spawnSyncHidden as spawnSync } from "@signet/core";
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
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
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

export interface DesktopWindowsInstallResult extends DesktopBuildResult {
	readonly appDir: string;
	readonly executable: string;
	readonly programsDir: string;
	readonly workspace: string;
}

export type DesktopInstallResult = DesktopLinuxInstallResult | DesktopMacInstallResult | DesktopWindowsInstallResult;

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
	const home = ctx.home ?? homedir();
	if (platform === "darwin") {
		return installMacDesktopApp(repo, home, workspace);
	}
	if (platform === "win32") {
		const localAppData = ctx.env?.LOCALAPPDATA?.trim() || join(home, "AppData", "Local");
		return installWindowsDesktopApp(repo, home, workspace, localAppData);
	}
	if (platform !== "linux") {
		throw new Error(
			`signet desktop install supports macOS, Windows, and Linux installs. Build artifacts are in ${desktopReleaseDir(repo)}.`,
		);
	}

	return installLinuxDesktopApp(repo, home, workspace);
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
	replaceManagedPath(
		source,
		appBundle,
		isSignetAppBundle,
		(sourcePath, temporaryPath) => cpSync(sourcePath, temporaryPath, { recursive: true }),
		"app",
	);

	return { repo, releaseDir, appBundle, applicationsDir, workspace };
}

/**
 * Install the unpacked Windows build into a user-owned program directory.
 * The directory is intentionally distinct from the native CLI's
 * %LOCALAPPDATA%\\Programs\\Signet\\signet.exe path.
 */
export function installWindowsDesktopApp(
	repo: string,
	home: string,
	workspace = resolveAgentsDir().path,
	localAppData = join(home, "AppData", "Local"),
): DesktopWindowsInstallResult {
	const releaseDir = desktopReleaseDir(repo);
	const source = findWindowsAppDirectory(releaseDir, process.arch);
	if (!source) {
		throw new Error(
			`No matching Windows ${process.arch} app directory found in ${releaseDir}. Run signet desktop build first.`,
		);
	}

	const programsDir = join(localAppData, "Programs");
	const appDir = join(programsDir, "Signet Desktop");
	mkdirSync(programsDir, { recursive: true });
	replaceManagedPath(
		source,
		appDir,
		isSignetWindowsAppDirectory,
		(sourcePath, temporaryPath) => cpSync(sourcePath, temporaryPath, { recursive: true }),
		"Windows app directory",
	);

	const executable = windowsAppExecutable(appDir);
	if (!executable) {
		throw new Error(`Installed Windows Signet app is missing its executable at ${appDir}.`);
	}
	return { repo, releaseDir, appDir, executable, programsDir, workspace };
}

/**
 * Replace a managed file or directory without deleting the previous install
 * until the replacement has been copied successfully. The temporary and
 * backup paths stay beside the target so directory renames remain atomic on
 * the same filesystem on both macOS and Windows.
 */
function replaceManagedPath(
	source: string,
	target: string,
	isManaged: (path: string) => boolean,
	copy: (source: string, target: string) => void,
	kind: string,
): void {
	if (existsSync(target) && !isManaged(target)) {
		throw new Error(
			`Refusing to replace existing ${kind} at ${target} because it is not a Signet app. Remove it first if it is not needed.`,
		);
	}

	const parent = dirname(target);
	const token = `${process.pid}.${Date.now()}`;
	const temporary = join(parent, `.Signet.${kind}.${token}.tmp`);
	const backup = `${target}.previous-${token}`;
	let backupCreated = false;
	try {
		rmSync(temporary, { recursive: true, force: true });
		copy(source, temporary);
		if (existsSync(target)) {
			renameSync(target, backup);
			backupCreated = true;
		}
		try {
			renameSync(temporary, target);
		} catch (swapError) {
			if (backupCreated) {
				try {
					renameSync(backup, target);
					backupCreated = false;
				} catch (restoreError) {
					throw restoreError instanceof Error
						? new Error(
								`Failed to restore the previous Signet ${kind} after a failed install: ${restoreError.message}`,
								{
									cause: swapError,
								},
							)
						: restoreError;
				}
			}
			throw swapError;
		}
	} catch (error) {
		rmSync(temporary, { recursive: true, force: true });
		throw error;
	}

	if (backupCreated) {
		try {
			rmSync(backup, { recursive: true, force: true });
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			throw new Error(`Signet ${kind} installed, but removing the previous install failed: ${detail}`, {
				cause: error,
			});
		}
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
	// Electron-builder's unpacked output lives in layout directories such as
	// release/mac/Signet.app or release/mac_arm64/Signet.app. Recurse only a
	// bounded depth and verify the executable's Mach-O architecture so a
	// foreign-arch artifact is never installed.
	return findNewestCandidate(
		releaseDir,
		macAppBundleCandidates(releaseDir, 3),
		(candidate) => isSignetAppBundle(candidate) && macAppBundleMatchesArch(candidate, arch),
	);
}

function findNewestCandidate(
	releaseDir: string,
	candidates: Iterable<string>,
	matches: (path: string) => boolean,
): string | null {
	if (!existsSync(releaseDir)) return null;
	let best: { path: string; mtime: number } | null = null;
	for (const candidate of candidates) {
		if (!matches(candidate)) continue;
		try {
			const mtime = statSync(candidate).mtimeMs;
			if (!best || mtime > best.mtime) best = { path: candidate, mtime };
		} catch {
			// The release directory can change while a build is being cleaned up.
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

const WINDOWS_PACKAGE_MARKERS = [Buffer.from('"name": "@signet/desktop"'), Buffer.from('"name":"@signet/desktop"')];

function isSignetWindowsAppDirectory(path: string): boolean {
	const executable = windowsAppExecutable(path);
	if (!executable) return false;
	const asar = join(path, "resources", "app.asar");
	try {
		const contents = readFileSync(asar);
		if (WINDOWS_PACKAGE_MARKERS.some((marker) => contents.includes(marker))) return true;
	} catch {
		// An unpacked Electron directory can expose app/package.json instead of
		// app.asar during local builds.
	}
	try {
		const packageJson = readJson(join(path, "resources", "app", "package.json"));
		return jsonString(packageJson, "name") === "@signet/desktop";
	} catch {
		return false;
	}
}

function windowsAppExecutable(path: string): string | null {
	try {
		const entry = readdirSync(path, { withFileTypes: true }).find(
			(candidate) => candidate.isFile() && candidate.name.toLowerCase() === "signet.exe",
		);
		return entry ? join(path, entry.name) : null;
	} catch {
		return null;
	}
}

function findWindowsAppDirectory(releaseDir: string, arch: string): string | null {
	return findNewestCandidate(
		releaseDir,
		windowsAppDirectoryCandidates(releaseDir, 3),
		(candidate) => isSignetWindowsAppDirectory(candidate) && windowsAppDirectoryMatchesArch(candidate, arch),
	);
}

function* windowsAppDirectoryCandidates(root: string, depth: number): Generator<string> {
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
		if (entry.name.toLowerCase().endsWith("-unpacked")) {
			yield path;
			continue;
		}
		if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
		yield* windowsAppDirectoryCandidates(path, depth - 1);
	}
}

function windowsAppDirectoryMatchesArch(path: string, arch: string): boolean {
	const executable = windowsAppExecutable(path);
	if (!executable) return false;
	let handle: number;
	try {
		handle = openSync(executable, "r");
	} catch {
		return false;
	}
	try {
		const header = Buffer.alloc(4096);
		const bytesRead = readSync(handle, header, 0, header.length, 0);
		if (bytesRead < 0x40 || header.toString("ascii", 0, 2) !== "MZ") return false;
		const peOffset = header.readUInt32LE(0x3c);
		if (peOffset + 6 > bytesRead || header.toString("ascii", peOffset, peOffset + 4) !== "PE\u0000\u0000") {
			return false;
		}
		const machine = header.readUInt16LE(peOffset + 4);
		if (arch === "x64") return machine === 0x8664;
		if (arch === "arm64") return machine === 0xaa64 || machine === 0xa641;
		if (arch === "ia32") return machine === 0x014c;
		if (arch === "arm") return machine === 0x01c4;
		return false;
	} finally {
		closeSync(handle);
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
	const binary = join(binDir, "signet-desktop");
	installManagedAppImage(source, appImage, binary);

	const icon = join(iconsDir, "signet.png");
	copyFileSync(join(repo, "surfaces", "desktop", "icons", "icon.png"), icon);

	writeManagedLauncher(binary, appImage, workspace);

	const desktopEntry = join(applicationsDir, "signet.desktop");
	writeFileSync(desktopEntry, desktopEntryContent(binary, icon));

	return { repo, releaseDir, appImage, binary, desktopEntry, icon, workspace };
}

function installManagedAppImage(source: string, target: string, launcher: string): void {
	replaceManagedPath(
		source,
		target,
		() => isManagedAppImage(target, launcher),
		(sourcePath, temporaryPath) => {
			copyFileSync(sourcePath, temporaryPath);
			chmodSync(temporaryPath, 0o755);
		},
		"AppImage",
	);
	chmodSync(target, 0o755);
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

function isManagedAppImage(target: string, launcher: string): boolean {
	try {
		const stat = lstatSync(launcher);
		if (stat.isSymbolicLink()) {
			return resolve(dirname(launcher), readlinkSync(launcher)) === resolve(target);
		}
		return readFileSync(launcher, "utf8").includes(MANAGED_LAUNCHER_MARKER);
	} catch {
		return false;
	}
}

function writeManagedLauncher(path: string, target: string, workspace: string): void {
	const appDir = dirname(target);
	try {
		const stat = lstatSync(path);
		if (stat.isSymbolicLink()) {
			const current = resolve(dirname(path), readlinkSync(path));
			if (current !== resolve(target) && !isPathWithin(appDir, current)) {
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

function isPathWithin(parent: string, child: string): boolean {
	const relativePath = relative(resolve(parent), resolve(child));
	return (
		relativePath === "" || (relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))
	);
}
