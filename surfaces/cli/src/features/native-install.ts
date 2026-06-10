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
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
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

function pathContains(dir: string): boolean {
	const pathValue = process.env.PATH ?? "";
	const separator = process.platform === "win32" ? ";" : ":";
	const normalize = (value: string): string =>
		process.platform === "win32" ? value.replaceAll("\\", "/").toLowerCase() : value.replaceAll("\\", "/");
	return pathValue.split(separator).some((entry) => normalize(entry) === normalize(dir));
}

function verifySha256(path: string, expected: string): void {
	const actual = createHash("sha256").update(readFileSync(path)).digest("hex").toLowerCase();
	if (actual !== expected.toLowerCase()) {
		throw new Error(
			`SHA-256 mismatch for ${path}: expected ${expected.toLowerCase()}, got ${actual}`,
		);
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
function installConnectorAssetsFromManifest(
	tarballPath: string,
	binDir: string,
): string {
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
					throw new Error(
						`Tarball size mismatch: expected ${expectedSize}, got ${actual}`,
					);
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
	const pathHint = pathContains(binDir) ? null : binDir;

	if (existsSync(target) && !options.force) {
		const connectorAssetsDir = options.connectorAssets
			? installConnectorAssetsFromManifest(options.connectorAssets, binDir)
			: null;
		return { source, target, installed: false, pathHint, connectorAssetsDir };
	}

	if (existsSync(target) && options.force) {
		rmSync(target, { force: true });
	}
	mkdirSync(binDir, { recursive: true });
	const tmp = join(dirname(target), `.${basename(target)}.${process.pid}.tmp`);
	copyFileSync(source, tmp);
	if (process.platform !== "win32") chmodSync(tmp, 0o755);
	renameSync(tmp, target);

	const connectorAssetsDir = options.connectorAssets
		? installConnectorAssetsFromManifest(options.connectorAssets, binDir)
		: null;

	return { source, target, installed: true, pathHint, connectorAssetsDir };
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
		console.log(
			chalk.green(`Installed connector assets to ${result.connectorAssetsDir}`),
		);
	}

	if (result.pathHint) {
		console.log(chalk.yellow(`Add ${result.pathHint} to PATH if \`signet\` is not found.`));
	}
}
