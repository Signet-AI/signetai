import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { findSignetForgeBinary, isSignetForgeBinary, resolveSignetForgeManagedPath } from "@signet/core";
import chalk from "chalk";

export interface ForgeManifest {
	readonly version: string;
	readonly tagPrefix: string;
	readonly repository: string;
	readonly binary: string;
}

export interface ForgeStatusOptions {
	json?: boolean;
}

export interface ForgeInstallOptions {
	version?: string;
}

interface ForgeRelease {
	readonly tag: string;
	readonly version: string;
	readonly assets: ReadonlyArray<{ name: string; url: string }>;
	readonly htmlUrl: string;
}

interface GitHubForgeRelease {
	readonly tag_name: string;
	readonly html_url: string;
	readonly draft: boolean;
	readonly prerelease: boolean;
	readonly assets: Array<{ name: string; browser_download_url: string }>;
}

interface ForgeInstallRecord {
	readonly managed: boolean;
	readonly version: string;
	readonly binaryPath: string;
	readonly releaseTag: string;
	readonly repository: string;
	readonly installedAt: string;
	readonly source: "github-release";
}

interface ManagedForgeRecordLike {
	readonly managed?: boolean;
	readonly binaryPath?: string;
	readonly source?: string;
}

interface ForgeStatusPayload {
	readonly installed: boolean;
	readonly binaryPath: string | null;
	readonly version: string | null;
	readonly managed: boolean;
	readonly managedBinaryPath: string | null;
	readonly managedVersion: string | null;
	readonly managedRecord: ForgeInstallRecord | null;
	readonly workspaceConfigured: boolean;
}

export interface ForgeDeps {
	readonly agentsDir: string;
	readonly defaultPort: number;
	readonly getTemplatesDir: () => string;
	readonly isDaemonRunning: () => Promise<boolean>;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FALLBACK_FORGE_MANIFEST: ForgeManifest = {
	version: "0.0.0",
	tagPrefix: "forge-v",
	repository: "Signet-AI/signetai",
	binary: "forge",
};
const MANAGED_FORGE_INSTALL_LOCK_INFO = "owner.json";
const MANAGED_FORGE_INSTALL_LOCK_STALE_MS = 60 * 60 * 1000;

function managedForgeInstallLockDir(home = homedir()): string {
	return join(signetManagedInstallDir(home), ".forge-install.lock");
}

function managedForgeInstallLockInfoPath(lockDir: string): string {
	return join(lockDir, MANAGED_FORGE_INSTALL_LOCK_INFO);
}

function currentManagedForgeInstallLockMetadata(): { pid: number; createdAt: string } {
	return {
		pid: process.pid,
		createdAt: new Date().toISOString(),
	};
}

function writeManagedForgeInstallLockMetadata(lockDir: string): void {
	writeFileSync(
		managedForgeInstallLockInfoPath(lockDir),
		`${JSON.stringify(currentManagedForgeInstallLockMetadata(), null, 2)}\n`,
	);
}

function readManagedForgeInstallLockMetadata(lockDir: string): { pid?: unknown; createdAt?: unknown } | null {
	try {
		return JSON.parse(readFileSync(managedForgeInstallLockInfoPath(lockDir), "utf8")) as {
			pid?: unknown;
			createdAt?: unknown;
		};
	} catch {
		return null;
	}
}

function isRunningPid(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		const code =
			error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : "";
		return code === "EPERM";
	}
}

function isManagedForgeInstallLockStale(lockDir: string): boolean {
	const metadata = readManagedForgeInstallLockMetadata(lockDir);
	const lockAgeMs = (() => {
		if (typeof metadata?.createdAt === "string") {
			const parsed = Date.parse(metadata.createdAt);
			if (Number.isFinite(parsed)) {
				return Date.now() - parsed;
			}
		}
		try {
			return Date.now() - statSync(lockDir).mtimeMs;
		} catch {
			return null;
		}
	})();
	if (typeof metadata?.pid === "number") {
		return !isRunningPid(metadata.pid);
	}
	return lockAgeMs !== null && lockAgeMs > MANAGED_FORGE_INSTALL_LOCK_STALE_MS;
}

