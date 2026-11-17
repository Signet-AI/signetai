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
	const providerFamily = env.SIGNET_BENCH_DREAMING_PROVIDER_FAMILY?.trim() || "zai-coding-cn";
	const openrouter = providerFamily === "openrouter";
	return {
		model:
			env.SIGNET_BENCH_DREAMING_MODEL?.trim() || (openrouter ? "deepseek/deepseek-v4.1-flash-1017" : "glm-5.3-flash"),
		endpoint: env.SIGNET_BENCH_DREAMING_ENDPOINT?.trim() || (openrouter ? openRouterBaseUrl : ZAI_CODING_ENDPOINT),
		providerFamily,
	};
}

export function benchApiKeyEnv(providerFamily: string): string {
	return providerFamily === "openrouter" ? "OPENROUTER_API_KEY" : "ZAI_API_KEY";
}

export function resolveBenchApiKey(env: NodeJS.ProcessEnv, providerFamily: string): string {
	return env[BENCH_CREDENTIAL_ENV]?.trim() || env[benchApiKeyEnv(providerFamily)]?.trim() || "";
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

export function isLocalEndpoint(value: string): boolean {
	let hostname: string;
	try {
		hostname = new URL(value).hostname.toLowerCase();
	} catch {
		return false;
	}
	return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

const SUBSCRIPTION_PROVIDER_FAMILIES: ReadonlySet<string> = new Set(["openai-codex"]);

export function benchUsesSubscription(providerFamily: string): boolean {
	return SUBSCRIPTION_PROVIDER_FAMILIES.has(providerFamily);
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
		[BENCH_ACCOUNT]: benchUsesSubscription(providerFamily)
			? { kind: "subscription_session", providerFamily }
			: { kind: "api", providerFamily, credentialRef: BENCH_CREDENTIAL_ENV },
	};
	target.account = BENCH_ACCOUNT;
	target.privacy = "restricted_remote";
	if (providerFamily !== "openai-compatible") {
		target.executor = providerFamily;
		delete target.endpoint;
	}
	writeFileSync(path, stringifyYaml(config));
}

export function benchDreamingConcurrency(env: NodeJS.ProcessEnv = process.env): number {
	const raw = env.SIGNET_BENCH_DREAMING_CONCURRENCY;
	if (raw === undefined || raw.trim() === "") return 6;
	const parsed = Number(raw);
	if (!Number.isInteger(parsed) || parsed < 1 || parsed > 256) {
		throw new Error("SIGNET_BENCH_DREAMING_CONCURRENCY must be an integer from 1 to 256");
	}
	return parsed;
}

export function setBenchDreamingConcurrency(agentsDir: string, passes: number): void {
	const path = join(agentsDir, "agent.yaml");
	const config = parseYaml(readFileSync(path, "utf8")) as Record<string, unknown>;
	const memory = (config.memory ?? {}) as Record<string, unknown>;
	const dreaming = (memory.dreaming ?? {}) as Record<string, unknown>;
	const pipeline = (memory.pipelineV2 ?? {}) as Record<string, unknown>;
	const worker = (pipeline.worker ?? {}) as Record<string, unknown>;
	const llmConcurrency = Math.min(256, passes + 2);
	if (dreaming.maxConcurrentPasses === passes && worker.maxLlmConcurrency === llmConcurrency) return;
	config.memory = {
		...memory,
		dreaming: { ...dreaming, maxConcurrentPasses: passes },
		pipelineV2: { ...pipeline, worker: { ...worker, maxLlmConcurrency: llmConcurrency } },
	};
	writeFileSync(path, stringifyYaml(config));
}

export function benchDreamingCodemode(env: NodeJS.ProcessEnv = process.env): boolean | undefined {
	const raw = env.SIGNET_BENCH_DREAMING_CODEMODE?.trim();
	if (raw === undefined || raw === "") return undefined;
	if (raw === "1" || raw === "true") return true;
	if (raw === "0" || raw === "false") return false;
	throw new Error("SIGNET_BENCH_DREAMING_CODEMODE must be 1, 0, true, or false");
}

export function setBenchDreamingCodemode(agentsDir: string, enabled: boolean | undefined): void {
	if (enabled === undefined) return;
	const path = join(agentsDir, "agent.yaml");
	const config = parseYaml(readFileSync(path, "utf8")) as Record<string, unknown>;
	const memory = (config.memory ?? {}) as Record<string, unknown>;
	const dreaming = (memory.dreaming ?? {}) as Record<string, unknown>;
	if (dreaming.codemode === enabled) return;
	config.memory = { ...memory, dreaming: { ...dreaming, codemode: enabled } };
	writeFileSync(path, stringifyYaml(config));
}

export function benchDreamingMaxOutputTokens(env: NodeJS.ProcessEnv = process.env): number | undefined {
	const raw = env.SIGNET_BENCH_DREAMING_MAX_OUTPUT_TOKENS?.trim();
	if (raw === undefined || raw === "") return undefined;
	const parsed = Number(raw);
	if (!Number.isInteger(parsed) || parsed < 1_000 || parsed > 1_000_000) {
		throw new Error("SIGNET_BENCH_DREAMING_MAX_OUTPUT_TOKENS must be an integer from 1000 to 1000000");
	}
	return parsed;
}

export function setBenchDreamingMaxOutputTokens(agentsDir: string, maxOutputTokens: number | undefined): void {
	if (maxOutputTokens === undefined) return;
	const path = join(agentsDir, "agent.yaml");
	const config = parseYaml(readFileSync(path, "utf8")) as Record<string, unknown>;
	const memory = (config.memory ?? {}) as Record<string, unknown>;
	const dreaming = (memory.dreaming ?? {}) as Record<string, unknown>;
	if (dreaming.maxOutputTokens === maxOutputTokens) return;
	config.memory = { ...memory, dreaming: { ...dreaming, maxOutputTokens } };
	writeFileSync(path, stringifyYaml(config));
}

export function benchDreamingTimeoutMs(env: NodeJS.ProcessEnv = process.env): number | undefined {
	const raw = env.SIGNET_BENCH_DREAMING_TIMEOUT_MS?.trim();
	if (raw === undefined || raw === "") return undefined;
	const parsed = Number(raw);
	if (!Number.isInteger(parsed) || parsed < 30_000 || parsed > 1_800_000) {
		throw new Error("SIGNET_BENCH_DREAMING_TIMEOUT_MS must be an integer from 30000 to 1800000");
	}
	return parsed;
}

export function setBenchDreamingTimeout(agentsDir: string, timeout: number | undefined): void {
	if (timeout === undefined) return;
	const path = join(agentsDir, "agent.yaml");
	const config = parseYaml(readFileSync(path, "utf8")) as Record<string, unknown>;
	const memory = (config.memory ?? {}) as Record<string, unknown>;
	const dreaming = (memory.dreaming ?? {}) as Record<string, unknown>;
	if (dreaming.timeout === timeout) return;
	config.memory = { ...memory, dreaming: { ...dreaming, timeout } };
	writeFileSync(path, stringifyYaml(config));
}

export function benchDreamingThinking(env: NodeJS.ProcessEnv = process.env): Record<string, unknown> | undefined {
	const raw = env.SIGNET_BENCH_DREAMING_THINKING?.trim();
	if (raw === undefined || raw === "") return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error("SIGNET_BENCH_DREAMING_THINKING must be a JSON object");
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("SIGNET_BENCH_DREAMING_THINKING must be a JSON object");
	}
	if (typeof (parsed as { format?: unknown }).format !== "string") {
		throw new Error("SIGNET_BENCH_DREAMING_THINKING needs a format");
	}
	return parsed as Record<string, unknown>;
}

