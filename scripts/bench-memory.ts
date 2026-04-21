#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(join(dirname(fileURLToPath(import.meta.url)), ".."));
const openRouterBaseUrl = "https://openrouter.ai/api/v1";
const openRouterExtractionModel = "inception/mercury-2";
const memorybenchCommands = new Set([
	"run",
	"compare",
	"ingest",
	"search",
	"test",
	"status",
	"list-questions",
	"show-failures",
	"serve",
	"help",
]);

interface ParsedArgs {
	passthrough: string[];
	build: boolean;
	dryRun: boolean;
	full: boolean;
	ingestOpenRouter: boolean;
	keepWorkspace: boolean;
	port?: number;
	profile: "rules" | "supermemory-parity";
	reset: boolean;
	workspace?: string;
}

function parseArgs(raw: string[]): ParsedArgs {
	const passthrough: string[] = [];
	let build = process.env.SIGNET_BENCH_SKIP_BUILD !== "1";
	let dryRun = false;
	let full = process.env.SIGNET_BENCH_FULL === "1";
	let ingestOpenRouter = process.env.SIGNET_BENCH_INGEST_OPENROUTER === "1";
	let keepWorkspace = process.env.SIGNET_BENCH_KEEP_WORKSPACE === "1";
	let port: number | undefined;
	let profile: "rules" | "supermemory-parity" =
		process.env.SIGNET_BENCH_PROFILE === "supermemory-parity" ? "supermemory-parity" : "rules";
	let reset = process.env.SIGNET_BENCH_RESUME !== "1";
	let workspace: string | undefined;

	for (let i = 0; i < raw.length; i++) {
		const arg = raw[i];
		if (arg === "--no-build") {
			build = false;
		} else if (arg === "--dry-run") {
			dryRun = true;
		} else if (arg === "--full") {
			full = true;
		} else if (arg === "--ingest-openrouter") {
			ingestOpenRouter = true;
		} else if (arg === "--keep-workspace") {
			keepWorkspace = true;
		} else if (arg === "--workspace") {
			const next = raw[++i];
			if (!next) throw new Error("--workspace requires a path");
			workspace = resolve(next);
			keepWorkspace = true;
		} else if (arg === "--port") {
			const next = raw[++i];
			const parsed = Number.parseInt(next ?? "", 10);
			if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
				throw new Error(`Invalid --port value: ${next}`);
			}
			port = parsed;
		} else if (arg === "--profile") {
			const next = raw[++i];
			if (next !== "rules" && next !== "supermemory-parity") {
				throw new Error("--profile must be either rules or supermemory-parity");
			}
			profile = next;
		} else if (arg === "--reset") {
			reset = true;
		} else if (arg === "--resume") {
			reset = false;
		} else {
			passthrough.push(arg);
		}
	}

	return {
		passthrough,
		build,
		dryRun,
		full,
		ingestOpenRouter,
		keepWorkspace,
		port,
		profile,
		reset,
		workspace,
	};
}

function getMemoryBenchCommand(raw: string[]): string {
	return raw.length > 0 && memorybenchCommands.has(raw[0]) ? raw[0] : "run";
}

function hasSelection(args: string[]): boolean {
	return args.some(
		(arg) =>
			arg === "--limit" ||
			arg === "-l" ||
			arg === "--sample" ||
			arg === "-s" ||
			arg === "--question-id" ||
			arg === "--question-ids-file" ||
			arg === "-q",
	);
}

function hasOption(args: string[], long: string, short?: string): boolean {
	return args.some((arg) => arg === long || (short !== undefined && arg === short));
}

async function findFreePort(): Promise<number> {
	return new Promise((resolvePort, reject) => {
		const server = net.createServer();
		server.unref();
		server.on("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") {
				server.close(() => reject(new Error("Could not resolve free port")));
				return;
			}
			const port = address.port;
			server.close(() => resolvePort(port));
		});
	});
}

function run(command: string, args: string[], env?: NodeJS.ProcessEnv, cwd = repoRoot): Promise<void> {
	return new Promise((resolveRun, reject) => {
		const child = spawn(command, args, {
			cwd,
			env: env ?? process.env,
			stdio: "inherit",
		});
		child.on("error", reject);
		child.on("exit", (code, signal) => {
			if (code === 0) {
				resolveRun();
			} else {
				reject(new Error(`${command} ${args.join(" ")} failed with ${signal ?? code}`));
			}
		});
	});
}

