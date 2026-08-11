import { spawnSync } from "node:child_process";
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
}

export interface NativeInstallResult {
	readonly source: string;
	readonly target: string;
	readonly installed: boolean;
	readonly pathHint: string | null;
	readonly pathProfile: string | null;
	readonly pathPersisted: boolean;
	readonly connectorAssetsDir: string | null;
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
		const containsRequestedDir = line.includes(binDir) || line.includes(normalizedDir);
		if (containsRequestedDir) return true;
		return (
			isDefaultBinDir &&
			(line.includes("$HOME/.local/bin") || line.includes("${HOME}/.local/bin") || line.includes("~/.local/bin"))
		);
	});
}

export interface NativeInstallPathOptions {
	readonly home?: string;
	readonly shell?: string;
	readonly platform?: NodeJS.Platform;
	readonly pathValue?: string;
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
	if (pathContains(binDir, options.pathValue, platform) || profilePath === null) {
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
function installConnectorAssetsFromManifest(tarballPath: string, binDir: string): string {
	// Look up the expected SHA-256 from the manifest. The manifest is
	// resolved relative to the wrapper's `native-manifest.json` if it
	// exists, otherwise we fall back to trusting the tarball as-is
	// (curl installs without the manifest will skip verification but
	// still extract, matching the npm-wrapper happy path).
	const manifestCandidates = [
		join(process.cwd(), "native-manifest.json"),
		join(dirname(process.execPath), "..", "native-manifest.json"),
		join(dirname(process.execPath), "..", "..", "native-manifest.json"),
	];
	for (const manifestPath of manifestCandidates) {
		if (!existsSync(manifestPath)) continue;
		try {
			const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
				components?: { connectors?: { sha256?: string; size?: number } };
			};
			const expected = manifest.components?.connectors?.sha256;
			const expectedSize = manifest.components?.connectors?.size;
			if (expected) verifySha256(tarballPath, expected);
			if (typeof expectedSize === "number") {
				const actual = readFileSync(tarballPath).length;
				if (actual !== expectedSize) {
					throw new Error(`Tarball size mismatch: expected ${expectedSize}, got ${actual}`);
				}
			}
			break;
		} catch (err) {
			if (err instanceof Error && err.message.startsWith("SHA-256")) throw err;
			// Ignore JSON parse errors and keep looking at the next candidate.
		}
	}

	// Tarballs use a `runtime/connectors/<harness>/...` layout, so we
	// extract at `<binDir>/..` (one level above `bin/`) and let the
	// tarball's own `runtime/` prefix land at the right place.
	const extractRoot = join(binDir, "..");
	extractConnectorAssets(tarballPath, extractRoot);
	return join(extractRoot, "runtime", "connectors");
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
		const pathPersistence = persistNativeInstallPath(binDir);
		const pathHint = pathPersistence.persisted || pathContains(binDir) ? null : binDir;
		return {
			source,
			target,
			installed: false,
			pathHint,
			pathProfile: pathPersistence.profilePath,
			pathPersisted: pathPersistence.persisted,
			connectorAssetsDir,
		};
	}

	// Validate and extract companion assets before replacing an existing
	// executable. A connector checksum or extraction failure must leave the
	// previously working Signet binary in place.
	const connectorAssetsDir = options.connectorAssets
		? installConnectorAssetsFromManifest(options.connectorAssets, binDir)
		: null;

	mkdirSync(binDir, { recursive: true });
	const tmp = join(dirname(target), `.${basename(target)}.${process.pid}.tmp`);
	rmSync(tmp, { force: true });
	copyFileSync(source, tmp);
	try {
		if (process.platform !== "win32") chmodSync(tmp, 0o755);
		if (process.platform === "win32" && existsSync(target)) {
			const backup = join(dirname(target), `.${basename(target)}.${process.pid}.backup`);
			rmSync(backup, { force: true });
			renameSync(target, backup);
			try {
				renameSync(tmp, target);
				rmSync(backup, { force: true });
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

	const pathPersistence = persistNativeInstallPath(binDir);
	const pathHint = pathPersistence.persisted || pathContains(binDir) ? null : binDir;
	return {
		source,
		target,
		installed: true,
		pathHint,
		pathProfile: pathPersistence.profilePath,
		pathPersisted: pathPersistence.persisted,
		connectorAssetsDir,
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
