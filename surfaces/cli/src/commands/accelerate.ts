import chalk from "chalk";
import type { Command } from "commander";
import ora from "ora";
import type { DaemonFetch } from "../lib/daemon.js";
import {
	type AccelerationMode,
	acceleratorPaths,
	applyAccelerationConfig,
	installCpuRuntime,
	installCudaRuntime,
	readAccelerationStatus,
} from "../features/accelerate/index.js";
import { cudaSupportProblem, detectNvidiaGpus } from "../features/accelerate/detect.js";
import { ONNXRUNTIME_NODE_VERSION, platformKey } from "../features/accelerate/manifest.js";

interface AccelerateDeps {
	readonly AGENTS_DIR: string;
	readonly fetchFromDaemon: DaemonFetch;
}

interface RecallProbe {
	readonly results?: readonly unknown[];
	readonly meta?: {
		readonly reranker?: { readonly kind?: string; readonly device?: string; readonly fallback?: string };
		readonly timings?: { readonly totalMs?: number };
	};
}

async function printStatus(deps: AccelerateDeps, json: boolean): Promise<void> {
	const status = await readAccelerationStatus(deps.AGENTS_DIR);
	const gpus = detectNvidiaGpus();
	const cudaProblem = cudaSupportProblem(gpus, status.platform);
	if (json) {
		console.log(JSON.stringify({ ...status, gpus, cudaAvailable: cudaProblem === null, cudaProblem }, null, 2));
		return;
	}
	console.log(chalk.bold("\n  Recall acceleration\n"));
	console.log(`  Platform            ${status.platform}`);
	console.log(
		`  GPU                 ${gpus.length > 0 ? gpus.map((gpu) => `${gpu.name} (driver ${gpu.driver}, ${gpu.memoryMiB} MiB)`).join("; ") : "none detected"}`,
	);
	console.log(
		`  Native runtime      ${status.cpuRuntimeInstalled ? chalk.green(`installed (onnxruntime ${ONNXRUNTIME_NODE_VERSION})`) : chalk.dim("not installed")}`,
	);
	console.log(
		`  CUDA libraries      ${status.cudaFilesPresent ? chalk.green("installed") : chalk.dim(cudaProblem ? `unavailable: ${cudaProblem}` : "not installed")}`,
	);
	console.log(
		`  Embeddings          ${status.embeddingRuntime === "onnxruntime" ? "native ONNX runtime" : "WebAssembly (default)"}`,
	);
	console.log(
		`  Cross-encoder       ${status.rerankerDevice === "default" ? "WebAssembly (default)" : status.rerankerDevice === "cpu" ? "native CPU" : "CUDA"}`,
	);
	console.log(chalk.dim(`\n  Files: ${status.paths.root}`));
	console.log(chalk.dim("  Run `signet accelerate cpu` or `signet accelerate cuda`, then `signet restart`.\n"));
}

function updateConfig(deps: AccelerateDeps, mode: AccelerationMode): ReturnType<typeof applyAccelerationConfig> | null {
	try {
		return applyAccelerationConfig(deps.AGENTS_DIR, mode, acceleratorPaths(deps.AGENTS_DIR));
	} catch (error) {
		console.error(
			chalk.red(`  Cannot update the Signet config: ${error instanceof Error ? error.message : String(error)}`),
		);
		process.exitCode = 1;
		return null;
	}
}