export function setBenchDreamingThinking(agentsDir: string, thinking: Record<string, unknown> | undefined): void {
	if (thinking === undefined) return;
	const path = join(agentsDir, "agent.yaml");
	const config = parseYaml(readFileSync(path, "utf8")) as Record<string, unknown>;
	const inference = config.inference as Record<string, unknown> | undefined;
	const targets = inference?.targets as Record<string, Record<string, unknown>> | undefined;
	const target = inference?.defaultPolicy === "background" ? targets?.background : undefined;
	if (!target) throw new Error("Signet setup did not write the expected background inference target");
	target.thinking = thinking;
	writeFileSync(path, stringifyYaml(config));
}

export function benchDreamingOpenRouter(env: NodeJS.ProcessEnv = process.env): Record<string, unknown> | undefined {
	const raw = env.SIGNET_BENCH_DREAMING_OPENROUTER?.trim();
	if (raw === undefined || raw === "") return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error("SIGNET_BENCH_DREAMING_OPENROUTER must be a JSON object");
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("SIGNET_BENCH_DREAMING_OPENROUTER must be a JSON object");
	}
	for (const key of Object.keys(parsed)) {
		if (key !== "reasoning" && key !== "provider") {
			throw new Error(`SIGNET_BENCH_DREAMING_OPENROUTER has an unknown key: ${key}`);
		}
	}
	return parsed as Record<string, unknown>;
}

