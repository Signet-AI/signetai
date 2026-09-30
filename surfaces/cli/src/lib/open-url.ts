import { promisify } from "node:util";
import chalk from "chalk";
import open from "open";
import { execFileHidden as execFile, spawnHidden, type ChildProcess } from "@signet/core";

const execFileAsync = promisify(execFile);
const DEFAULT_OPEN_TIMEOUT_MS = 5_000;

type OpenInvocationOptions = {
	readonly wait?: boolean;
};

type OpenUrl = (url: string, options?: OpenInvocationOptions) => Promise<ChildProcess | undefined>;

const WINDOWS_OPEN_ENV = "SIGNET_OPEN_URL";
const WINDOWS_OPEN_SCRIPT = `$ErrorActionPreference = 'Stop'; $url = $env:${WINDOWS_OPEN_ENV}; Start-Process -FilePath $url;`;

export interface WindowsOpenInvocation {
	readonly command: "powershell.exe";
	readonly args: readonly string[];
	readonly options: {
		readonly stdio: "ignore";
		readonly env: NodeJS.ProcessEnv;
	};
}

export interface DesktopDeepLinkInvocation {
	readonly command: "powershell.exe" | "open" | "gio";
	readonly args: readonly string[];
	readonly options: {
		readonly stdio: "ignore";
		readonly env?: NodeJS.ProcessEnv;
	};
}

export interface OpenUrlOptions {
	readonly open?: OpenUrl;
	readonly platform?: NodeJS.Platform;
	readonly hasGuiSession?: () => Promise<boolean>;
	readonly hasWindowsProtocolHandler?: () => Promise<boolean>;
	readonly timeoutMs?: number;
}

async function hasDarwinGuiSession(): Promise<boolean> {
	try {
		const { stdout } = await execFileAsync("launchctl", ["managername"], { timeout: 3_000 });
		return stdout.trim() === "Aqua";
	} catch {
		return false;
	}
}

async function hasWindowsSignetProtocolHandler(): Promise<boolean> {
	try {
		const { stdout } = await execFileAsync("reg.exe", ["query", "HKCR\\signet\\shell\\open\\command", "/ve"], {
			timeout: 3_000,
		});
		return stdout.toLocaleLowerCase().includes("signet.exe");
	} catch {
		return false;
	}
}

export function buildWindowsOpenInvocation(url: string): WindowsOpenInvocation {
	return {
		command: "powershell.exe",
		args: ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_OPEN_SCRIPT],
		options: {
			stdio: "ignore",
			env: { ...process.env, [WINDOWS_OPEN_ENV]: url },
		},
	};
}

export function buildDesktopDeepLinkInvocation(
	destination: "dashboard" | "setup",
	platform: string,
): DesktopDeepLinkInvocation | null {
	const url = destination === "setup" ? "signet://setup" : "signet://dashboard";
	if (platform === "win32") return buildWindowsOpenInvocation(url);
	if (platform === "darwin")
		return { command: "open", args: ["-b", "ai.signet.app", url], options: { stdio: "ignore" } };
	if (platform === "linux")
		return { command: "gio", args: ["launch", "signet.desktop", url], options: { stdio: "ignore" } };
	return null;
}

function openWindowsUrl(url: string): ChildProcess {
	const invocation = buildWindowsOpenInvocation(url);
	const child = spawnHidden(invocation.command, invocation.args, invocation.options);
	child.unref();
	return child;
}

function printManualBrowserInstructions(url: string): void {
	console.log(chalk.yellow("  Could not open a browser automatically."));
	console.log(chalk.cyan("  Paste this URL into your browser:"));
	console.log(chalk.cyan(`    ${url}`));
}

function waitForOpenProcess(child: ChildProcess, timeoutMs: number): Promise<boolean> {
	if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(child.exitCode === 0);

	return new Promise<boolean>((resolve) => {
		const finish = (successful: boolean): void => {
			clearTimeout(timer);
			child.removeListener("error", onError);
			child.removeListener("close", onClose);
			resolve(successful);
		};
		const onError = (): void => finish(false);
		const onClose = (code: number | null): void => finish(code === 0);
		const timer = setTimeout(() => finish(true), timeoutMs);
		child.once("error", onError);
		child.once("close", onClose);
		if (child.exitCode !== null || child.signalCode !== null) finish(child.exitCode === 0);
	});
}

async function tryOpenDesktopDeepLink(destination: "dashboard" | "setup", options: OpenUrlOptions): Promise<boolean> {
	const platform = options.platform ?? process.platform;
	const invocation = buildDesktopDeepLinkInvocation(destination, platform);
	if (invocation === null) return false;
	if (platform === "darwin" && !(await (options.hasGuiSession ?? hasDarwinGuiSession)())) return false;
	if (platform === "win32" && !(await (options.hasWindowsProtocolHandler ?? hasWindowsSignetProtocolHandler)()))
		return false;

	try {
		const url = destination === "setup" ? "signet://setup" : "signet://dashboard";
		if (options.open !== undefined) {
			const child = await options.open(url, { wait: false });
			return child === undefined || (await waitForOpenProcess(child, options.timeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS));
		}

		const child = spawnHidden(invocation.command, invocation.args, invocation.options);
		child.unref();
		return await waitForOpenProcess(child, options.timeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS);
	} catch {
		return false;
	}
}

async function tryOpenUrl(url: string, options: OpenUrlOptions): Promise<boolean> {
	const platform = options.platform ?? process.platform;
	if (platform === "darwin") {
		const guiSession = await (options.hasGuiSession ?? hasDarwinGuiSession)();
		if (!guiSession) return false;
	}

	const opener =
		options.open ??
		((target: string) => {
			if (platform === "win32") return Promise.resolve(openWindowsUrl(target));
			return open(target, { wait: false });
		});
	try {
		const child = await opener(url, { wait: false });
		return child === undefined ? true : await waitForOpenProcess(child, options.timeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS);
	} catch {
		return false;
	}
}

export async function openUrlWithFallback(url: string, options: OpenUrlOptions = {}): Promise<void> {
	if (await tryOpenUrl(url, options)) return;
	printManualBrowserInstructions(url);
}

export async function openDashboardWithDesktopFallback(
	browserUrl: string,
	destination: "dashboard" | "setup",
	options: OpenUrlOptions = {},
): Promise<void> {
	if (await tryOpenDesktopDeepLink(destination, options)) return;
	await openUrlWithFallback(browserUrl, options);
}
