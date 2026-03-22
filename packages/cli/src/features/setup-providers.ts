import { confirm, select } from "@inquirer/prompts";
import chalk from "chalk";
import { platform } from "node:os";
import ora from "ora";
import { spawn, spawnSync } from "node:child_process";
import { getEmbeddingDimensions, readErr } from "./setup-shared.js";

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

export function hasCommand(command: string): boolean {
	try {
		const result = spawnSync(command, ["--version"], { stdio: "ignore", windowsHide: true });
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

async function offerOllamaInstallFlow(): Promise<boolean> {
	const installNow = await confirm({ message: "Ollama is not installed. Try to install it now?", default: true });
	if (!installNow) {
		printOllamaInstallInstructions();
		return false;
	}

	if (platform() === "darwin") {
		if (!hasCommand("brew")) {
			console.log(chalk.yellow("  Homebrew not found, cannot auto-install."));
			printOllamaInstallInstructions();
			return false;
		}

		const spinner = ora("Installing Ollama with Homebrew...").start();
		const result = await runCommandWithOutput("brew", ["install", "ollama"], {
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

	if (platform() === "linux") {
		const spinner = ora("Installing Ollama...").start();
		const result = await runCommandWithOutput("sh", ["-c", "curl -fsSL https://ollama.com/install.sh | sh"], {
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

	console.log(chalk.yellow("  Automated install is not available on this platform."));
	printOllamaInstallInstructions();
	return false;
}

async function queryOllamaModels(baseUrl = "http://localhost:11434"): Promise<{ available: boolean; models: string[]; error?: string }> {
	try {
		const response = await fetch(`${baseUrl.replace(/\/$/, "")}/api/tags`, {
			signal: AbortSignal.timeout(5000),
		});
		if (!response.ok) {
			return { available: false, models: [], error: `Ollama returned ${response.status}` };
		}

		const data = (await response.json()) as { models?: Array<{ name?: string }> };
		const models = (data.models ?? []).map((model) => model.name?.trim()).filter((model): model is string => Boolean(model));
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
