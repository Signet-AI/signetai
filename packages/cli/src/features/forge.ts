import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
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

interface ForgeInstallRecord {
	readonly managed: boolean;
	readonly version: string;
	readonly binaryPath: string;
	readonly releaseTag: string;
	readonly repository: string;
	readonly installedAt: string;
	readonly source: "github-release";
}

export interface ForgeDeps {
	readonly agentsDir: string;
	readonly defaultPort: number;
	readonly getTemplatesDir: () => string;
	readonly isDaemonRunning: () => Promise<boolean>;
}

export function loadForgeManifest(getTemplatesDir: () => string): ForgeManifest {
	const manifestPath = join(getTemplatesDir(), "forge", "manifest.json");
	const raw = readFileSync(manifestPath, "utf8");
	return JSON.parse(raw) as ForgeManifest;
}

function installRecordPath(agentsDir: string): string {
	return join(agentsDir, ".forge-install.json");
}

function readInstallRecord(agentsDir: string): ForgeInstallRecord | null {
	const path = installRecordPath(agentsDir);
	if (!existsSync(path)) return null;
	try {
		return JSON.parse(readFileSync(path, "utf8")) as ForgeInstallRecord;
	} catch {
		return null;
	}
}

function writeInstallRecord(agentsDir: string, record: ForgeInstallRecord): void {
	mkdirSync(agentsDir, { recursive: true });
	writeFileSync(installRecordPath(agentsDir), `${JSON.stringify(record, null, 2)}\n`);
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

function commonForgePaths(binaryName = "forge"): string[] {
	const home = homedir();
	const ext = process.platform === "win32" ? ".exe" : "";
	return [
		join(home, ".cargo", "bin", `${binaryName}${ext}`),
		join(home, ".local", "bin", `${binaryName}${ext}`),
		join(home, ".config", "signet", "bin", `${binaryName}${ext}`),
		join("/usr/local/bin", `${binaryName}${ext}`),
		join("/opt/homebrew/bin", `${binaryName}${ext}`),
	];
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

function findInstalledForge(binaryName = "forge"): string | null {
	const fromPath = resolveBinaryFromPath(binaryName);
	if (fromPath) return fromPath;
	for (const candidate of commonForgePaths(binaryName)) {
		if (existsSync(candidate)) return candidate;
	}
	return null;
}

function readInstalledForgeVersion(binaryPath: string): string | null {
	try {
		const output = execFileSync(binaryPath, ["--version"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		const match = output.match(/(\d+\.\d+\.\d+)/);
		return match?.[1] ?? (output || null);
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

async function resolveForgeRelease(manifest: ForgeManifest, requestedVersion?: string): Promise<ForgeRelease> {
	const requestedTag = requestedVersion ? `${manifest.tagPrefix}${requestedVersion}` : null;
	const base = `https://api.github.com/repos/${manifest.repository}/releases`;
	if (requestedTag) {
		const release = await fetchJson<{
			tag_name: string;
			html_url: string;
			assets: Array<{ name: string; browser_download_url: string }>;
		}>(`${base}/tags/${requestedTag}`);
		return {
			tag: release.tag_name,
			version: release.tag_name.replace(manifest.tagPrefix, ""),
			htmlUrl: release.html_url,
			assets: release.assets.map((asset) => ({ name: asset.name, url: asset.browser_download_url })),
		};
	}

	const releases = await fetchJson<
		Array<{
			tag_name: string;
			html_url: string;
			assets: Array<{ name: string; browser_download_url: string }>;
		}>
	>(`${base}?per_page=30`);
	const match = releases.find((release) => release.tag_name.startsWith(manifest.tagPrefix));
	if (!match) {
		throw new Error(`No Forge releases found in ${manifest.repository}`);
	}
	return {
		tag: match.tag_name,
		version: match.tag_name.replace(manifest.tagPrefix, ""),
		htmlUrl: match.html_url,
		assets: match.assets.map((asset) => ({ name: asset.name, url: asset.browser_download_url })),
	};
}

function platformAssetName(): string {
	const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : null;
	if (!arch) {
		throw new Error(`Unsupported Forge architecture: ${process.arch}`);
	}
	if (process.platform === "darwin") {
		return `forge-macos-${arch}.tar.gz`;
	}
	if (process.platform === "linux") {
		return `forge-linux-${arch}.tar.gz`;
	}
	throw new Error(`Forge binary install is not supported on ${process.platform} yet`);
}

function resolveInstallDir(): string {
	const home = homedir();
	const preferred = [join(home, ".cargo", "bin"), join(home, ".local", "bin"), join(home, ".config", "signet", "bin")];
	for (const dir of preferred) {
		if (existsSync(dir)) return dir;
	}
	const fallback = join(home, ".local", "bin");
	mkdirSync(fallback, { recursive: true });
	return fallback;
}

async function downloadFile(url: string, destination: string): Promise<void> {
	const response = await fetch(url, { headers: { "User-Agent": "signet-cli" } });
	if (!response.ok) {
		throw new Error(`Download failed with HTTP ${response.status}`);
	}
	const buffer = Buffer.from(await response.arrayBuffer());
	writeFileSync(destination, buffer);
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
	const release = await resolveForgeRelease(manifest, version);
	const assetName = platformAssetName();
	const asset = release.assets.find((entry) => entry.name === assetName);
	if (!asset) {
		throw new Error(`Release ${release.tag} does not include asset ${assetName}`);
	}

	const installDir = resolveInstallDir();
	mkdirSync(installDir, { recursive: true });
	const tempRoot = join(deps.agentsDir, ".tmp", "forge-install");
	const extractDir = join(tempRoot, `extract-${Date.now()}`);
	const archivePath = join(tempRoot, asset.name);
	mkdirSync(tempRoot, { recursive: true });

	await downloadFile(asset.url, archivePath);
	const extracted = extractForgeBinary(archivePath, extractDir, manifest.binary);
	const finalPath = join(installDir, manifest.binary);
	const stagedPath = join(dirname(finalPath), `.${manifest.binary}.new`);
	if (existsSync(stagedPath)) unlinkSync(stagedPath);
	if (existsSync(finalPath)) unlinkSync(finalPath);
	renameSync(extracted, stagedPath);
	chmodSync(stagedPath, 0o755);
	renameSync(stagedPath, finalPath);
	if (existsSync(archivePath)) unlinkSync(archivePath);

	writeInstallRecord(deps.agentsDir, {
		managed: true,
		version: release.version,
		binaryPath: finalPath,
		releaseTag: release.tag,
		repository: manifest.repository,
		installedAt: new Date().toISOString(),
		source: "github-release",
	});

	return { version: release.version, binaryPath: finalPath, releaseTag: release.tag, releaseUrl: release.htmlUrl };
}

function buildStatusPayload(deps: ForgeDeps, manifest: ForgeManifest) {
	const binaryPath = findInstalledForge(manifest.binary);
	const installedVersion = binaryPath ? readInstalledForgeVersion(binaryPath) : null;
	const record = readInstallRecord(deps.agentsDir);
	return {
		installed: Boolean(binaryPath),
		binaryPath,
		version: installedVersion,
		managed: Boolean(record?.managed),
		managedRecord: record,
		workspaceConfigured: existsSync(join(deps.agentsDir, "agent.yaml")),
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
	const currentVersion = status.version;
	const latest = await resolveForgeRelease(manifest, options.version);
	if (currentVersion && compareSemver(currentVersion, latest.version) >= 0) {
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