export function setBenchDreamingOpenRouter(agentsDir: string, openrouter: Record<string, unknown> | undefined): void {
	if (openrouter === undefined) return;
	const path = join(agentsDir, "agent.yaml");
	const config = parseYaml(readFileSync(path, "utf8")) as Record<string, unknown>;
	const inference = config.inference as Record<string, unknown> | undefined;
	const targets = inference?.targets as Record<string, Record<string, unknown>> | undefined;
	const target = inference?.defaultPolicy === "background" ? targets?.background : undefined;
	if (!target) throw new Error("Signet setup did not write the expected background inference target");
	target.openrouter = { ...(target.openrouter as Record<string, unknown> | undefined), ...openrouter };
	writeFileSync(path, stringifyYaml(config));
}

export function benchDreamingPolicies(env: NodeJS.ProcessEnv = process.env): Record<string, string> | undefined {
	const file = env.SIGNET_BENCH_DREAMING_POLICIES_FILE?.trim();
	if (file === undefined || file === "") return undefined;
	const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("SIGNET_BENCH_DREAMING_POLICIES_FILE must hold a JSON object of pass type to policy text");
	}
	const policies: Record<string, string> = {};
	for (const [type, text] of Object.entries(parsed)) {
		if (type !== "hygiene" && type !== "content" && type !== "combined") {
			throw new Error(`SIGNET_BENCH_DREAMING_POLICIES_FILE has an unknown pass type: ${type}`);
		}
		if (typeof text !== "string" || !text.trim()) {
			throw new Error(`SIGNET_BENCH_DREAMING_POLICIES_FILE needs non-empty text for ${type}`);
		}
		if (text.length > 64_000) {
			throw new Error(`SIGNET_BENCH_DREAMING_POLICIES_FILE has more than 64,000 characters for ${type}`);
		}
		policies[type] = text;
	}
	return policies;
}

export function setBenchDreamingPolicies(agentsDir: string, policies: Record<string, string> | undefined): void {
	if (policies === undefined) return;
	const path = join(agentsDir, "agent.yaml");
	const config = parseYaml(readFileSync(path, "utf8")) as Record<string, unknown>;
	const memory = (config.memory ?? {}) as Record<string, unknown>;
	const dreaming = (memory.dreaming ?? {}) as Record<string, unknown>;
	config.memory = { ...memory, dreaming: { ...dreaming, policies } };
	writeFileSync(path, stringifyYaml(config));
}

export function benchDreamingContextWindow(env: NodeJS.ProcessEnv = process.env): number | undefined {
	const raw = env.SIGNET_BENCH_DREAMING_CONTEXT_WINDOW?.trim();
	if (raw === undefined || raw === "") return undefined;
	const parsed = Number(raw);
	if (!Number.isInteger(parsed) || parsed < 8_192 || parsed > 2_000_000) {
		throw new Error("SIGNET_BENCH_DREAMING_CONTEXT_WINDOW must be an integer from 8192 to 2000000");
	}
	return parsed;
}

export function setBenchDreamingContextWindow(agentsDir: string, contextWindow: number | undefined): void {
	if (contextWindow === undefined) return;
	const path = join(agentsDir, "agent.yaml");
	const config = parseYaml(readFileSync(path, "utf8")) as Record<string, unknown>;
	const inference = config.inference as Record<string, unknown> | undefined;
	const targets = inference?.targets as Record<string, Record<string, unknown>> | undefined;
	const target = inference?.defaultPolicy === "background" ? targets?.background : undefined;
	const models = target?.models as Record<string, Record<string, unknown>> | undefined;
	if (!models || Object.keys(models).length === 0) {
		throw new Error("Signet setup did not write the expected background inference target");
	}
	for (const model of Object.values(models)) model.contextWindow = contextWindow;
	writeFileSync(path, stringifyYaml(config));
}

export function pinnedBunMismatch(
	packageManager: unknown,
	version: string = Bun.version,
	execPath: string = process.execPath,
): string | null {
	const pinned = typeof packageManager === "string" ? /^bun@(.+)$/.exec(packageManager)?.[1] : undefined;
	if (pinned === undefined || pinned === version) return null;
	return `MemoryBench needs the pinned Bun ${pinned}, but this is Bun ${version} at ${execPath}. A bun from an ancestor node_modules/.bin can shadow it under "bun run"; run "bun scripts/bench-memory.ts" with the pinned bun instead.`;
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

function selectedBenchmark(args: string[]): string {
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "-b" || args[i] === "--benchmark") return args[i + 1] ?? "longmemeval";
	}
	return "longmemeval";
}

