import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
import { type SignetUpdateTarget, getGlobalInstallCommand } from "@signet/core";
import { logger } from "./logger";

export type UpdateInstallErrorCode =
	| "invalid_target_version"
	| "update_in_progress"
	| "no_target_version"
	| "unsupported_installation"
	| "unsupported_runtime_update"
	| "download_failed"
	| "manifest_invalid"
	| "checksum_mismatch"
	| "install_failed"
	| "verification_failed"
	| "post_install_failed";

export interface UpdateProcessOptions {
	readonly cwd?: string;
	readonly env?: NodeJS.ProcessEnv;
	readonly timeoutMs: number;
}

export interface UpdateProcessResult {
	readonly exitCode: number | null;
	readonly stdout: string;
	readonly stderr: string;
	readonly errorMessage?: string;
	readonly timedOut: boolean;
}

export interface UpdateInstallDeps {
	readonly fetch?: typeof fetch;
	readonly runCommand?: (
		command: string,
		args: readonly string[],
		options: UpdateProcessOptions,
	) => Promise<UpdateProcessResult>;
	readonly createTempDir?: () => Promise<string>;
	readonly downloadBase?: string;
	readonly env?: NodeJS.ProcessEnv;
	readonly platform?: NodeJS.Platform;
	readonly arch?: string;
}

interface NativeManifestAsset {
	readonly name: string;
	readonly platform: string;
	readonly sha256: string;
	readonly size: number;
}

interface NativeManifestComponent {
	readonly url: string;
	readonly sha256: string;
	readonly size: number;
}

export interface NativeReleaseSelection {
	readonly version: string;
	readonly asset: NativeManifestAsset;
	readonly connectors?: NativeManifestComponent;
}

export const UPDATE_INSTALL_TIMEOUT_MS = 15 * 60_000;
export const NATIVE_MANIFEST_MAX_BYTES = 1024 * 1024;
export const NATIVE_BINARY_MAX_BYTES = 256 * 1024 * 1024;
export const NATIVE_CONNECTORS_MAX_BYTES = 64 * 1024 * 1024;
export const VERSION_VERIFY_TIMEOUT_MS = 30_000;

const MAX_COMMAND_OUTPUT_BYTES = 1024 * 1024;
const WINDOWS_VERSION_VERIFY_ATTEMPTS = 3;
const WINDOWS_VERSION_VERIFY_RETRY_MS = 250;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const EXACT_SEMVER_PATTERN =
	/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export class UpdateInstallFailure extends Error {
	readonly code: UpdateInstallErrorCode;

	constructor(code: UpdateInstallErrorCode, message: string) {
		super(message);
		this.name = "UpdateInstallFailure";
		this.code = code;
	}
}

export function cliSubprocessEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	return Object.fromEntries(
		Object.entries(env).filter(([key]) => {
			const normalized = key.toUpperCase();
			return normalized !== "SIGNET_DAEMON_ENTRYPOINT" && normalized !== "SIGNET_VERSION";
		}),
	);
}

function appendBoundedOutput(current: string, chunk: Buffer | string): string {
	const next = current + chunk.toString();
	if (Buffer.byteLength(next) <= MAX_COMMAND_OUTPUT_BYTES) return next;
	return Buffer.from(next).subarray(-MAX_COMMAND_OUTPUT_BYTES).toString("utf8");
}

