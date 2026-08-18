import { spawn, spawnSync } from "node:child_process";
import { platform } from "node:os";
import { confirm, select } from "@inquirer/prompts";
import { LOOPBACK_HOST } from "@signet/core";
import chalk from "chalk";
import ora from "ora";
import { getEmbeddingDimensions, readErr } from "./setup-shared.js";

const COMMAND_DETECTION_TIMEOUT_MS = 1000;
const MACOS_COMMAND_PATHS: Readonly<Record<string, readonly string[]>> = {
	brew: ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"],
};

export async function promptOpenAIEmbeddingModel(): Promise<{ provider: "openai"; model: string; dimensions: number }> {
	console.log();
	const model = await select({
		message: "Which embedding model?",
		choices: [
			{ value: "text-embedding-3-small", name: "text-embedding-3-small (1536d, cheaper)" },
			{ value: "text-embedding-3-large", name: "text-embedding-3-large (3072d, better)" },
		],
	});

	return { provider: "openai", model, dimensions: getEmbeddingDimensions(model) };
}

export async function validateOllamaModelNonInteractive(
	model: string,
	opts?: {
		readonly hasOllamaCommand?: boolean;
		readonly pullModel?: (model: string) => Promise<boolean>;
	},
): Promise<{
	readonly available: boolean;
	readonly modelInstalled: boolean;
	readonly error?: string;
}> {
	const ollamaInstalled = opts?.hasOllamaCommand ?? hasCommand("ollama");
	if (!ollamaInstalled) {
		return {
			available: false,
			modelInstalled: false,
			error: "Ollama is not installed. Install it from https://ollama.com and re-run 'signet setup'.",
		};
	}

	const service = await queryOllamaModels();
	if (!service.available) {
		return {
			available: false,
			modelInstalled: false,
			error: `Ollama is not reachable${service.error ? `: ${service.error}` : ""}. Start it with: ollama serve`,
		};
	}

	if (!hasOllamaModel(service.models, model)) {
		console.log(chalk.yellow(`  Model '${model}' not found locally. Attempting to pull...`));
		const pulled = await (opts?.pullModel ?? pullOllamaModel)(model);
		if (!pulled) {
			return {
				available: true,
				modelInstalled: false,
				error: `Failed to pull '${model}'. Run 'ollama pull ${model}' manually and re-run 'signet setup'.`,
			};
		}
		return { available: true, modelInstalled: true };
	}

	return { available: true, modelInstalled: true };
}

export async function preflightOllamaEmbedding(model: string): Promise<{
	provider: "native" | "ollama" | "openai" | "none";
	model?: string;
	dimensions?: number;
}> {
	while (true) {
		if (!hasCommand("ollama")) {
			console.log(chalk.yellow("  Ollama is not installed."));
			const installed = await offerOllamaInstallFlow();
			if (!installed) {
				const fallback = await promptOllamaFailureFallback();
				if (fallback === "retry") continue;
				if (fallback === "native") {
					return { provider: "native", model: "nomic-embed-text-v1.5", dimensions: 768 };
				}
				if (fallback === "openai") {
					return promptOpenAIEmbeddingModel();
				}
				return { provider: "none" };
			}
		}

		const service = await queryOllamaModels();
		if (!service.available) {
			console.log(chalk.yellow("  Ollama is installed but not reachable."));
			if (service.error) console.log(chalk.dim(`  ${service.error}`));
			console.log(chalk.dim("  Start Ollama with: ollama serve"));

			const fallback = await promptOllamaFailureFallback();
			if (fallback === "retry") continue;
			if (fallback === "native") {
				return { provider: "native", model: "nomic-embed-text-v1.5", dimensions: 768 };
			}
			if (fallback === "openai") {
				return promptOpenAIEmbeddingModel();
			}
			return { provider: "none" };
		}

		if (!hasOllamaModel(service.models, model)) {
			console.log(chalk.yellow(`  Model '${model}' is not installed.`));
			const pullNow = await confirm({
				message: `Pull '${model}' now with ollama pull ${model}?`,
				default: true,
			});

			if (pullNow) {
				const pulled = await pullOllamaModel(model);
				if (pulled) {
					continue;
				}
			}

			const fallback = await promptOllamaFailureFallback();
			if (fallback === "retry") continue;
			if (fallback === "native") {
				return { provider: "native", model: "nomic-embed-text-v1.5", dimensions: 768 };
			}
			if (fallback === "openai") {
				return promptOpenAIEmbeddingModel();
			}
			return { provider: "none" };
		}

		return { provider: "ollama", model, dimensions: getEmbeddingDimensions(model) };
	}
}

