import { spawnSyncHidden as spawnSync } from "@signet/core";
import { createHash } from "node:crypto";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import chalk from "chalk";

export interface NativeInstallOptions {
	readonly binDir?: string;
	readonly force?: boolean;
	readonly json?: boolean;
	readonly connectorAssets?: string;
	readonly daemonJsAssets?: string;
}

export interface NativeInstallResult {
	readonly source: string;
	readonly target: string;
	readonly installed: boolean;
	readonly pathHint: string | null;
	readonly pathProfile: string | null;
	readonly pathPersisted: boolean;
	readonly connectorAssetsDir: string | null;
	readonly daemonJsAssetsDir: string | null;
}

function isRuntimeExecutable(path: string): boolean {
	const name = basename(path).toLowerCase();
	return name === "bun" || name === "bun.exe" || name === "node" || name === "node.exe";
}

function defaultBinDir(): string {
	if (process.platform === "win32") {
		return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "Programs", "Signet");
	}
	return join(homedir(), ".local", "bin");
}

function binaryName(): string {
	return process.platform === "win32" ? "signet.exe" : "signet";
}

function normalizePathEntry(value: string, platform: NodeJS.Platform): string {
	const normalized = platform === "win32" ? value.replaceAll("\\", "/").toLowerCase() : value.replaceAll("\\", "/");
	return normalized.replace(/\/+$/, "");
}

function pathContains(dir: string, pathValue = process.env.PATH ?? "", platform = process.platform): boolean {
	const separator = platform === "win32" ? ";" : ":";
	const normalize = (value: string): string => normalizePathEntry(value, platform);
	return pathValue.split(separator).some((entry) => normalize(entry) === normalize(dir));
}

function shellProfilePath(home: string, shell: string | undefined, platform: NodeJS.Platform): string | null {
	if (platform === "win32") return null;
	const shellName = shell ? basename(shell).toLowerCase() : "";
	if (shellName === "zsh") return join(home, ".zprofile");
	if (shellName === "bash") {
		const bashProfiles = [".bash_profile", ".bash_login", ".profile"];
		return (
			bashProfiles.map((profile) => join(home, profile)).find((profile) => existsSync(profile)) ??
			join(home, ".bash_profile")
		);
	}
	if (platform === "darwin" && shellName === "") return join(home, ".zprofile");
	return null;
}

function shellPathEntry(binDir: string, home: string, platform: NodeJS.Platform): string {
	const homeBinDir = join(home, ".local", "bin");
	if (normalizePathEntry(binDir, platform) === normalizePathEntry(homeBinDir, platform)) return "$HOME/.local/bin";
	return binDir.replaceAll('"', '\\"');
}