async function waitForHealth(baseUrl: string, timeoutMs: number): Promise<void> {
	const started = Date.now();
	let lastError = "not ready";

	while (Date.now() - started < timeoutMs) {
		try {
			const response = await fetch(`${baseUrl}/health`);
			if (response.ok) {
				const body = (await response.json()) as {
					status?: string;
					db?: boolean;
				};
				if (body.status === "healthy" && body.db === true) return;
				lastError = JSON.stringify(body);
			} else {
				lastError = `${response.status} ${response.statusText}`;
			}
		} catch (error) {
			lastError = error instanceof Error ? error.message : String(error);
		}
		await Bun.sleep(500);
	}

	throw new Error(`Timed out waiting for isolated Signet daemon: ${lastError}`);
}

function writeIsolatedWorkspace(dir: string): void {
	mkdirSync(join(dir, "memory"), { recursive: true });
	mkdirSync(join(dir, ".daemon", "logs"), { recursive: true });
	writeFileSync(join(dir, "AGENTS.md"), "# MemoryBench Agent\n\nIsolated benchmark workspace.\n");
	writeFileSync(join(dir, "SOUL.md"), "# MemoryBench\n\nBenchmark-only identity.\n");
	writeFileSync(join(dir, "IDENTITY.md"), "# MemoryBench\n\nTemporary benchmark agent.\n");
	writeFileSync(join(dir, "USER.md"), "# MemoryBench\n\nSynthetic benchmark user.\n");
	writeFileSync(join(dir, "MEMORY.md"), "# MemoryBench Working Memory\n\nNo production memory is mounted here.\n");

	const embeddingProvider = process.env.SIGNET_BENCH_EMBEDDING_PROVIDER || "native";
	writeFileSync(
		join(dir, "agent.yaml"),
		`configVersion: 2\n\nagent:\n  name: memorybench\n\nauth:\n  mode: local\n\nembedding:\n  provider: ${embeddingProvider}\n  model: ${process.env.SIGNET_BENCH_EMBEDDING_MODEL || "nomic-embed-text-v1.5"}\n  dimensions: ${process.env.SIGNET_BENCH_EMBEDDING_DIMENSIONS || "768"}\n\nsearch:\n  alpha: 0.7\n  top_k: 20\n  min_score: 0.1\n  rehearsal_enabled: false\n\nmemory:\n  pipelineV2:\n    enabled: false\n    graph:\n      enabled: true\n      extractionWritesEnabled: false\n    traversal:\n      enabled: true\n    structural:\n      enabled: false\n      synthesisEnabled: false\n      supersessionSweepEnabled: false\n    reranker:\n      enabled: false\n    autonomous:\n      enabled: false\n    synthesis:\n      enabled: false\n    procedural:\n      enabled: false\n    predictor:\n      enabled: false\n    hints:\n      enabled: true\n    guardrails:\n      maxContentChars: 100000\n      chunkTargetChars: 50000\n      recallTruncateChars: 20000\n`,
	);
}

function hasProvider(args: string[]): boolean {
	return hasOption(args, "--provider", "-p");
}

function hasBenchmark(args: string[]): boolean {
	return hasOption(args, "--benchmark", "-b");
}

function hasRunId(args: string[]): boolean {
	return hasOption(args, "--run-id", "-r");
}

function hasFromPhase(args: string[]): boolean {
	return hasOption(args, "--from-phase", "-f");
}

function isContinuationCommand(command: string, args: string[]): boolean {
	return (
		command === "run" &&
		!hasProvider(args) &&
		!hasBenchmark(args) &&
		(hasRunId(args) || (hasFromPhase(args) && Boolean(process.env.SIGNET_BENCH_RUN_ID)))
	);
}

function buildMemoryBenchArgs(raw: string[], full: boolean, profile: ParsedArgs["profile"], reset: boolean): string[] {
	const command = getMemoryBenchCommand(raw);
	const args = command === raw[0] ? raw.slice(1) : raw;

	if (command !== "run" && command !== "ingest") return [command, ...args];

	const runId =
		process.env.SIGNET_BENCH_RUN_ID ||
		`signet-${profile}-longmemeval-${new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "Z")}`;

	const provider = profile === "supermemory-parity" ? "signet-supermemory-parity" : "signet";
	const continuation = isContinuationCommand(command, args);
	const defaults: string[] = [];

	if (!continuation && !hasProvider(args)) defaults.push("-p", provider);
	if (!continuation && !hasBenchmark(args)) defaults.push("-b", "longmemeval");
	if (!hasRunId(args)) defaults.push("-r", runId);
	if (!continuation && reset && !hasOption(args, "--force")) defaults.push("--force");

	if (command === "run" && !hasOption(args, "--judge", "-j")) {
		const judge = process.env.SIGNET_BENCH_JUDGE;
		if (!continuation || judge) defaults.push("-j", judge || "gpt-4o");
	}
	if (command === "run" && !hasOption(args, "--answering-model", "-m")) {
		const answeringModel = process.env.SIGNET_BENCH_ANSWERING_MODEL;
		if (!continuation || answeringModel) defaults.push("-m", answeringModel || "gpt-4o");
	}
	if (!continuation && !full && !hasSelection(args)) {
		defaults.push("--sample", process.env.SIGNET_BENCH_SAMPLE_PER_TYPE || "1");
	}

	return [command, ...defaults, ...args];
}