async function enable(deps: AccelerateDeps, mode: Exclude<AccelerationMode, "off">): Promise<void> {
	const platform = platformKey();
	if (mode === "cuda") {
		const problem = cudaSupportProblem(detectNvidiaGpus(), platform);
		if (problem) {
			console.error(chalk.red(`  Cannot enable CUDA: ${problem}.`));
			console.error(chalk.dim("  `signet accelerate cpu` installs the native CPU runtime instead."));
			process.exitCode = 1;
			return;
		}
	}
	const paths = acceleratorPaths(deps.AGENTS_DIR);
	const spinner = ora("Preparing").start();
	let received = 0;
	let label = "";
	const events = {
		onStep: (message: string) => {
			label = message;
			received = 0;
			spinner.text = message;
		},
		onProgress: (bytes: number) => {
			received += bytes;
			spinner.text = `${label} - ${(received / 1_048_576).toFixed(0)} MB`;
		},
	};
	try {
		const cpu = await installCpuRuntime(paths, events, platform);
		if (mode === "cuda") await installCudaRuntime(paths, events, platform);
		spinner.succeed(
			cpu === "present" && mode === "cpu" ? "Native runtime already installed" : "Runtime files installed and verified",
		);
	} catch (error) {
		spinner.fail(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
		return;
	}
	const change = updateConfig(deps, mode);
	if (change === null) return;
	console.log(chalk.green(`  Updated ${change.file}: cross-encoder on ${mode === "cuda" ? "CUDA" : "native CPU"}.`));
	if (change.embeddingSkipped) console.log(chalk.dim(`  Embeddings unchanged: ${change.embeddingSkipped}.`));
	if (change.embeddingRuntimeChanged) {
		console.log(
			chalk.yellow(
				"  Embeddings switch to the native runtime. Its vectors differ slightly from WebAssembly's, so the daemon re-embeds your memories in the background; recall keeps using the current vectors until that finishes.",
			),
		);
	}
	console.log(chalk.dim("  Restart the daemon (`signet restart`), then run `signet accelerate verify`."));
}

function disable(deps: AccelerateDeps): void {
	const change = updateConfig(deps, "off");
	if (change === null) return;
	console.log(chalk.green(`  Updated ${change.file}: back to the WebAssembly runtime.`));
	if (change.embeddingRuntimeChanged) {
		console.log(
			chalk.yellow("  Embeddings switch back to WebAssembly, which re-embeds your memories in the background."),
		);
	}
	console.log(chalk.dim("  Runtime files stay in place; restart the daemon to apply."));
}

async function verify(deps: AccelerateDeps, timeoutMs: number): Promise<void> {
	const expected = (await readAccelerationStatus(deps.AGENTS_DIR)).rerankerDevice;
	const spinner = ora("Asking the daemon for a full-quality recall").start();
	const deadline = Date.now() + timeoutMs;
	let last: RecallProbe | null = null;
	while (Date.now() < deadline) {
		last = await deps.fetchFromDaemon<RecallProbe>("/api/memory/recall", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ query: "signet accelerate verification", limit: 3, trackRecallAccess: false }),
			timeout: Math.max(1, Math.min(30_000, deadline - Date.now())),
		});
		if (last === null) {
			spinner.fail("The daemon is not reachable. Start it with `signet start`.");
			process.exitCode = 1;
			return;
		}
		if (last.meta?.reranker?.kind === "cross-encoder") break;
		if (last.results?.length === 0) {
			spinner.warn("Acceleration not verified: no matching memories to rerank. Add a memory, then retry verification.");
			process.exitCode = 1;
			return;
		}
		const remaining = deadline - Date.now();
		if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(1_000, remaining)));
	}
	const reranker = last?.meta?.reranker;
	if (reranker?.kind !== "cross-encoder") {
		spinner.fail(
			`The cross-encoder did not answer within ${Math.round(timeoutMs / 1000)}s (${reranker?.fallback ?? "no reason reported"}).`,
		);
		process.exitCode = 1;
		return;
	}
	const device = reranker.device ?? "default";
	if (expected !== "default" && device !== expected) {
		spinner.warn(
			`The cross-encoder ran on ${device}, not ${expected} (daemon reported ${JSON.stringify(reranker)}); check the daemon log for the runtime error.`,
		);
		process.exitCode = 1;
		return;
	}
	spinner.succeed(`Cross-encoder answered on ${device} (${Math.round(last?.meta?.timings?.totalMs ?? 0)} ms recall).`);
}

export function registerAccelerateCommands(program: Command, deps: AccelerateDeps): void {
	const accelerate = program
		.command("accelerate")
		.description("Install and enable native or CUDA acceleration for recall")
		.option("--json", "Output status as JSON")
		.action((opts: { json?: boolean }) => printStatus(deps, opts.json === true));
	accelerate
		.command("status")
		.description("Show detected hardware and the active recall runtimes")
		.option("--json", "Output as JSON")
		.action((opts: { json?: boolean }) => printStatus(deps, opts.json === true));
	accelerate
		.command("cpu")
		.description("Use the native ONNX runtime on CPU for embeddings and the cross-encoder")
		.action(async () => enable(deps, "cpu"));
	accelerate
		.command("cuda")
		.description("Run the cross-encoder on an NVIDIA GPU (installs ONNX Runtime CUDA and CUDA 12 libraries)")
		.action(async () => enable(deps, "cuda"));
	accelerate
		.command("off")
		.description("Return to the default WebAssembly runtime")
		.action(() => disable(deps));
	accelerate
		.command("verify")
		.description("Check that the running daemon reranks on the configured device")
		.option("--timeout <seconds>", "How long to wait for the model to load", "120")
		.action(async (opts: { timeout: string }) => {
			const seconds = Number(opts.timeout);
			const timeoutMs = Math.max(5, seconds || 120) * 1000;
			if (!Number.isFinite(seconds) || !Number.isFinite(timeoutMs)) {
				console.error(chalk.red(`  --timeout must be a finite number of seconds, got ${opts.timeout}.`));
				process.exitCode = 1;
				return;
			}
			await verify(deps, timeoutMs);
		});
}
