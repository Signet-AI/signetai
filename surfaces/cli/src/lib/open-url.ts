import { execFile } from "node:child_process";
import { promisify } from "node:util";
import chalk from "chalk";
import open from "open";

const execFileAsync = promisify(execFile);
const DEFAULT_OPEN_TIMEOUT_MS = 5_000;

type OpenUrl = (url: string) => Promise<unknown>;

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

function printManualBrowserInstructions(url: string): void {
	console.log(chalk.yellow("  Could not open a browser automatically."));
	console.log(chalk.cyan("  Paste this URL into your browser:"));
	console.log(chalk.cyan(`    ${url}`));
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

	try {
		const opener = options.open ?? ((target: string) => open(target));
		const timeoutMs = options.timeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS;
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				Promise.resolve(opener(url)),
				new Promise<never>((_, reject) => {
					timer = setTimeout(() => reject(new Error("Timed out opening browser")), timeoutMs);
				}),
			]);
		} finally {
			if (timer !== undefined) clearTimeout(timer);
		}
	} catch {
		printManualBrowserInstructions(url);
	}
}