function defaultedDevSample(raw: string[], full: boolean): boolean {
	const command = getMemoryBenchCommand(raw);
	const args = command === raw[0] ? raw.slice(1) : raw;
	return command === "run" && !isContinuationCommand(command, args) && !full && !hasSelection(args);
}

function buildOpenRouterIngestEnv(): NodeJS.ProcessEnv {
	return {
		OPENAI_API_KEY: process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY || "",
		OPENAI_BASE_URL: process.env.SIGNET_BENCH_OPENROUTER_BASE_URL || openRouterBaseUrl,
		MEMORYBENCH_EXTRACTION_MODEL:
			process.env.SIGNET_BENCH_OPENROUTER_MODEL ||
			process.env.MEMORYBENCH_EXTRACTION_MODEL ||
			openRouterExtractionModel,
	};
}

async function main(): Promise<void> {
	const parsed = parseArgs(process.argv.slice(2));
	const command = getMemoryBenchCommand(parsed.passthrough);
	const useOpenRouterIngest = parsed.ingestOpenRouter && command === "ingest";
	const port = parsed.port ?? (await findFreePort());
	const baseUrl = `http://127.0.0.1:${port}`;
	const workspace = parsed.workspace ?? (await mkdtemp(join(tmpdir(), "signet-memorybench-")));
	const home = join(workspace, "home");
	mkdirSync(home, { recursive: true });
	writeIsolatedWorkspace(workspace);

	const usesDefaultSample = defaultedDevSample(parsed.passthrough, parsed.full);
	const memorybenchArgs = buildMemoryBenchArgs(parsed.passthrough, parsed.full, parsed.profile, parsed.reset);
	const env = {
		...process.env,
		...(useOpenRouterIngest ? buildOpenRouterIngestEnv() : {}),
		HOME: home,
		SIGNET_PATH: workspace,
		SIGNET_PORT: String(port),
		SIGNET_HOST: "127.0.0.1",
		SIGNET_BIND: "127.0.0.1",
		SIGNET_BENCH_DAEMON_URL: baseUrl,
		SIGNET_BENCH_AGENT_ID: process.env.SIGNET_BENCH_AGENT_ID || "memorybench",
		SIGNET_BENCH_PROFILE: parsed.profile,
		SIGNET_BENCH_PROJECT: process.env.SIGNET_BENCH_PROJECT || "memorybench",
	};

	console.log(`MemoryBench workspace: ${workspace}`);
	if (parsed.workspace) {
		console.log("Using persistent benchmark workspace; existing Signet DB files will be reused if present.");
	}
	console.log(`Isolated Signet daemon: ${baseUrl}`);
	if (usesDefaultSample) {
		console.log("Using dev-sized LongMemEval sample. Pass --full or --limit/--sample for a different run size.");
	}
	console.log(`Benchmark profile: ${parsed.profile}`);
	if (parsed.ingestOpenRouter && !useOpenRouterIngest) {
		console.log("--ingest-openrouter only applies to bench:ingest; leaving current command model config unchanged.");
	}
	if (useOpenRouterIngest) {
		console.log(`OpenRouter ingestion: enabled (${env.MEMORYBENCH_EXTRACTION_MODEL})`);
	}
	console.log(`MemoryBench command: bun src/index.ts ${memorybenchArgs.join(" ")}`);

	if (parsed.dryRun) {
		if (!parsed.keepWorkspace) await rm(workspace, { recursive: true, force: true });
		return;
	}

	let daemon: ReturnType<typeof spawn> | null = null;
	try {
		if (parsed.build) {
			await run("bun", ["run", "build"]);
		}

		daemon = spawn("bun", ["packages/daemon/src/daemon.ts"], {
			cwd: repoRoot,
			env,
			stdio: ["ignore", "inherit", "inherit"],
		});
		daemon.on("exit", (code, signal) => {
			if (code !== 0 && code !== null) {
				console.error(`Isolated Signet daemon exited with ${signal ?? code}`);
			}
		});

		await waitForHealth(baseUrl, 60_000);
		await run("bun", ["src/index.ts", ...memorybenchArgs], env, join(repoRoot, "memorybench"));
	} finally {
		if (daemon && daemon.exitCode === null) {
			daemon.kill("SIGTERM");
			await new Promise((resolveKill) => daemon?.once("exit", resolveKill));
		}
		if (parsed.keepWorkspace) {
			console.log(`Kept MemoryBench workspace: ${workspace}`);
		} else {
			await rm(workspace, { recursive: true, force: true });
		}
	}
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
});