export function buildMemoryBenchArgs(
	raw: string[],
	full: boolean,
	profile: ParsedArgs["profile"],
	reset: boolean,
): string[] {
	const command = getMemoryBenchCommand(raw);
	const args = command === raw[0] ? raw.slice(1) : raw;

	if (command !== "run" && command !== "ingest") return [command, ...args];

	const runId =
		process.env.SIGNET_BENCH_RUN_ID ||
		`signet-${profile}-${selectedBenchmark(args)}-${new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "Z")}`;

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

export interface OpenRouterEndpointSnapshot {
	readonly provider_name?: string;
	readonly tag?: string;
	readonly quantization?: string;
	readonly context_length?: number;
	readonly pricing?: Record<string, unknown>;
}

export interface OpenRouterSnapshot {
	readonly timestamp: string;
	readonly key: Record<string, number> | { readonly error: string };
	readonly endpoints: Record<string, readonly OpenRouterEndpointSnapshot[] | { readonly error: string }>;
}

export function openRouterApiBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
	return env.SIGNET_BENCH_OPENROUTER_BASE_URL?.trim() || openRouterBaseUrl;
}

export function openRouterSnapshotModels(env: NodeJS.ProcessEnv, providerFamily: string): string[] {
	const models = new Set<string>();
	if (providerFamily === "openrouter") models.add(resolveBenchModel(env).model);
	for (const name of ["SIGNET_BENCH_ANSWERING_MODEL", "SIGNET_BENCH_JUDGE"]) {
		const raw = env[name]?.trim();
		if (raw?.startsWith("openrouter:")) models.add(raw.slice("openrouter:".length));
	}
	return [...models];
}

export function openRouterSnapshotNeeded(env: NodeJS.ProcessEnv, providerFamily: string): boolean {
	return providerFamily === "openrouter" || openRouterSnapshotModels(env, providerFamily).length > 0;
}

function snapshotErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function fetchOpenRouterKeyStatus(baseUrl: string, apiKey: string): Promise<Record<string, number>> {
	const response = await fetch(`${baseUrl}/key`, { headers: { authorization: `Bearer ${apiKey}` } });
	if (!response.ok) throw new Error(`GET ${baseUrl}/key failed with ${response.status} ${response.statusText}`);
	const body = (await response.json()) as { data?: unknown };
	if (typeof body.data !== "object" || body.data === null) {
		throw new Error("OpenRouter key status response had no data object");
	}
	const numeric: Record<string, number> = {};
	for (const [name, value] of Object.entries(body.data)) {
		if (typeof value === "number" && Number.isFinite(value)) numeric[name] = value;
	}
	return numeric;
}

async function fetchOpenRouterEndpoints(
	baseUrl: string,
	apiKey: string,
	modelId: string,
): Promise<OpenRouterEndpointSnapshot[]> {
	const response = await fetch(`${baseUrl}/models/${encodeURIComponent(modelId)}/endpoints`, {
		headers: { authorization: `Bearer ${apiKey}` },
	});
	if (!response.ok) throw new Error(`GET ${baseUrl}/models/${modelId}/endpoints failed with ${response.status}`);
	const body = (await response.json()) as { data?: { endpoints?: unknown } };
	const endpoints = body.data?.endpoints;
	if (!Array.isArray(endpoints)) throw new Error(`OpenRouter endpoints response for ${modelId} had no endpoint list`);
	const snapshots: OpenRouterEndpointSnapshot[] = [];
	for (const entry of endpoints) {
		if (typeof entry !== "object" || entry === null) continue;
		const endpoint = entry as Record<string, unknown>;
		snapshots.push({
			provider_name: typeof endpoint.provider_name === "string" ? endpoint.provider_name : undefined,
			tag: typeof endpoint.tag === "string" ? endpoint.tag : undefined,
			quantization: typeof endpoint.quantization === "string" ? endpoint.quantization : undefined,
			context_length: typeof endpoint.context_length === "number" ? endpoint.context_length : undefined,
			pricing: typeof endpoint.pricing === "object" && endpoint.pricing !== null ? endpoint.pricing : undefined,
		});
	}
	return snapshots;
}