export async function runUpdateProcess(
	command: string,
	args: readonly string[],
	options: UpdateProcessOptions,
): Promise<UpdateProcessResult> {
	return await new Promise((resolve) => {
		const proc = spawn(command, [...args], {
			cwd: options.cwd,
			env: options.env,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		let stdout = "";
		let stderr = "";
		let settled = false;

		const settle = (result: UpdateProcessResult): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(result);
		};
		const timer = setTimeout(() => {
			proc.kill("SIGKILL");
			settle({
				exitCode: null,
				stdout,
				stderr,
				errorMessage: `command exceeded ${options.timeoutMs}ms`,
				timedOut: true,
			});
		}, options.timeoutMs);

		proc.stdout?.on("data", (chunk: Buffer | string) => {
			stdout = appendBoundedOutput(stdout, chunk);
		});
		proc.stderr?.on("data", (chunk: Buffer | string) => {
			stderr = appendBoundedOutput(stderr, chunk);
		});
		proc.on("error", (error) => {
			settle({
				exitCode: null,
				stdout,
				stderr,
				errorMessage: error.message,
				timedOut: false,
			});
		});
		proc.on("close", (exitCode) => {
			settle({
				exitCode,
				stdout,
				stderr,
				timedOut: false,
			});
		});
	});
}

export function clipUpdateOutput(output: string): string | undefined {
	const trimmed = output.trim();
	if (!trimmed) return undefined;
	return trimmed.length <= 6000 ? trimmed : trimmed.slice(-6000);
}

export function normalizeExactSemver(value: string): string | null {
	const normalized = value.trim().replace(/^v/i, "");
	return EXACT_SEMVER_PATTERN.test(normalized) ? normalized : null;
}

export function parseExecutableVersion(output: string): string | null {
	return normalizeExactSemver(output);
}

export async function verifyExecutableVersion(
	executablePath: string,
	expectedVersion: string,
	deps: {
		readonly runCommand?: UpdateInstallDeps["runCommand"];
		readonly timeoutMs?: number;
		readonly env?: NodeJS.ProcessEnv;
		readonly platform?: NodeJS.Platform;
		readonly wait?: (delayMs: number) => Promise<void>;
		readonly now?: () => number;
	} = {},
): Promise<
	| { readonly ok: true; readonly installedVersion: string }
	| { readonly ok: false; readonly message: string; readonly observedVersion?: string }
> {
	const runCommand = deps.runCommand ?? runUpdateProcess;
	const platform = deps.platform ?? process.platform;
	const wait = deps.wait ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
	const now = deps.now ?? Date.now;
	const timeoutMs = deps.timeoutMs ?? VERSION_VERIFY_TIMEOUT_MS;
	const deadline = now() + timeoutMs;
	const maxAttempts = platform === "win32" ? WINDOWS_VERSION_VERIFY_ATTEMPTS : 1;
	let attempts = 0;
	let result: UpdateProcessResult | null = null;

	while (attempts < maxAttempts) {
		const remainingMs = deadline - now();
		if (remainingMs <= 0) break;
		attempts += 1;
		result = await runCommand(executablePath, ["--version"], {
			env: cliSubprocessEnvironment(deps.env ?? process.env),
			timeoutMs: remainingMs,
		});
		if (result.exitCode === 0) break;
		if (result.timedOut || attempts >= maxAttempts) break;

		const retryDelayMs = Math.min(WINDOWS_VERSION_VERIFY_RETRY_MS, Math.max(0, deadline - now()));
		if (retryDelayMs <= 0) break;
		await wait(retryDelayMs);
	}

	if (!result || result.exitCode !== 0) {
		const cause = result
			? result.timedOut
				? result.errorMessage
				: (result.errorMessage ?? (result.stderr.trim() || `exit ${result.exitCode}`))
			: `verification exceeded ${timeoutMs}ms before the executable could be started`;
		const windowsAdvice =
			platform === "win32"
				? ` after ${attempts} attempt${attempts === 1 ? "" : "s"}. The replacement may already have succeeded; stop or restart the daemon, then run \"${executablePath}\" --version before retrying the install`
				: "";
		return {
			ok: false,
			message: `Update installed but active executable verification failed at ${executablePath}${windowsAdvice}: ${cause}`,
		};
	}

	const installedVersion = parseExecutableVersion(result.stdout);
	if (!installedVersion) {
		return {
			ok: false,
			message: `Update installed but ${executablePath} returned an invalid version: ${result.stdout.trim() || "(empty)"}`,
		};
	}
	if (installedVersion !== expectedVersion) {
		return {
			ok: false,
			message: `Install exited cleanly but active executable ${executablePath} is ${installedVersion}, expected ${expectedVersion}`,
			observedVersion: installedVersion,
		};
	}
	return { ok: true, installedVersion };
}

function nativePlatformKey(platform: NodeJS.Platform, arch: string): string | null {
	const normalizedArch =
		arch === "arm64" || arch === "aarch64" ? "arm64" : arch === "x64" || arch === "amd64" ? "x64" : null;
	if (!normalizedArch) return null;
	if (platform === "darwin" || platform === "linux") return `${platform}-${normalizedArch}`;
	return platform === "win32" && normalizedArch === "x64" ? "win32-x64" : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readManifestComponent(value: unknown, maxBytes: number, label: string): NativeManifestComponent {
	if (!isRecord(value)) {
		throw new UpdateInstallFailure("manifest_invalid", `Native manifest ${label} entry is invalid`);
	}
	const url = typeof value.url === "string" ? value.url.trim() : "";
	const sha256 = typeof value.sha256 === "string" ? value.sha256.toLowerCase() : "";
	const size = value.size;
	if (
		!url ||
		!SHA256_PATTERN.test(sha256) ||
		typeof size !== "number" ||
		!Number.isSafeInteger(size) ||
		size <= 0 ||
		size > maxBytes
	) {
		throw new UpdateInstallFailure(
			"manifest_invalid",
			`Native manifest ${label} entry failed URL, checksum, or size validation`,
		);
	}
	return { url, sha256, size };
}

export function parseNativeReleaseManifest(
	raw: string,
	expectedVersion: string,
	platformKey: string,
): NativeReleaseSelection {
	let manifest: unknown;
	try {
		manifest = JSON.parse(raw);
	} catch {
		throw new UpdateInstallFailure("manifest_invalid", "Native release manifest is not valid JSON");
	}
	if (!isRecord(manifest) || manifest.schemaVersion !== 1) {
		throw new UpdateInstallFailure("manifest_invalid", "Native release manifest has an unsupported schema");
	}
	if (manifest.version !== expectedVersion || !Array.isArray(manifest.assets)) {
		throw new UpdateInstallFailure(
			"manifest_invalid",
			`Native release manifest version does not match ${expectedVersion}`,
		);
	}

	const expectedName = platformKey === "win32-x64" ? `signet-${platformKey}.exe` : `signet-${platformKey}`;
	const rawAsset = manifest.assets.find(
		(value) => isRecord(value) && value.platform === platformKey && value.name === expectedName,
	);
	if (!rawAsset) {
		throw new UpdateInstallFailure("manifest_invalid", `Native release manifest has no ${platformKey} Signet binary`);
	}
	const asset = readManifestComponent(
		{ url: rawAsset.name, sha256: rawAsset.sha256, size: rawAsset.size },
		NATIVE_BINARY_MAX_BYTES,
		`${platformKey} asset`,
	);
	const components = isRecord(manifest.components) ? manifest.components : undefined;
	const connectors = components?.connectors
		? readManifestComponent(components.connectors, NATIVE_CONNECTORS_MAX_BYTES, "connectors component")
		: undefined;

	return {
		version: expectedVersion,
		asset: {
			name: expectedName,
			platform: platformKey,
			sha256: asset.sha256,
			size: asset.size,
		},
		...(connectors ? { connectors } : {}),
	};
}

async function downloadBounded(
	url: string,
	maxBytes: number,
	signal: AbortSignal,
	fetchImpl: typeof fetch,
): Promise<Buffer> {
	let response: Response;
	try {
		response = await fetchImpl(url, { signal });
	} catch (error) {
		throw new UpdateInstallFailure(
			"download_failed",
			`Failed to download ${url}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (!response.ok) {
		throw new UpdateInstallFailure("download_failed", `Failed to download ${url}: HTTP ${response.status}`);
	}

	const declaredLength = Number.parseInt(response.headers.get("content-length") ?? "", 10);
	if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
		throw new UpdateInstallFailure("download_failed", `Download from ${url} exceeds ${maxBytes} bytes`);
	}
	if (!response.body) {
		const buffer = Buffer.from(await response.arrayBuffer());
		if (buffer.length > maxBytes) {
			throw new UpdateInstallFailure("download_failed", `Download from ${url} exceeds ${maxBytes} bytes`);
		}
		return buffer;
	}

	const reader = response.body.getReader();
	const chunks: Buffer[] = [];
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > maxBytes) {
				await reader.cancel();
				throw new UpdateInstallFailure("download_failed", `Download from ${url} exceeds ${maxBytes} bytes`);
			}
			chunks.push(Buffer.from(value));
		}
	} catch (error) {
		if (error instanceof UpdateInstallFailure) throw error;
		throw new UpdateInstallFailure(
			"download_failed",
			`Failed while downloading ${url}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	return Buffer.concat(chunks, total);
}

function verifyDownloadedSha256(content: Buffer, expectedSha256: string, label: string): void {
	// This proves that the downloaded content matches the release manifest; it
	// does not independently authenticate that manifest. Official updates trust
	// GitHub Actions, repository release permissions, and HTTPS delivery.
	const actual = createHash("sha256").update(content).digest("hex");
	if (actual !== expectedSha256) {
		throw new UpdateInstallFailure(
			"checksum_mismatch",
			`SHA-256 mismatch for ${label}: expected ${expectedSha256}, got ${actual}`,
		);
	}
}

export function remainingUpdateTimeout(deadline: number): number {
	const remaining = deadline - Date.now();
	if (remaining <= 0) {
		throw new UpdateInstallFailure("install_failed", "Update exceeded the 15 minute install deadline");
	}
	return remaining;
}

function releaseAssetUrl(releaseBase: string, asset: string): string {
	const url = new URL(asset, `${releaseBase.replace(/\/$/, "")}/`);
	if (url.protocol !== "https:" && url.protocol !== "http:") {
		throw new UpdateInstallFailure(
			"manifest_invalid",
			`Native release asset URL uses unsupported protocol ${url.protocol}`,
		);
	}
	return url.toString();
}

async function installNativeUpdate(
	target: Extract<SignetUpdateTarget, { kind: "native" }>,
	version: string,
	deadline: number,
	settings: { readonly githubRepo: string },
	deps: UpdateInstallDeps,
): Promise<string> {
	const platform = deps.platform ?? process.platform;
	const targetPath = platform === "win32" ? win32 : posix;
	const platformKey = nativePlatformKey(platform, deps.arch ?? process.arch);
	if (!platformKey) {
		throw new UpdateInstallFailure(
			"unsupported_installation",
			`No native Signet update is published for ${platform}-${deps.arch ?? process.arch}`,
		);
	}
	const expectedBinaryName = platform === "win32" ? "signet.exe" : "signet";
	if (targetPath.basename(target.executablePath).toLowerCase() !== expectedBinaryName) {
		throw new UpdateInstallFailure(
			"unsupported_installation",
			`Active native executable must be named ${expectedBinaryName}: ${target.executablePath}`,
		);
	}

	const env = cliSubprocessEnvironment(deps.env ?? process.env);
	const releaseBase =
		deps.downloadBase ??
		env.SIGNET_DOWNLOAD_BASE?.trim() ??
		`https://github.com/${settings.githubRepo}/releases/download/v${version}`;
	const fetchImpl = deps.fetch ?? fetch;
	const manifestBuffer = await downloadBounded(
		releaseAssetUrl(releaseBase, "native-manifest.json"),
		NATIVE_MANIFEST_MAX_BYTES,
		AbortSignal.timeout(remainingUpdateTimeout(deadline)),
		fetchImpl,
	);
	const selection = parseNativeReleaseManifest(manifestBuffer.toString("utf8"), version, platformKey);
	const binary = await downloadBounded(
		releaseAssetUrl(releaseBase, selection.asset.name),
		selection.asset.size,
		AbortSignal.timeout(remainingUpdateTimeout(deadline)),
		fetchImpl,
	);
	if (binary.length !== selection.asset.size) {
		throw new UpdateInstallFailure(
			"checksum_mismatch",
			`Native binary size is ${binary.length}, expected ${selection.asset.size}`,
		);
	}
	verifyDownloadedSha256(binary, selection.asset.sha256, selection.asset.name);

	const tempDir = await (deps.createTempDir ?? (() => mkdtemp(join(tmpdir(), "signet-update-"))))();
	try {
		const manifestPath = join(tempDir, "native-manifest.json");
		const binaryPath = join(tempDir, selection.asset.name);
		await writeFile(manifestPath, manifestBuffer);
		await writeFile(binaryPath, binary);
		if (platform !== "win32") await chmod(binaryPath, 0o755);

		const args = ["install", "--bin-dir", targetPath.dirname(target.executablePath), "--force"];
		if (selection.connectors) {
			const connectorAssetUrl = releaseAssetUrl(releaseBase, selection.connectors.url);
			const connectorFileName = posix.basename(new URL(connectorAssetUrl).pathname);
			if (!connectorFileName) {
				throw new UpdateInstallFailure("manifest_invalid", "Native manifest connectors URL has no file name");
			}
			const connectors = await downloadBounded(
				connectorAssetUrl,
				selection.connectors.size,
				AbortSignal.timeout(remainingUpdateTimeout(deadline)),
				fetchImpl,
			);
			if (connectors.length !== selection.connectors.size) {
				throw new UpdateInstallFailure(
					"checksum_mismatch",
					`Connector archive size is ${connectors.length}, expected ${selection.connectors.size}`,
				);
			}
			verifyDownloadedSha256(connectors, selection.connectors.sha256, "connector archive");
			const connectorPath = join(tempDir, connectorFileName);
			await writeFile(connectorPath, connectors);
			args.push("--connector-assets", connectorPath);
		}

		const result = await (deps.runCommand ?? runUpdateProcess)(binaryPath, args, {
			cwd: tempDir,
			env,
			timeoutMs: remainingUpdateTimeout(deadline),
		});
		const output = clipUpdateOutput(`${result.stdout}\n${result.stderr}`);
		if (result.exitCode !== 0) {
			const cause = result.timedOut
				? result.errorMessage
				: (result.errorMessage ?? (result.stderr.trim() || `exit ${result.exitCode}`));
			throw new UpdateInstallFailure("install_failed", `Native update failed: ${cause}`);
		}
		return output ?? "";
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
}

async function installPackageManagerUpdate(
	target: Extract<SignetUpdateTarget, { kind: "package-manager" }>,
	version: string,
	deadline: number,
	settings: { readonly packageName: string },
	deps: UpdateInstallDeps,
): Promise<string> {
	const installPackage = `${settings.packageName}@${version}`;
	const installCommand = getGlobalInstallCommand(target.family, installPackage);
	logger.info("system", "Running package-manager update command", {
		command: `${installCommand.command} ${installCommand.args.join(" ")}`,
		family: target.family,
		activeExecutablePath: target.executablePath,
	});
	const result = await (deps.runCommand ?? runUpdateProcess)(installCommand.command, installCommand.args, {
		env: cliSubprocessEnvironment(deps.env ?? process.env),
		timeoutMs: remainingUpdateTimeout(deadline),
	});
	const output = clipUpdateOutput(`${result.stdout}\n${result.stderr}`);
	if (result.exitCode !== 0) {
		const cause = result.timedOut
			? result.errorMessage
			: (result.errorMessage ?? (result.stderr.trim() || `exit ${result.exitCode}`));
		throw new UpdateInstallFailure("install_failed", `Update failed: ${cause}`);
	}
	return output ?? "";
}

export async function installUpdateTarget(
	target: Exclude<SignetUpdateTarget, { kind: "unsupported" }>,
	version: string,
	deadline: number,
	settings: { readonly packageName: string; readonly githubRepo: string },
	deps: UpdateInstallDeps,
): Promise<string> {
	return target.kind === "native"
		? await installNativeUpdate(target, version, deadline, settings, deps)
		: await installPackageManagerUpdate(target, version, deadline, settings, deps);
}
