#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

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

export type BenchProfile = "rules" | "dreaming" | "supermemory-parity";

function isBenchProfile(value: string | undefined): value is BenchProfile {
	return value === "rules" || value === "dreaming" || value === "supermemory-parity";
}

interface ParsedArgs {
	passthrough: string[];
	build: boolean;
	dryRun: boolean;
	full: boolean;
	ingestOpenRouter: boolean;
	keepWorkspace: boolean;
	port?: number;
	profile: BenchProfile;
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
	let profile: BenchProfile = isBenchProfile(process.env.SIGNET_BENCH_PROFILE)
		? process.env.SIGNET_BENCH_PROFILE
		: "dreaming";
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
			if (!isBenchProfile(next)) {
				throw new Error("--profile must be rules, dreaming, or supermemory-parity");
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

export interface BenchModelConfig {
	readonly model: string;
	readonly endpoint: string;
	readonly providerFamily: string;
}

export const BENCH_CREDENTIAL_ENV = "SIGNET_BENCH_DREAMING_API_KEY";
const BENCH_ACCOUNT = "memorybench";
const ZAI_CODING_ENDPOINT = "https://open.bigmodel.cn/api/coding/paas/v4";

export function resolveBenchModel(env: NodeJS.ProcessEnv = process.env): BenchModelConfig {
	return {
		model: env.SIGNET_BENCH_DREAMING_MODEL?.trim() || "glm-5.3-flash",
		endpoint: env.SIGNET_BENCH_DREAMING_ENDPOINT?.trim() || ZAI_CODING_ENDPOINT,
		providerFamily: env.SIGNET_BENCH_DREAMING_PROVIDER_FAMILY?.trim() || "zai-coding-cn",
	};
}

export function buildSetupArgs(agentsDir: string, port: number, model: BenchModelConfig): string[] {
	return [
		"surfaces/cli/src/cli.ts",
		"setup",
		"--path",
		agentsDir,
		"--non-interactive",
		"--name",
		"memorybench",
		"--skip-git",
		"--embedding-provider",
		"native",
		"--extraction-provider",
		"openai-compatible",
		"--extraction-model",
		model.model,
		"--extraction-endpoint",
		model.endpoint,
		"--disable-graphiq",
		"--remote-url",
		`http://127.0.0.1:${port}`,
	];
}

export function attachBenchCredential(agentsDir: string, providerFamily: string): void {
	const path = join(agentsDir, "agent.yaml");
	const config = parseYaml(readFileSync(path, "utf8")) as Record<string, unknown>;
	const inference = config.inference as Record<string, unknown> | undefined;
	const targets = inference?.targets as Record<string, Record<string, unknown>> | undefined;
	const target = inference?.defaultPolicy === "background" ? targets?.background : undefined;
	if (!inference || !target) {
		throw new Error("Signet setup did not write the expected background inference target");
	}
	inference.accounts = {
		...(inference.accounts as Record<string, unknown> | undefined),
		[BENCH_ACCOUNT]: { kind: "api", providerFamily, credentialRef: BENCH_CREDENTIAL_ENV },
	};
	target.account = BENCH_ACCOUNT;
	target.privacy = "restricted_remote";
	if (providerFamily !== "openai-compatible") {
		target.executor = providerFamily;
		delete target.endpoint;
	}
	writeFileSync(path, stringifyYaml(config));
}

export function loadEnvFile(path: string, env: NodeJS.ProcessEnv = process.env): void {
	if (!existsSync(path)) return;
	for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
		const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
		if (!match || env[match[1]] !== undefined) continue;
		env[match[1]] = match[2].replace(/^(["'])(.*)\1$/, "$2");
	}
}

function isSetUp(agentsDir: string): boolean {
	return existsSync(join(agentsDir, "agent.yaml")) && existsSync(join(agentsDir, "data", "signet.db"));
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

	const provider =
		profile === "supermemory-parity"
			? "signet-supermemory-parity"
			: profile === "dreaming"
				? "signet-dreaming"
				: "signet";
	const continuation = isContinuationCommand(command, args);
	const defaults: string[] = [];

	if (!continuation && !hasProvider(args)) defaults.push("-p", provider);
	if (!continuation && !hasBenchmark(args)) defaults.push("-b", "longmemeval");
	if (!hasRunId(args)) defaults.push("-r", runId);
	if (!continuation && reset && !hasOption(args, "--force")) defaults.push("--force");

	if (command === "run" && !hasOption(args, "--judge", "-j")) {
		const judge = process.env.SIGNET_BENCH_JUDGE;
		if (!continuation || judge) defaults.push("-j", judge || "glm-5.3-flash");
	}
	if (command === "run" && !hasOption(args, "--answering-model", "-m")) {
		const answeringModel = process.env.SIGNET_BENCH_ANSWERING_MODEL;
		if (!continuation || answeringModel) defaults.push("-m", answeringModel || "glm-5.3-flash");
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
	loadEnvFile(join(repoRoot, "memorybench", ".env"));
	const parsed = parseArgs(process.argv.slice(2));
	const command = getMemoryBenchCommand(parsed.passthrough);
	const useOpenRouterIngest = parsed.ingestOpenRouter && command === "ingest";
	const port = parsed.port ?? (await findFreePort());
	const baseUrl = `http://127.0.0.1:${port}`;
	const root = parsed.workspace ?? (await mkdtemp(join(tmpdir(), "signet-memorybench-")));
	const home = join(root, "home");
	const agentsDir = join(root, "agents");
	mkdirSync(home, { recursive: true });
	const model = resolveBenchModel();
	const apiKey = process.env.SIGNET_BENCH_DREAMING_API_KEY?.trim() || process.env.ZAI_API_KEY?.trim() || "";
	if (!apiKey && !isLocalEndpoint(model.endpoint)) {
		throw new Error(
			`The benchmark daemon needs an API key for ${model.endpoint}; set ZAI_API_KEY in memorybench/.env or SIGNET_BENCH_DREAMING_API_KEY`,
		);
	}

	const usesDefaultSample = defaultedDevSample(parsed.passthrough, parsed.full);
	const memorybenchArgs = buildMemoryBenchArgs(parsed.passthrough, parsed.full, parsed.profile, parsed.reset);
	const env = {
		...process.env,
		...(useOpenRouterIngest ? buildOpenRouterIngestEnv() : {}),
		HOME: home,
		SIGNET_PATH: agentsDir,
		SIGNET_PORT: String(port),
		SIGNET_HOST: "127.0.0.1",
		SIGNET_BIND: "127.0.0.1",
		[BENCH_CREDENTIAL_ENV]: apiKey,
		SIGNET_BENCH_DAEMON_URL: baseUrl,
		SIGNET_BENCH_AGENT_ID: process.env.SIGNET_BENCH_AGENT_ID || "memorybench",
		SIGNET_BENCH_PROFILE: parsed.profile,
		SIGNET_BENCH_PROJECT: process.env.SIGNET_BENCH_PROJECT || "memorybench",
	};
	const setupArgs = buildSetupArgs(agentsDir, port, model);

	console.log(`MemoryBench workspace: ${root}`);
	console.log(`Isolated Signet daemon: ${baseUrl} (dashboard at ${baseUrl}/)`);
	console.log(`Inference: ${model.model} via ${model.endpoint} (${model.providerFamily})`);
	if (usesDefaultSample) {
		console.log("Using dev-sized LongMemEval sample. Pass --full or --limit/--sample for a different run size.");
	}
	console.log(`Benchmark profile: ${parsed.profile}`);
	if (parsed.ingestOpenRouter && !useOpenRouterIngest) {
		console.log("--ingest-openrouter only applies to bench:ingest; leaving current command model config unchanged.");
	}
	if (useOpenRouterIngest) {
		console.log("OpenRouter ingestion: enabled.");
	}
	console.log(`Workspace setup: bun ${setupArgs.join(" ")}`);
	console.log(`MemoryBench command: bun src/index.ts ${memorybenchArgs.join(" ")}`);

	if (parsed.dryRun) {
		if (!parsed.keepWorkspace) await rm(root, { recursive: true, force: true });
		return;
	}

	let daemon: ReturnType<typeof spawn> | null = null;
	try {
		if (parsed.build) {
			await run("bun", ["run", "build"]);
		}
		if (parsed.build || !existsSync(join(repoRoot, "surfaces", "dashboard", "build", "index.html"))) {
			await run("bun", ["run", "build"], process.env, join(repoRoot, "surfaces", "dashboard"));
		}
		if (isSetUp(agentsDir)) {
			console.log("Reusing the existing benchmark workspace and database.");
		} else {
			await run("bun", setupArgs, env);
			attachBenchCredential(agentsDir, model.providerFamily);
		}

		mkdirSync(join(agentsDir, ".daemon", "logs"), { recursive: true });
		daemon = spawn("bun", ["platform/daemon/src/daemon.ts"], {
			cwd: repoRoot,
			env,
			stdio: ["ignore", "inherit", "inherit"],
		});
		daemon.on("exit", (code, signal) => {
			if (code !== 0 && code !== null) {
				console.error(`Isolated Signet daemon exited with ${signal ?? code}`);
			}
		});

		await waitForHealth(baseUrl, 180_000);
		console.log(`Benchmark dashboard: ${baseUrl}/`);
		await run("bun", ["src/index.ts", ...memorybenchArgs], env, join(repoRoot, "memorybench"));
	} finally {
		if (daemon && daemon.exitCode === null) {
			daemon.kill("SIGTERM");
			await new Promise((resolveKill) => daemon?.once("exit", resolveKill));
		}
		if (parsed.keepWorkspace) {
			console.log(`Kept MemoryBench workspace: ${root}`);
		} else {
			await rm(root, { recursive: true, force: true });
		}
	}
}

if (import.meta.main) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	});
}
