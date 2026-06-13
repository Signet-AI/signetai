import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, parse, relative } from "node:path";
import chalk from "chalk";
import type { Command } from "commander";
import type { DaemonApiCall } from "../lib/daemon.js";

export const DEFAULT_CONTEXT_PROFILE = "coding";
export const DEFAULT_COMPILED_CONTEXT_MAX_CHARS = 2200;
export const DEFAULT_CONTEXT_SOURCE_FILES = ["AGENTS.md", "USER.md", "IDENTITY.md", "SOUL.md"] as const;

interface ContextDeps {
	readonly AGENTS_DIR: string;
	readonly secretApiCall: DaemonApiCall;
}

interface CompileOptions {
	readonly profile?: string;
	readonly output?: string;
	readonly maxChars?: string;
	readonly sources?: string;
	readonly agent?: string;
	readonly policy?: string;
	readonly target?: string;
	readonly timeout?: string;
	readonly dryRun?: boolean;
	readonly json?: boolean;
}

export interface ContextSource {
	readonly path: string;
	readonly content: string;
}

export interface CompileContextPromptParams {
	readonly agentsDir: string;
	readonly profile: string;
	readonly outputPath: string;
	readonly sourceFiles: readonly string[];
	readonly maxChars: number;
	readonly agentId?: string;
	readonly policy?: string;
	readonly target?: string;
	readonly timeoutMs: number;
	readonly dryRun: boolean;
	readonly secretApiCall: DaemonApiCall;
}

