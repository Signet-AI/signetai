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
const WINDOWS_OPEN_SCRIPT = `$url = $env:${WINDOWS_OPEN_ENV}; Start-Process -FilePath $url;`;

export interface WindowsOpenInvocation {
	readonly command: "powershell.exe";
	readonly args: readonly string[];
	readonly options: {
		readonly detached: true;
		readonly stdio: "ignore";
		readonly env: NodeJS.ProcessEnv;
	};
}

export interface OpenUrlOptions {
	readonly open?: OpenUrl;
	readonly platform?: NodeJS.Platform;
	readonly hasGuiSession?: () => Promise<boolean>;
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

export function buildWindowsOpenInvocation(url: string): WindowsOpenInvocation {
	return {
		command: "powershell.exe",
		args: ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_OPEN_SCRIPT],
		options: {
			detached: true,
			stdio: "ignore",
			env: { ...process.env, [WINDOWS_OPEN_ENV]: url },
		},
	};
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

function stopOpenProcess(child: ChildProcess): void {
	if (child.exitCode === null && child.signalCode === null) child.kill();
	child.unref();
}

function waitForOpenProcess(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) {
		return child.exitCode === 0 ? Promise.resolve() : Promise.reject(new Error("Browser opener exited unsuccessfully"));
	}

	return new Promise<void>((resolve, reject) => {
		child.once("error", reject);
		child.once("close", (code) => {
			if (code === 0) {
				resolve();
				return;
			}
			reject(new Error(`Browser opener exited with code ${code}`));
		});
	});
}

export async function openUrlWithFallback(url: string, options: OpenUrlOptions = {}): Promise<void> {
	const platform = options.platform ?? process.platform;
	if (platform === "darwin") {
		const guiSession = await (options.hasGuiSession ?? hasDarwinGuiSession)();
		if (!guiSession) {
			printManualBrowserInstructions(url);
			return;
		}
	}

	const timeoutMs = options.timeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS;
	let child: ChildProcess | undefined;
	let timedOut = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const opener =
			options.open ??
			((target: string) => {
				if (platform === "win32") return openWindowsUrl(target);
				// open(wait: true) waits for the browser application to exit on macOS.
				// Spawn without that app-lifetime wait and observe the opener process here instead.
				return open(target, { wait: false });
			});
		const openPromise = Promise.resolve(opener(url, { wait: true })).then((opened) => {
			child = opened;
			if (timedOut && opened !== undefined) stopOpenProcess(opened);
			return opened;
		});
		const timeoutPromise = new Promise<never>((_, reject) => {
			timer = setTimeout(() => {
				timedOut = true;
				if (child !== undefined) stopOpenProcess(child);
				reject(new Error("Timed out opening browser"));
			}, timeoutMs);
		});
		const opened = await Promise.race([openPromise, timeoutPromise]);
		if (opened !== undefined) await Promise.race([waitForOpenProcess(opened), timeoutPromise]);
	} catch {
		if (child !== undefined) stopOpenProcess(child);
		printManualBrowserInstructions(url);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}