function profileContainsPath(contents: string, binDir: string, home: string, platform: NodeJS.Platform): boolean {
	const normalizedDir = normalizePathEntry(binDir, platform);
	const isDefaultBinDir = normalizedDir === normalizePathEntry(join(home, ".local", "bin"), platform);
	return contents.split(/\r?\n/).some((line) => {
		const trimmed = line.trim();
		if (trimmed.startsWith("#") || !/^(?:export\s+)?PATH\s*=/.test(trimmed)) return false;
		const assignment = trimmed.replace(/^(?:export\s+)?PATH\s*=\s*/, "").replace(/^["']|["']$/g, "");
		const containsRequestedDir = assignment
			.split(":")
			.some((entry) => normalizePathEntry(entry.trim(), platform) === normalizedDir);
		if (containsRequestedDir) return true;
		const homeBinDirAliases = ["$HOME/.local/bin", "$" + "{HOME}/.local/bin", "~/.local/bin"];
		return (
			isDefaultBinDir &&
			homeBinDirAliases.some((alias) => assignment.split(":").some((entry) => entry.trim() === alias))
		);
	});
}

export interface NativeInstallPathOptions {
	readonly home?: string;
	readonly shell?: string;
	readonly platform?: NodeJS.Platform;
	readonly pathValue?: string;
	readonly interactive?: boolean;
}

export interface NativeInstallPathResult {
	readonly profilePath: string | null;
	readonly persisted: boolean;
}

export function persistNativeInstallPath(
	binDir: string,
	options: NativeInstallPathOptions = {},
): NativeInstallPathResult {
	const home = options.home ?? homedir();
	const platform = options.platform ?? process.platform;
	const profilePath = shellProfilePath(home, options.shell ?? process.env.SHELL, platform);
	if (options.interactive === false || pathContains(binDir, options.pathValue, platform) || profilePath === null) {
		return { profilePath: null, persisted: false };
	}

	let contents = "";
	try {
		if (existsSync(profilePath)) contents = readFileSync(profilePath, "utf8");
		if (!profileContainsPath(contents, binDir, home, platform)) {
			const entry = shellPathEntry(binDir, home, platform);
			const prefix = contents.length > 0 && !contents.endsWith("\n") ? "\n" : "";
			writeFileSync(profilePath, `${contents}${prefix}export PATH="${entry}:$PATH"\n`, "utf8");
		}
		return { profilePath, persisted: true };
	} catch {
		return { profilePath, persisted: false };
	}
}

function verifySha256(path: string, expected: string): void {
	const actual = createHash("sha256").update(readFileSync(path)).digest("hex").toLowerCase();
	if (actual !== expected.toLowerCase()) {
		throw new Error(`SHA-256 mismatch for ${path}: expected ${expected.toLowerCase()}, got ${actual}`);
	}
}

function extractConnectorAssets(archivePath: string, extractRoot: string): void {
	mkdirSync(extractRoot, { recursive: true });
	// Tarballs are produced by `scripts/build-connector-assets.ts` with a
	// `runtime/connectors/<harness>/...` layout, so we extract to the
	// runtime root and let the tarball's own `runtime/` prefix land
	// naturally at `<extractRoot>/runtime/connectors/...`.
	const result = spawnSync("tar", ["xzf", archivePath, "-C", extractRoot], { stdio: "inherit" });
	if (result.status !== 0) {
		throw new Error(`tar extraction failed with status ${result.status ?? "unknown"}`);
	}
}

/**
 * Install connector plugin assets (e.g. the Hermes Python memory
 * provider) alongside the Signet binary. The tarball is verified
 * against the manifest's `components.connectors.sha256` and extracted
 * to `<binDir>/../runtime/connectors/`, mirroring the layout the npm
 * wrapper uses after `install-native.js` runs.
 */
type RuntimeComponent = "connectors" | "daemonJs";

function installRuntimeAssetsFromManifest(
	tarballPath: string,
	binDir: string,
	component: RuntimeComponent,
	componentLabel: string,
): string {
	// Look up the expected SHA-256 from the manifest. Curl installs keep the
	// manifest next to the native binary; workspace and older installs may not
	// have one, so extraction remains compatible with the connector path.
	const manifestCandidates = [
		join(process.cwd(), "native-manifest.json"),
		join(dirname(process.execPath), "native-manifest.json"),
		join(dirname(process.execPath), "..", "native-manifest.json"),
		join(dirname(process.execPath), "..", "..", "native-manifest.json"),
	];
	for (const manifestPath of manifestCandidates) {
		if (!existsSync(manifestPath)) continue;
		try {
			const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
				components?: Record<string, { sha256?: string; size?: number }>;
			};
			const entry = manifest.components?.[component];
			if (entry?.sha256) verifySha256(tarballPath, entry.sha256);
			if (typeof entry?.size === "number") {
				const actual = readFileSync(tarballPath).length;
				if (actual !== entry.size) {
					throw new Error(`Tarball size mismatch for ${componentLabel}: expected ${entry.size}, got ${actual}`);
				}
			}
			break;
		} catch (error) {
			if (error instanceof Error && (error.message.startsWith("SHA-256") || error.message.startsWith("Tarball size"))) {
				throw error;
			}
			// Ignore malformed manifests and try the next candidate.
		}
	}

	const extractRoot = join(binDir, "..");
	extractConnectorAssets(tarballPath, extractRoot);
	return join(extractRoot, "runtime", component === "daemonJs" ? "daemon-js" : "connectors");
}

function installConnectorAssetsFromManifest(tarballPath: string, binDir: string): string {
	return installRuntimeAssetsFromManifest(tarballPath, binDir, "connectors", "connector assets");
}

function installDaemonJsAssetsFromManifest(tarballPath: string, binDir: string): string {
	return installRuntimeAssetsFromManifest(tarballPath, binDir, "daemonJs", "Bun JavaScript daemon assets");
}

export function installNativeBinary(options: NativeInstallOptions = {}): NativeInstallResult {
	const source = process.execPath;
	if (isRuntimeExecutable(source)) {
		throw new Error(
			"`signet install` must be run from the compiled Signet binary. Build it with `bun run build:native-bun` or use a release binary.",
		);
	}

	const binDir = options.binDir ?? defaultBinDir();
	const target = join(binDir, binaryName());

	if (existsSync(target) && !options.force) {
		const connectorAssetsDir = options.connectorAssets
			? installConnectorAssetsFromManifest(options.connectorAssets, binDir)
			: null;
		const daemonJsAssetsDir = options.daemonJsAssets
			? installDaemonJsAssetsFromManifest(options.daemonJsAssets, binDir)
			: null;
		const pathPersistence = persistNativeInstallPath(binDir, {
			interactive: process.stdin.isTTY === true && process.stdout.isTTY === true,
		});
		const pathHint = pathPersistence.persisted || pathContains(binDir) ? null : binDir;
		return {
			source,
			target,
			installed: false,
			pathHint,
			pathProfile: pathPersistence.profilePath,
			pathPersisted: pathPersistence.persisted,
			connectorAssetsDir,
			daemonJsAssetsDir,
		};
	}

	// Validate and extract companion assets before replacing an existing
	// executable. A connector checksum or extraction failure must leave the
	// previously working Signet binary in place.
	const connectorAssetsDir = options.connectorAssets
		? installConnectorAssetsFromManifest(options.connectorAssets, binDir)
		: null;
	const daemonJsAssetsDir = options.daemonJsAssets
		? installDaemonJsAssetsFromManifest(options.daemonJsAssets, binDir)
		: null;

	mkdirSync(binDir, { recursive: true });
	const tmp = join(dirname(target), `.${basename(target)}.${process.pid}.tmp`);
	rmSync(tmp, { force: true });
	copyFileSync(source, tmp);
	try {
		if (process.platform !== "win32") chmodSync(tmp, 0o755);
		if (process.platform === "win32" && existsSync(target)) {
			const backup = join(dirname(target), `.${basename(target)}.backup`); // Parent may still execute this renamed image.
			rmSync(backup, { force: true });
			renameSync(target, backup);
			try {
				renameSync(tmp, target);
			} catch (error) {
				if (!existsSync(target) && existsSync(backup)) {
					renameSync(backup, target);
				}
				throw error;
			}
		} else {
			// POSIX rename replaces the existing path atomically, so a failed
			// copy or checksum never removes the previously installed binary.
			renameSync(tmp, target);
		}
	} finally {
		rmSync(tmp, { force: true });
	}

	const pathPersistence = persistNativeInstallPath(binDir, {
		interactive: process.stdin.isTTY === true && process.stdout.isTTY === true,
	});
	const pathHint = pathPersistence.persisted || pathContains(binDir) ? null : binDir;
	return {
		source,
		target,
		installed: true,
		pathHint,
		pathProfile: pathPersistence.profilePath,
		pathPersisted: pathPersistence.persisted,
		connectorAssetsDir,
		daemonJsAssetsDir,
	};
}

export function printNativeInstallResult(result: NativeInstallResult, json = false): void {
	if (json) {
		console.log(JSON.stringify(result, null, 2));
		return;
	}

	if (result.installed) {
		console.log(chalk.green(`Installed Signet binary at ${result.target}`));
	} else {
		console.log(chalk.yellow(`Signet binary already exists at ${result.target}`));
		console.log(chalk.dim("Use --force to replace it."));
	}

	if (result.connectorAssetsDir) {
		console.log(chalk.green(`Installed connector assets to ${result.connectorAssetsDir}`));
	}

	if (result.daemonJsAssetsDir) {
		console.log(chalk.green(`Installed Bun JavaScript daemon assets to ${result.daemonJsAssetsDir}`));
	}

	if (result.pathPersisted && result.pathProfile) {
		console.log(
			chalk.green(
				`PATH is configured in ${result.pathProfile}. Open a new shell or run \`source ${result.pathProfile}\`.`,
			),
		);
	}

	if (result.pathHint) {
		if (result.pathProfile) {
			console.log(chalk.yellow(`Could not update ${result.pathProfile}. Add ${result.pathHint} to PATH manually.`));
		} else {
			console.log(chalk.yellow(`Add ${result.pathHint} to PATH if \`signet\` is not found.`));
		}
	}
}