export interface CompileContextPromptResult {
	readonly profile: string;
	readonly outputPath: string;
	readonly maxChars: number;
	readonly charCount: number;
	readonly truncated: boolean;
	readonly sources: readonly string[];
	readonly text: string;
	readonly targetRef?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePositiveInt(value: string | undefined, fallback: number, max: number): number | null {
	if (value === undefined) return fallback;
	const trimmed = value.trim();
	if (!/^[1-9]\d*$/.test(trimmed)) return null;
	const parsed = Number.parseInt(trimmed, 10);
	return Number.isSafeInteger(parsed) && parsed <= max ? parsed : null;
}

function parseSourceList(value: string | undefined): readonly string[] {
	if (!value) return DEFAULT_CONTEXT_SOURCE_FILES;
	return value
		.split(",")
		.map((part) => part.trim())
		.filter((part) => part.length > 0);
}

function isSafeContextRelativePath(path: string): boolean {
	const trimmed = path.trim();
	if (!trimmed || trimmed.startsWith("~") || isAbsolute(trimmed)) return false;
	const parts = trimmed.split(/[\\/]/);
	const denied = new Set([".daemon", ".secrets", "memory"]);
	return parts.every((part) => {
		const normalized = part.toLowerCase();
		return normalized !== ".." && !normalized.startsWith(".") && !denied.has(normalized);
	});
}

function nearestExistingAncestor(path: string): string {
	let current = path;
	const root = parse(path).root;
	while (!existsSync(current) && current !== root) {
		current = dirname(current);
	}
	return current;
}

function isAllowedResolvedRelative(rel: string): boolean {
	if (rel.startsWith("..") || isAbsolute(rel)) return false;
	const denied = new Set([".daemon", ".secrets", "memory"]);
	return rel
		.split(/[\\/]/)
		.filter((part) => part.length > 0)
		.every((part) => {
			const normalized = part.toLowerCase();
			return !normalized.startsWith(".") && !denied.has(normalized);
		});
}

function ensureContainedPath(baseDir: string, path: string): string {
	if (!isSafeContextRelativePath(path)) {
		throw new Error(`Unsafe context path: ${path}`);
	}
	const resolved = join(baseDir, path);
	const baseReal = realpathSync(baseDir);
	const ancestorReal = realpathSync(nearestExistingAncestor(dirname(resolved)));
	const rel = relative(baseReal, ancestorReal);
	if (!isAllowedResolvedRelative(rel)) {
		throw new Error(`Context path escapes workspace: ${path}`);
	}
	return resolved;
}

function assertExistingPathContained(baseDir: string, path: string, resolved: string): void {
	const baseReal = realpathSync(baseDir);
	const targetReal = realpathSync(resolved);
	const rel = relative(baseReal, targetReal);
	if (!isAllowedResolvedRelative(rel)) {
		throw new Error(`Context path escapes workspace: ${path}`);
	}
}

export function readContextSources(agentsDir: string, sourceFiles: readonly string[]): readonly ContextSource[] {
	return sourceFiles.flatMap((sourcePath) => {
		const resolved = ensureContainedPath(agentsDir, sourcePath);
		if (!existsSync(resolved)) return [];
		assertExistingPathContained(agentsDir, sourcePath, resolved);
		return [{ path: sourcePath, content: readFileSync(resolved, "utf-8") }];
	});
}

function formatSourceBlock(source: ContextSource): string {
	return [`### ${source.path}`, "```md", source.content.trim(), "```"].join("\n");
}

export function buildContextCompilePrompt(sources: readonly ContextSource[], maxChars: number): string {
	const sourceBlocks = sources.map(formatSourceBlock).join("\n\n");
	return `Synthesize the Signet identity and operating-policy sources below into one coding-agent AGENTS.md prompt.\n\nHard requirements:\n- Output only the final prompt text; no code fences, commentary, preamble, or metadata.\n- The final prompt must be ${maxChars} characters or fewer.\n- Preserve hard repo/workflow policy, safety constraints, user preferences, file-preservation rules, scoping rules, dependency-inspection requirements, proof/test expectations, and secret-handling rules.\n- Drop biography, decorative voice, repeated explanations, broad product philosophy, and non-coding details.\n- Do not invent new policy.\n- Use concise imperative bullets suitable for a system prompt.\n\nSources:\n${sourceBlocks}`;
}

function stripCodeFence(text: string): string {
	const trimmed = text.trim();
	const match = /^```(?:md|markdown)?\s*\n([\s\S]*?)\n```$/i.exec(trimmed);
	return match ? match[1].trim() : trimmed;
}

function truncateAtCharacterLimit(text: string, maxChars: number): { readonly text: string; readonly truncated: boolean } {
	const normalized = stripCodeFence(text).replace(/\n{3,}/g, "\n\n").trim();
	if (normalized.length <= maxChars) return { text: normalized, truncated: false };
	const slice = normalized.slice(0, maxChars).trimEnd();
	return { text: slice, truncated: true };
}

function readTargetRef(data: unknown): string | undefined {
	if (!isRecord(data)) return undefined;
	const decision = data.decision;
	if (!isRecord(decision)) return undefined;
	return typeof decision.targetRef === "string" ? decision.targetRef : undefined;
}

function readGeneratedText(data: unknown): string | undefined {
	return isRecord(data) && typeof data.text === "string" ? data.text : undefined;
}

function assertWritableOutputPath(agentsDir: string, outputPath: string): string {
	const resolved = ensureContainedPath(agentsDir, outputPath);
	if (existsSync(resolved) && lstatSync(resolved).isSymbolicLink()) {
		throw new Error(`Context output path must not be a symlink: ${outputPath}`);
	}
	return resolved;
}

export async function compileContextPrompt(params: CompileContextPromptParams): Promise<CompileContextPromptResult> {
	const resolvedOutput = assertWritableOutputPath(params.agentsDir, params.outputPath);
	const sources = readContextSources(params.agentsDir, params.sourceFiles);
	if (sources.length === 0) {
		throw new Error(`No source files found. Checked: ${params.sourceFiles.join(", ")}`);
	}
	const prompt = buildContextCompilePrompt(sources, params.maxChars);
	const { ok, data } = await params.secretApiCall(
		"POST",
		"/api/inference/execute",
		{
			prompt,
			agentId: params.agentId,
			operation: "session_synthesis",
			explicitPolicy: params.policy,
			explicitTargets: params.target ? [params.target] : undefined,
			maxTokens: Math.max(256, Math.ceil(params.maxChars / 2)),
			timeoutMs: params.timeoutMs,
			refresh: false,
		},
		params.timeoutMs + 5_000,
	);
	if (!ok) {
		throw new Error(`Context synthesis failed: ${JSON.stringify(data)}`);
	}
	const generated = readGeneratedText(data);
	if (!generated) {
		throw new Error("Context synthesis response did not include text.");
	}
	const capped = truncateAtCharacterLimit(generated, params.maxChars);
	if (!params.dryRun) {
		mkdirSync(dirname(resolvedOutput), { recursive: true });
		assertWritableOutputPath(params.agentsDir, params.outputPath);
		writeFileSync(resolvedOutput, `${capped.text}\n`);
	}
	return {
		profile: params.profile,
		outputPath: params.outputPath,
		maxChars: params.maxChars,
		charCount: capped.text.length,
		truncated: capped.truncated,
		sources: sources.map((source) => source.path),
		text: capped.text,
		targetRef: readTargetRef(data),
	};
}

export function registerContextCommands(program: Command, deps: ContextDeps): void {
	const context = program.command("context").description("Compile and inspect Signet context artifacts");

	context
		.command("compile")
		.description("Synthesize canonical identity files into a bounded profile prompt artifact")
		.option("--profile <name>", "Context profile name", DEFAULT_CONTEXT_PROFILE)
		.option("--output <path>", "Output path relative to the Signet workspace")
		.option("--max-chars <n>", "Maximum generated prompt characters", String(DEFAULT_COMPILED_CONTEXT_MAX_CHARS))
		.option("--sources <paths>", "Comma-separated source files", DEFAULT_CONTEXT_SOURCE_FILES.join(","))
		.option("--agent <agent>", "Inference agent id")
		.option("--policy <policy>", "Inference policy override")
		.option("--target <targetRef>", "Explicit inference target ref")
		.option("--timeout <ms>", "Inference timeout in milliseconds", "120000")
		.option("--dry-run", "Print generated prompt without writing it")
		.option("--json", "Output metadata as JSON")
		.action(async (options: CompileOptions) => {
			const maxChars = parsePositiveInt(options.maxChars, DEFAULT_COMPILED_CONTEXT_MAX_CHARS, 20_000);
			if (maxChars === null) {
				console.error(chalk.red("--max-chars must be a positive integer no greater than 20000."));
				process.exit(1);
				return;
			}
			const timeoutMs = parsePositiveInt(options.timeout, 120_000, 600_000);
			if (timeoutMs === null) {
				console.error(chalk.red("--timeout must be a positive integer no greater than 600000."));
				process.exit(1);
				return;
			}
			const profile = options.profile?.trim() || DEFAULT_CONTEXT_PROFILE;
			const outputPath = options.output?.trim() || `context-profiles/${profile}/AGENTS.md`;
			try {
				const result = await compileContextPrompt({
					agentsDir: deps.AGENTS_DIR,
					profile,
					outputPath,
					sourceFiles: parseSourceList(options.sources),
					maxChars,
					agentId: options.agent,
					policy: options.policy,
					target: options.target,
					timeoutMs,
					dryRun: options.dryRun === true,
					secretApiCall: deps.secretApiCall,
				});
				if (options.json) {
					console.log(JSON.stringify(result, null, 2));
					return;
				}
				if (options.dryRun) {
					console.log(result.text);
					return;
				}
				console.log(chalk.green(`Compiled ${result.outputPath} (${result.charCount}/${result.maxChars} chars)`));
				if (result.truncated) {
					console.log(chalk.yellow("Generated prompt exceeded the limit and was deterministically truncated."));
				}
				if (result.targetRef) console.log(chalk.dim(`Target: ${result.targetRef}`));
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				console.error(chalk.red(message));
				process.exit(1);
			}
		});
}