function acquireManagedForgeInstallLock(lockDir: string): void {
	for (let attempt = 0; attempt < 2; attempt += 1) {
		try {
			mkdirSync(lockDir);
			try {
				writeManagedForgeInstallLockMetadata(lockDir);
			} catch (error) {
				rmSync(lockDir, { recursive: true, force: true });
				throw error;
			}
			return;
		} catch (err) {
			const code = err && typeof err === "object" && "code" in err ? String((err as { code?: unknown }).code) : "";
			if (code !== "EEXIST") throw err;
			if (attempt === 0 && isManagedForgeInstallLockStale(lockDir)) {
				rmSync(lockDir, { recursive: true, force: true });
				continue;
			}
			throw new Error(
				`Another ${chalk.cyan("signet forge install/update")} is already running. Wait for it to finish and try again.`,
			);
		}
	}
}

export function withManagedForgeInstallLock<T>(run: () => Promise<T>, home = homedir()): Promise<T> {
	const lockDir = managedForgeInstallLockDir(home);
	mkdirSync(signetManagedInstallDir(home), { recursive: true });
	acquireManagedForgeInstallLock(lockDir);

	return Promise.resolve()
		.then(run)
		.finally(() => {
			rmSync(lockDir, { recursive: true, force: true });
		});
}

function resolveForgeManifestPath(getTemplatesDir: () => string): string | null {
	const sourceCandidates = [
		join(__dirname, "..", "..", "forge", "forge-version.json"),
		join(__dirname, "..", "..", "..", "forge", "forge-version.json"),
		join(getTemplatesDir(), "forge", "manifest.json"),
	];
	for (const candidate of sourceCandidates) {
		if (existsSync(candidate)) return candidate;
	}
	return null;
}

export function loadForgeManifest(getTemplatesDir: () => string): ForgeManifest {
	const manifestPath = resolveForgeManifestPath(getTemplatesDir);
	if (!manifestPath) {
		return FALLBACK_FORGE_MANIFEST;
	}
	const raw = readFileSync(manifestPath, "utf8");
	return JSON.parse(raw) as ForgeManifest;
}

function installRecordPath(): string {
	return join(signetManagedInstallDir(), ".forge-install.json");
}

function readInstallRecord(): ForgeInstallRecord | null {
	const path = installRecordPath();
	if (!existsSync(path)) return null;
	try {
		return JSON.parse(readFileSync(path, "utf8")) as ForgeInstallRecord;
	} catch {
		return null;
	}
}

function writeInstallRecord(record: ForgeInstallRecord): void {
	const dir = signetManagedInstallDir();
	mkdirSync(dir, { recursive: true });
	writeFileSync(installRecordPath(), `${JSON.stringify(record, null, 2)}\n`);
}

export function isSignetManagedForgeRecord(record: ManagedForgeRecordLike | null, managedBinaryPath: string): boolean {
	return Boolean(
		record?.managed === true && record.binaryPath === managedBinaryPath && record.source === "github-release",
	);
}

function compareSemver(left: string, right: string): number {
	const parse = (value: string): number[] => value.split(".").map((part) => Number.parseInt(part, 10) || 0);
	const a = parse(left);
	const b = parse(right);
	for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
		const delta = (a[i] ?? 0) - (b[i] ?? 0);
		if (delta !== 0) return delta;
	}
	return 0;
}

function normalizeForgeRelease(release: GitHubForgeRelease, tagPrefix: string): ForgeRelease {
	return {
		tag: release.tag_name,
		version: release.tag_name.replace(tagPrefix, ""),
		htmlUrl: release.html_url,
		assets: release.assets.map((asset) => ({ name: asset.name, url: asset.browser_download_url })),
	};
}

export function selectLatestStableForgeRelease(
	releases: ReadonlyArray<GitHubForgeRelease>,
	manifest: Pick<ForgeManifest, "tagPrefix" | "repository">,
): ForgeRelease {
	const match = releases
		.filter((release) => release.tag_name.startsWith(manifest.tagPrefix))
		.filter((release) => !release.draft && !release.prerelease)
		.sort((left, right) =>
			compareSemver(right.tag_name.replace(manifest.tagPrefix, ""), left.tag_name.replace(manifest.tagPrefix, "")),
		)[0];
	if (!match) {
		throw new Error(`No stable Forge releases found in ${manifest.repository}`);
	}
	return normalizeForgeRelease(match, manifest.tagPrefix);
}

