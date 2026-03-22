import { OpenClawConnector } from "@signet/connector-openclaw";
import type { SetupDetection } from "@signet/core";
import chalk from "chalk";

export type HarnessChoice = "claude-code" | "opencode" | "openclaw" | "codex";
export type EmbeddingProviderChoice = "native" | "ollama" | "openai" | "none";
export type ExtractionProviderChoice = "claude-code" | "ollama" | "opencode" | "codex" | "openrouter" | "none";
export type OpenClawRuntimeChoice = "plugin" | "legacy";

export const SETUP_HARNESS_CHOICES: readonly HarnessChoice[] = ["claude-code", "opencode", "openclaw", "codex"];
export const EMBEDDING_PROVIDER_CHOICES: readonly EmbeddingProviderChoice[] = ["native", "ollama", "openai", "none"];
export const EXTRACTION_PROVIDER_CHOICES: readonly ExtractionProviderChoice[] = [
	"claude-code",
	"ollama",
	"opencode",
	"codex",
	"openrouter",
	"none",
];
export const OPENCLAW_RUNTIME_CHOICES: readonly OpenClawRuntimeChoice[] = ["plugin", "legacy"];

interface PathDeps {
	readonly detectExistingSetup: (basePath: string) => SetupDetection;
	readonly normalizeAgentPath: (pathValue: string) => string;
}

interface HarnessDeps {
	readonly normalizeChoice: <T extends string>(value: unknown, allowed: readonly T[]) => T | null;
}

export function hasExistingIdentityFiles(detection: SetupDetection): boolean {
	const core = ["AGENTS.md", "SOUL.md", "IDENTITY.md", "USER.md"];
	const found = detection.identityFiles.filter((file) => core.includes(file));
	return found.length >= 2;
}

export function formatDetectionSummary(detection: SetupDetection): string {
	const lines = ["  Found:"];
	for (const file of detection.identityFiles) {
		lines.push(`    ✓ ${file}`);
	}
	if (detection.hasMemoryDir) {
		lines.push(`    ✓ memory/ (${detection.memoryLogCount} daily logs)`);
	}
	const harnesses = [];
	if (detection.harnesses.claudeCode) harnesses.push("Claude Code");
	if (detection.harnesses.openclaw) harnesses.push("OpenClaw");
	if (detection.harnesses.opencode) harnesses.push("OpenCode");
	if (detection.harnesses.codex) harnesses.push("Codex");
	if (harnesses.length > 0) {
		lines.push(`    ✓ Harnesses: ${harnesses.join(", ")}`);
	}
	return lines.join("\n");
}

export function hasExistingAgentState(detection: SetupDetection): boolean {
	return detection.memoryDb || detection.agentYaml || detection.identityFiles.length > 0;
}

export function detectPreferredOpenClawWorkspace(defaultPath: string, deps: PathDeps): string | null {
	const connector = new OpenClawConnector();
	const normalizedDefault = deps.normalizeAgentPath(defaultPath);
	const discovered = connector
		.getDiscoveredWorkspacePaths()
		.map((workspacePath) => deps.normalizeAgentPath(workspacePath))
		.filter((workspacePath) => workspacePath !== normalizedDefault);

	if (discovered.length === 0) {
		return null;
	}

	const unique = [...new Set(discovered)];
	const ranked = unique
		.map((workspacePath) => ({ workspacePath, score: scoreOpenClawWorkspace(workspacePath, deps) }))
		.sort((a, b) => b.score - a.score);

	if (ranked[0].score > 0) {
		return ranked[0].workspacePath;
	}

	return ranked.length === 1 ? ranked[0].workspacePath : null;
}

export function normalizeHarnessList(
	rawValues: readonly string[] | undefined,
	deps: HarnessDeps,
): HarnessChoice[] {
	if (!rawValues || rawValues.length === 0) {
		return [];
	}

	const harnesses: HarnessChoice[] = [];
	for (const rawValue of rawValues) {
		const parts = rawValue
			.split(",")
			.map((part) => part.trim())
			.filter((part) => part.length > 0);

		for (const part of parts) {
			const harness = deps.normalizeChoice(part, SETUP_HARNESS_CHOICES);
			if (harness && !harnesses.includes(harness)) {
				harnesses.push(harness);
			}
		}
	}

	return harnesses;
}

export function failNonInteractiveSetup(message: string): never {
	console.error(chalk.red(`  ${message}`));
	console.error(chalk.dim("  Ask the user for explicit provider choices and pass them as CLI flags."));
	process.exit(1);
}

export function getEmbeddingDimensions(model: string): number {
	switch (model) {
		case "all-minilm":
			return 384;
		case "mxbai-embed-large":
			return 1024;
		case "text-embedding-3-large":
			return 3072;
		case "text-embedding-3-small":
			return 1536;
		default:
			return 768;
	}
}

export function readErr(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

export function readRecord(value: unknown): Record<string, unknown> {
	return isRecord(value) ? value : {};
}

export function readString(value: unknown): string | null {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function readHarnesses(value: unknown): string[] {
	if (Array.isArray(value)) {
		return value.flatMap((entry) => (typeof entry === "string" && entry.trim().length > 0 ? [entry.trim()] : []));
	}
	if (typeof value === "string") {
		return value
			.split(",")
			.map((entry) => entry.trim())
			.filter((entry) => entry.length > 0);
	}
	return [];
}

function scoreOpenClawWorkspace(pathValue: string, deps: PathDeps): number {
	const detection = deps.detectExistingSetup(pathValue);
	let score = 0;
	if (detection.memoryDb) score += 100;
	if (detection.agentYaml) score += 60;
	if (detection.identityFiles.length >= 2) score += 40;
	if (detection.agentsDir) score += 10;
	return score;
}
