import { chmodSync, copyFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import chalk from "chalk";

export interface NativeInstallOptions {
	readonly binDir?: string;
	readonly force?: boolean;
	readonly json?: boolean;
}

export interface NativeInstallResult {
	readonly source: string;
	readonly target: string;
	readonly installed: boolean;
	readonly pathHint: string | null;
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
		return { source, target, installed: false, pathHint };
	}

	mkdirSync(binDir, { recursive: true });
	const tmp = join(dirname(target), `.${basename(target)}.${process.pid}.tmp`);
	copyFileSync(source, tmp);
	if (process.platform !== "win32") chmodSync(tmp, 0o755);
	renameSync(tmp, target);

	return { source, target, installed: true, pathHint };
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

	if (result.pathHint) {
		console.log(chalk.yellow(`Add ${result.pathHint} to PATH if \`signet\` is not found.`));
	}
}