export async function captureOpenRouterSnapshot(
	baseUrl: string,
	apiKey: string,
	modelIds: readonly string[],
): Promise<OpenRouterSnapshot> {
	const key = await fetchOpenRouterKeyStatus(baseUrl, apiKey).catch((error: unknown) => {
		console.warn(`OpenRouter key status snapshot failed: ${snapshotErrorMessage(error)}`);
		return { error: snapshotErrorMessage(error) };
	});
	const endpoints: OpenRouterSnapshot["endpoints"] = {};
	for (const modelId of modelIds) {
		endpoints[modelId] = await fetchOpenRouterEndpoints(baseUrl, apiKey, modelId).catch((error: unknown) => {
			console.warn(`OpenRouter endpoint snapshot for ${modelId} failed: ${snapshotErrorMessage(error)}`);
			return { error: snapshotErrorMessage(error) };
		});
	}
	return { timestamp: new Date().toISOString(), key, endpoints };
}

export function writeOpenRouterSnapshot(root: string, stage: "start" | "end", snapshot: OpenRouterSnapshot): string {
	const dir = join(root, "openrouter");
	mkdirSync(dir, { recursive: true });
	const path = join(dir, `${stage}.json`);
	writeFileSync(path, `${JSON.stringify(snapshot, null, 2)}\n`);
	return path;
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
	const apiKey = resolveBenchApiKey(process.env, model.providerFamily);
	if (!apiKey && !isLocalEndpoint(model.endpoint) && !benchUsesSubscription(model.providerFamily)) {
		throw new Error(
			`The benchmark daemon needs an API key for ${model.endpoint}; set ${BENCH_CREDENTIAL_ENV} or ${benchApiKeyEnv(model.providerFamily)} in memorybench/.env`,
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
	const snapshotModels = openRouterSnapshotModels(process.env, model.providerFamily);
	const snapshotNeeded = openRouterSnapshotNeeded(process.env, model.providerFamily);

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

	if (snapshotNeeded) {
		const snapshot = await captureOpenRouterSnapshot(
			openRouterApiBaseUrl(),
			resolveBenchApiKey(process.env, "openrouter"),
			snapshotModels,
		);
		console.log(`OpenRouter snapshot: ${writeOpenRouterSnapshot(root, "start", snapshot)}`);
	}
	if (parsed.dryRun) {
		if (!parsed.keepWorkspace) await rm(root, { recursive: true, force: true });
		return;
	}

	const runtimeMismatch = pinnedBunMismatch(
		(JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { packageManager?: unknown }).packageManager,
	);
	if (runtimeMismatch !== null) throw new Error(runtimeMismatch);

	let daemon: ReturnType<typeof spawn> | null = null;
	try {
		if (parsed.build) {
			await run(process.execPath, ["run", "build"]);
		}
		if (parsed.build || !existsSync(join(repoRoot, "surfaces", "dashboard", "build", "index.html"))) {
			await run(process.execPath, ["run", "build"], process.env, join(repoRoot, "surfaces", "dashboard"));
		}
		if (isSetUp(agentsDir)) {
			console.log("Reusing the existing benchmark workspace and database.");
		} else {
			await run(process.execPath, setupArgs, env);
			attachBenchCredential(agentsDir, model.providerFamily);
		}

		setBenchDreamingConcurrency(agentsDir, benchDreamingConcurrency());
		setBenchDreamingCodemode(agentsDir, benchDreamingCodemode());
		setBenchDreamingMaxOutputTokens(agentsDir, benchDreamingMaxOutputTokens());
		setBenchDreamingTimeout(agentsDir, benchDreamingTimeoutMs());
		setBenchDreamingThinking(agentsDir, benchDreamingThinking());
		setBenchDreamingOpenRouter(agentsDir, benchDreamingOpenRouter());
		setBenchDreamingContextWindow(agentsDir, benchDreamingContextWindow());
		setBenchDreamingPolicies(agentsDir, benchDreamingPolicies());
		mkdirSync(join(agentsDir, ".daemon", "logs"), { recursive: true });
		daemon = spawn(process.execPath, ["platform/daemon/src/daemon.ts"], {
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
		await run(process.execPath, ["src/index.ts", ...memorybenchArgs], env, join(repoRoot, "memorybench"));
	} finally {
		if (daemon && daemon.exitCode === null) {
			daemon.kill("SIGTERM");
			await new Promise((resolveKill) => daemon?.once("exit", resolveKill));
		}
		if (snapshotNeeded) {
			const snapshot = await captureOpenRouterSnapshot(
				openRouterApiBaseUrl(),
				resolveBenchApiKey(process.env, "openrouter"),
				snapshotModels,
			);
			console.log(`OpenRouter snapshot: ${writeOpenRouterSnapshot(root, "end", snapshot)}`);
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