function commonForgePaths(binaryName = "forge"): string[] {
	const home = homedir();
	const binaryFile = binaryFilename(binaryName);
	return [
		join(home, ".cargo", "bin", binaryFile),
		join(home, ".local", "bin", binaryFile),
		signetManagedBinaryPath(binaryName),
		join("/usr/local/bin", binaryFile),
		join("/opt/homebrew/bin", binaryFile),
	];
}

function binaryFilename(binaryName = "forge"): string {
	return process.platform === "win32" ? `${binaryName}.exe` : binaryName;
}

function signetManagedInstallDir(home = homedir()): string {
	return join(home, ".config", "signet", "bin");
}

function signetManagedBinaryPath(binaryName = "forge"): string {
	if (binaryName === "forge") return resolveSignetForgeManagedPath();
	return join(signetManagedInstallDir(), binaryFilename(binaryName));
}

function resolveBinaryFromPath(binaryName = "forge"): string | null {
	try {
		const cmd = process.platform === "win32" ? "where" : "which";
		const output = execFileSync(cmd, [binaryName], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter(Boolean);
		return output[0] ?? null;
	} catch {
		return null;
	}
}

function findInstalledForge(deps: ForgeDeps, binaryName = "forge"): string | null {
	if (binaryName === "forge") return findSignetForgeBinary(deps.agentsDir);
	const fromPath = resolveBinaryFromPath(binaryName);
	if (fromPath) return fromPath;
	for (const candidate of commonForgePaths(binaryName)) {
		if (existsSync(candidate)) return candidate;
	}
	return null;
}

function findManagedForge(deps: ForgeDeps, binaryName = "forge"): string | null {
	const managedPath = signetManagedBinaryPath(binaryName);
	const record = readInstallRecord();
	const validManagedBinary = existsSync(managedPath) && (binaryName !== "forge" || isSignetForgeBinary(managedPath));
	if (isSignetManagedForgeRecord(record, managedPath) && validManagedBinary) {
		return managedPath;
	}
	return null;
}

export function readForgeVersionFromBinaryMetadata(binaryPath: string): string | null {
	try {
		const raw = readFileSync(binaryPath);
		const text = raw.toString("utf8");
		const matches = [...text.matchAll(/\bforge[\s/-]?v?(\d+\.\d+\.\d+)\b/gi)].map((match) => match[1]).filter(Boolean);
		if (matches.length === 0) return null;
		return matches[matches.length - 1] ?? null;
	} catch {
		return null;
	}
}

async function fetchJson<T>(url: string): Promise<T> {
	const response = await fetch(url, {
		headers: {
			Accept: "application/vnd.github+json",
			"User-Agent": "signet-cli",
		},
	});
	if (!response.ok) {
		throw new Error(`HTTP ${response.status} for ${url}`);
	}
	return (await response.json()) as T;
}

async function fetchText(url: string): Promise<string> {
	const response = await fetch(url, {
		headers: {
			Accept: "text/plain",
			"User-Agent": "signet-cli",
		},
	});
	if (!response.ok) {
		throw new Error(`HTTP ${response.status} for ${url}`);
	}
	return await response.text();
}

async function resolveForgeRelease(manifest: ForgeManifest, requestedVersion?: string): Promise<ForgeRelease> {
	const requestedTag = requestedVersion ? `${manifest.tagPrefix}${requestedVersion}` : null;
	const base = `https://api.github.com/repos/${manifest.repository}/releases`;
	if (requestedTag) {
		const release = await fetchJson<GitHubForgeRelease>(`${base}/tags/${requestedTag}`);
		return normalizeForgeRelease(release, manifest.tagPrefix);
	}

	const releases = await fetchJson<Array<GitHubForgeRelease>>(`${base}?per_page=30`);
	return selectLatestStableForgeRelease(releases, manifest);
}

function supportedManagedForgePlatformList(): string {
	return "macOS arm64, macOS x64, Linux x64, and Linux arm64";
}

export function managedForgeAssetNameForPlatform(platform: NodeJS.Platform, arch: string): string {
	if (platform === "darwin" && arch === "arm64") return "forge-macos-arm64.tar.gz";
	if (platform === "darwin" && arch === "x64") return "forge-macos-x64.tar.gz";
	if (platform === "linux" && arch === "x64") return "forge-linux-x64.tar.gz";
	if (platform === "linux" && arch === "arm64") return "forge-linux-arm64.tar.gz";
	throw new Error(
		`signet forge install/update currently publishes managed binaries for ${supportedManagedForgePlatformList()}. Detected ${platform} ${arch}. Install Forge from source or a local standalone build instead.`,
	);
}

export function managedForgeInstallSupportedForPlatform(platform: NodeJS.Platform, arch: string): boolean {
	try {
		managedForgeAssetNameForPlatform(platform, arch);
		return true;
	} catch {
		return false;
	}
}

export function managedForgeInstallSupportedOnCurrentPlatform(): boolean {
	return managedForgeInstallSupportedForPlatform(process.platform, process.arch);
}

function platformAssetName(): string {
	return managedForgeAssetNameForPlatform(process.platform, process.arch);
}

function checksumAssetName(assetName: string): string {
	return `${assetName}.sha256`;
}

async function downloadFile(url: string, destination: string): Promise<void> {
	const response = await fetch(url, { headers: { "User-Agent": "signet-cli" } });
	if (!response.ok) {
		throw new Error(`Download failed with HTTP ${response.status}`);
	}
	const buffer = Buffer.from(await response.arrayBuffer());
	writeFileSync(destination, buffer);
}

function parseSha256Checksum(raw: string, assetName: string): string {
	const lines = raw
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
	for (const line of lines) {
		const match = line.match(/^([a-fA-F0-9]{64})(?:\s+\*?(.+))?$/);
		if (!match) continue;
		if (!match[2] || match[2] === assetName) {
			return match[1].toLowerCase();
		}
	}
	throw new Error(`Invalid checksum file for ${assetName}`);
}

function verifyFileChecksum(filePath: string, expectedSha256: string): void {
	const actual = createHash("sha256").update(readFileSync(filePath)).digest("hex");
	if (actual !== expectedSha256.toLowerCase()) {
		throw new Error(`Checksum verification failed for ${filePath}`);
	}
}

/**
 * Heuristic compatibility check only (non-cryptographic).
 * This confirms the extracted executable looks like a Signet-compatible Forge binary,
 * but it is not a provenance/authenticity boundary by itself.
 */
function verifyForgeBinaryCompatibilityMarkers(binaryPath: string): void {
	if (!isSignetForgeBinary(binaryPath)) {
		throw new Error(`Extracted binary failed Signet Forge compatibility marker check: ${binaryPath}`);
	}
}

function extractForgeBinary(archivePath: string, destinationDir: string, binaryName: string): string {
	mkdirSync(destinationDir, { recursive: true });
	const result = spawnSync("tar", ["-xzf", archivePath, "-C", destinationDir], { stdio: "pipe" });
	if (result.status !== 0) {
		throw new Error(result.stderr.toString("utf8") || "tar extraction failed");
	}
	const direct = join(destinationDir, binaryName);
	if (existsSync(direct)) return direct;
	for (const candidate of commonForgePaths(binaryName)) {
		void candidate;
	}
	const found = spawnSync("find", [destinationDir, "-type", "f", "-name", binaryName], { encoding: "utf8" });
	const match = found.stdout
		.split(/\r?\n/)
		.map((line) => line.trim())
		.find(Boolean);
	if (!match) {
		throw new Error(`Could not find ${binaryName} after extraction`);
	}
	return match;
}

async function installForgeBinary(
	deps: ForgeDeps,
	manifest: ForgeManifest,
	version?: string,
): Promise<{ version: string; binaryPath: string; releaseTag: string; releaseUrl: string }> {
	return withManagedForgeInstallLock(async () => {
		const release = await resolveForgeRelease(manifest, version);
		const assetName = platformAssetName();
		const asset = release.assets.find((entry) => entry.name === assetName);
		if (!asset) {
			throw new Error(`Release ${release.tag} does not include asset ${assetName}`);
		}
		const checksumAsset = release.assets.find((entry) => entry.name === checksumAssetName(asset.name));
		if (!checksumAsset) {
			throw new Error(`Release ${release.tag} does not include checksum asset ${checksumAssetName(asset.name)}`);
		}

		const installDir = signetManagedInstallDir();
		mkdirSync(installDir, { recursive: true });
		const targetBinary = binaryFilename(manifest.binary);
		const finalPath = join(installDir, targetBinary);
		const existingRecord = readInstallRecord();
		if (existsSync(finalPath) && !isSignetManagedForgeRecord(existingRecord, finalPath)) {
			throw new Error(
				`Refusing to overwrite unmanaged Forge at ${chalk.cyan(finalPath)}. Move or remove that binary first, or keep using it as a standalone install.`,
			);
		}

		const tempRoot = mkdtempSync(join(installDir, ".forge-install-"));
		const extractDir = join(tempRoot, "extract");
		const archivePath = join(tempRoot, asset.name);
		const stagedPath = join(installDir, `.${targetBinary}.new`);
		try {
			await downloadFile(asset.url, archivePath);
			const expectedSha256 = parseSha256Checksum(await fetchText(checksumAsset.url), asset.name);
			verifyFileChecksum(archivePath, expectedSha256);
			const extracted = extractForgeBinary(archivePath, extractDir, manifest.binary);
			verifyForgeBinaryCompatibilityMarkers(extracted);
			if (existsSync(stagedPath)) unlinkSync(stagedPath);
			renameSync(extracted, stagedPath);
			chmodSync(stagedPath, 0o755);
			renameSync(stagedPath, finalPath);
		} finally {
			if (existsSync(stagedPath)) unlinkSync(stagedPath);
			rmSync(tempRoot, { recursive: true, force: true });
		}

		writeInstallRecord({
			managed: true,
			version: release.version,
			binaryPath: finalPath,
			releaseTag: release.tag,
			repository: manifest.repository,
			installedAt: new Date().toISOString(),
			source: "github-release",
		});

		return { version: release.version, binaryPath: finalPath, releaseTag: release.tag, releaseUrl: release.htmlUrl };
	});
}

function buildStatusPayload(deps: ForgeDeps, manifest: ForgeManifest): ForgeStatusPayload {
	const binaryPath = findInstalledForge(deps, manifest.binary);
	const record = readInstallRecord();
	const managedBinaryPath = findManagedForge(deps, manifest.binary);
	const managedPath = signetManagedBinaryPath(manifest.binary);
	const managedRecord = isSignetManagedForgeRecord(record, managedPath) ? record : null;
	const managedVersion = managedRecord?.version ?? null;
	const installedVersion =
		binaryPath && managedBinaryPath && binaryPath === managedBinaryPath
			? (managedVersion ?? readForgeVersionFromBinaryMetadata(binaryPath))
			: binaryPath
				? readForgeVersionFromBinaryMetadata(binaryPath)
				: null;
	return {
		installed: Boolean(binaryPath ?? managedBinaryPath),
		binaryPath: binaryPath ?? managedBinaryPath,
		version: installedVersion ?? managedVersion,
		managed: Boolean(managedRecord),
		managedBinaryPath,
		managedVersion,
		managedRecord,
		workspaceConfigured:
			existsSync(join(deps.agentsDir, "agent.yaml")) ||
			existsSync(join(deps.agentsDir, "AGENT.yaml")) ||
			existsSync(join(deps.agentsDir, "config.yaml")),
	};
}

export async function installForge(options: ForgeInstallOptions, deps: ForgeDeps): Promise<void> {
	const manifest = loadForgeManifest(deps.getTemplatesDir);
	const result = await installForgeBinary(deps, manifest, options.version);
	console.log(chalk.green(`✓ Forge ${result.version} installed`));
	console.log(chalk.dim(`  Binary: ${result.binaryPath}`));
	console.log(chalk.dim(`  Release: ${result.releaseTag}`));
	console.log(chalk.dim(`  ${result.releaseUrl}`));
}

export async function updateForge(options: ForgeInstallOptions, deps: ForgeDeps): Promise<void> {
	const manifest = loadForgeManifest(deps.getTemplatesDir);
	const status = buildStatusPayload(deps, manifest);
	if (!status.managedRecord) {
		throw new Error(
			`Refusing to update a non-Signet-managed Forge install. Run ${chalk.cyan("signet forge install")} to install Forge into ${chalk.cyan(signetManagedInstallDir())}.`,
		);
	}
	const currentVersion = status.managedVersion ?? status.managedRecord?.version ?? null;
	const latest = await resolveForgeRelease(manifest, options.version);
	const requestedVersion = Boolean(options.version);
	const shouldSkipUpdate =
		currentVersion !== null &&
		(!requestedVersion
			? compareSemver(currentVersion, latest.version) >= 0
			: compareSemver(currentVersion, latest.version) === 0);
	if (shouldSkipUpdate) {
		console.log(chalk.green(`✓ Forge is already up to date (${currentVersion})`));
		return;
	}
	const result = await installForgeBinary(deps, manifest, latest.version);
	console.log(chalk.green(`✓ Forge updated to ${result.version}`));
	console.log(chalk.dim(`  Binary: ${result.binaryPath}`));
	console.log(chalk.dim(`  Release: ${result.releaseTag}`));
}

export async function showForgeStatus(options: ForgeStatusOptions, deps: ForgeDeps): Promise<void> {
	const manifest = loadForgeManifest(deps.getTemplatesDir);
	const status = buildStatusPayload(deps, manifest);
	if (options.json) {
		console.log(JSON.stringify(status, null, 2));
		return;
	}
	console.log(chalk.bold("Forge Status\n"));
	console.log(`  ${chalk.dim("Installed:")} ${status.installed ? chalk.green("yes") : chalk.yellow("no")}`);
	console.log(`  ${chalk.dim("Binary:")}    ${status.binaryPath ?? chalk.dim("not found")}`);
	console.log(`  ${chalk.dim("Version:")}   ${status.version ?? chalk.dim("unknown")}`);
	console.log(`  ${chalk.dim("Managed:")}   ${status.managed ? chalk.green("yes") : chalk.dim("no")}`);
	console.log(`  ${chalk.dim("Managed Bin:")} ${status.managedBinaryPath ?? chalk.dim("not installed")}`);
	console.log(`  ${chalk.dim("Managed Ver:")} ${status.managedVersion ?? chalk.dim("unknown")}`);
	console.log(
		`  ${chalk.dim("Workspace:")} ${status.workspaceConfigured ? chalk.green("configured") : chalk.yellow("missing agent.yaml")}`,
	);
	if (status.managedRecord?.releaseTag) {
		console.log(`  ${chalk.dim("Release:")}   ${status.managedRecord.releaseTag}`);
	}
}

export async function doctorForge(options: ForgeStatusOptions, deps: ForgeDeps): Promise<void> {
	const manifest = loadForgeManifest(deps.getTemplatesDir);
	const status = buildStatusPayload(deps, manifest);
	const daemonRunning = await deps.isDaemonRunning();
	const report = {
		installed: status.installed,
		binaryPath: status.binaryPath,
		version: status.version,
		managed: status.managed,
		managedBinaryPath: status.managedBinaryPath,
		managedVersion: status.managedVersion,
		workspaceConfigured: status.workspaceConfigured,
		daemonRunning,
		healthy: status.installed && status.workspaceConfigured && daemonRunning,
	};
	if (options.json) {
		console.log(JSON.stringify(report, null, 2));
		return;
	}
	console.log(chalk.bold("Forge Doctor\n"));
	console.log(
		`  ${status.installed ? chalk.green("✓") : chalk.red("✗")} Forge binary ${status.installed ? "found" : "missing"}`,
	);
	console.log(
		`  ${status.workspaceConfigured ? chalk.green("✓") : chalk.red("✗")} Signet workspace ${status.workspaceConfigured ? "configured" : "missing agent.yaml"}`,
	);
	console.log(
		`  ${daemonRunning ? chalk.green("✓") : chalk.red("✗")} Daemon ${daemonRunning ? `reachable on :${deps.defaultPort}` : "not running"}`,
	);
	if (!status.installed) {
		console.log(chalk.dim("  Fix: run `signet forge install`"));
	}
	if (!status.workspaceConfigured) {
		console.log(chalk.dim("  Fix: run `signet setup --harness forge`"));
	}
	if (!daemonRunning) {
		console.log(chalk.dim("  Fix: run `signet daemon start`"));
	}
	if (status.installed && status.version) {
		console.log(chalk.dim(`  Forge version: ${status.version}`));
	}
}