export function resolveCommandPath(
	command: string,
	opts: {
		readonly currentPlatform?: NodeJS.Platform;
		readonly probe?: (path: string) => boolean;
		readonly lookup?: () => string | undefined;
	} = {},
): string | undefined {
	try {
		const resolved = opts.lookup
			? opts.lookup()
			: (() => {
					const result = spawnSync(process.platform === "win32" ? "where" : "which", [command], {
						encoding: "utf8",
						stdio: ["ignore", "pipe", "ignore"],
						timeout: COMMAND_DETECTION_TIMEOUT_MS,
						windowsHide: true,
					});
					if (result.status !== 0) return undefined;
					return result.stdout
						.split(/\r?\n/)
						.map((line) => line.trim())
						.find(Boolean);
				})();
		if (resolved && (opts.probe ?? probeCommand)(resolved)) return resolved;

		if ((opts.currentPlatform ?? platform()) !== "darwin") return undefined;
		return resolveMacOSCommandPath(command, opts.probe);
	} catch {
		return (opts.currentPlatform ?? platform()) === "darwin" ? resolveMacOSCommandPath(command, opts.probe) : undefined;
	}
}

export function resolveMacOSCommandPath(
	command: string,
	probe: (path: string) => boolean = probeCommand,
): string | undefined {
	for (const path of MACOS_COMMAND_PATHS[command] ?? []) {
		if (probe(path)) return path;
	}
	return undefined;
}

export function hasCommand(command: string): boolean {
	return probeCommand(command);
}

function probeCommand(command: string): boolean {
	try {
		const result = spawnSync(command, ["--version"], {
			stdio: "ignore",
			timeout: COMMAND_DETECTION_TIMEOUT_MS,
			windowsHide: true,
		});
		return result.status === 0;
	} catch {
		return false;
	}
}

async function runCommandWithOutput(
	command: string,
	args: string[],
	options?: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number },
): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		const proc = spawn(command, args, {
			cwd: options?.cwd,
			env: options?.env,
			timeout: options?.timeout,
			windowsHide: true,
		});

		let stdout = "";
		let stderr = "";

		proc.stdout?.on("data", (data: Buffer) => {
			stdout += data.toString();
		});
		proc.stderr?.on("data", (data: Buffer) => {
			stderr += data.toString();
		});

		proc.on("close", (code) => {
			resolve({ code: code ?? 1, stdout, stderr });
		});
		proc.on("error", (err) => {
			resolve({ code: 1, stdout, stderr: err.message });
		});
	});
}

function printOllamaInstallInstructions(): void {
	console.log(chalk.dim("  Install Ollama:"));
	if (platform() === "darwin") {
		console.log(chalk.dim("    brew install ollama"));
		console.log(chalk.dim("    open -a Ollama"));
		return;
	}
	if (platform() === "linux") {
		console.log(chalk.dim("    curl -fsSL https://ollama.com/install.sh | sh"));
		console.log(chalk.dim("    ollama serve"));
		return;
	}
	console.log(chalk.dim("    https://ollama.com/download"));
}

export async function offerOllamaInstallFlow(
	opts: {
		readonly currentPlatform?: NodeJS.Platform;
		readonly confirmInstall?: () => Promise<boolean>;
		readonly resolvePath?: (command: string) => string | undefined;
		readonly runCommand?: typeof runCommandWithOutput;
	} = {},
): Promise<boolean> {
	const installNow = await (
		opts.confirmInstall ??
		(() => confirm({ message: "Ollama is not installed. Try to install it now?", default: true }))
	)();
	if (!installNow) {
		printOllamaInstallInstructions();
		return false;
	}

	if ((opts.currentPlatform ?? platform()) === "darwin") {
		const brewPath = (opts.resolvePath ?? resolveCommandPath)("brew");
		if (!brewPath) {
			console.log(chalk.yellow("  Homebrew not found, cannot auto-install."));
			printOllamaInstallInstructions();
			return false;
		}

		const spinner = ora("Installing Ollama with Homebrew...").start();
		const result = await (opts.runCommand ?? runCommandWithOutput)(brewPath, ["install", "ollama"], {
			env: { ...process.env },
			timeout: 300000,
		});
		if (result.code !== 0) {
			spinner.fail("Ollama install failed");
			if (result.stderr.trim()) {
				console.log(chalk.dim(`  ${result.stderr.trim()}`));
			}
			printOllamaInstallInstructions();
			return false;
		}
		spinner.succeed("Ollama installed");
		return hasCommand("ollama");
	}

	if ((opts.currentPlatform ?? platform()) === "linux") {
		const spinner = ora("Installing Ollama...").start();
		const result = await (opts.runCommand ?? runCommandWithOutput)(
			"sh",
			["-c", "curl -fsSL https://ollama.com/install.sh | sh"],
			{
				env: { ...process.env },
				timeout: 300000,
			},
		);
		if (result.code !== 0) {
			spinner.fail("Ollama install failed");
			if (result.stderr.trim()) {
				console.log(chalk.dim(`  ${result.stderr.trim()}`));
			}
			printOllamaInstallInstructions();
			return false;
		}
		spinner.succeed("Ollama installed");
		return hasCommand("ollama");
	}

	console.log(chalk.yellow("  Automated install is not available on this platform."));
	printOllamaInstallInstructions();
	return false;
}

async function queryLlamaCppModels(
	baseUrl = `http://${LOOPBACK_HOST}:8080`,
): Promise<{ available: boolean; models: string[]; error?: string }> {
	try {
		const response = await fetch(`${baseUrl.replace(/\/$/, "")}/v1/models`, {
			signal: AbortSignal.timeout(2000),
		});
		if (!response.ok) {
			return { available: false, models: [], error: `llama.cpp returned ${response.status}` };
		}

		const raw = await response.json();
		if (typeof raw !== "object" || raw === null || !("data" in raw) || !Array.isArray(raw.data)) {
			return { available: false, models: [], error: "llama.cpp returned unexpected response shape" };
		}
		const models = raw.data.flatMap((item: unknown): string[] => {
			if (typeof item !== "object" || item === null || !("id" in item)) return [];
			const id = (item as { id?: unknown }).id;
			return typeof id === "string" && id.trim().length > 0 ? [id.trim()] : [];
		});
		if (models.length === 0) {
			return { available: false, models: [], error: "llama.cpp server reachable but no models loaded" };
		}
		return { available: true, models };
	} catch (err) {
		return { available: false, models: [], error: readErr(err) };
	}
}

export async function hasLlamaCppServer(): Promise<boolean> {
	const result = await queryLlamaCppModels();
	return result.available;
}

async function queryOllamaModels(
	baseUrl = `http://${LOOPBACK_HOST}:11434`,
): Promise<{ available: boolean; models: string[]; error?: string }> {
	try {
		const response = await fetch(`${baseUrl.replace(/\/$/, "")}/api/tags`, {
			signal: AbortSignal.timeout(5000),
		});
		if (!response.ok) {
			return { available: false, models: [], error: `Ollama returned ${response.status}` };
		}

		const data = (await response.json()) as { models?: Array<{ name?: string }> };
		const models = (data.models ?? [])
			.map((model) => model.name?.trim())
			.filter((model): model is string => Boolean(model));
		return { available: true, models };
	} catch (err) {
		return { available: false, models: [], error: readErr(err) };
	}
}

function hasOllamaModel(models: string[], model: string): boolean {
	return models.some((entry) => entry === model || entry.startsWith(`${model}:`));
}

async function pullOllamaModel(model: string): Promise<boolean> {
	const spinner = ora(`Pulling ${model}...`).start();
	const result = await runCommandWithOutput("ollama", ["pull", model], {
		env: { ...process.env },
		timeout: 600000,
	});
	if (result.code !== 0) {
		spinner.fail(`Failed to pull ${model}`);
		if (result.stderr.trim()) {
			console.log(chalk.dim(`  ${result.stderr.trim()}`));
		}
		return false;
	}
	spinner.succeed(`Model ${model} is ready`);
	return true;
}

async function promptOllamaFailureFallback(): Promise<"retry" | "native" | "openai" | "none"> {
	console.log();
	return select({
		message: "How do you want to continue?",
		choices: [
			{ value: "native", name: "Use built-in embeddings (recommended)" },
			{ value: "retry", name: "Retry Ollama checks" },
			{ value: "openai", name: "Switch to OpenAI" },
			{ value: "none", name: "Continue without embeddings" },
		],
	});
}
