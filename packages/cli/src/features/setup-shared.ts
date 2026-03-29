import { OpenClawConnector } from "@signet/connector-openclaw";
import type { SetupDetection } from "@signet/core";
import chalk from "chalk";

export type HarnessChoice = "claude-code" | "opencode" | "openclaw" | "oh-my-pi" | "codex" | "forge";
export type EmbeddingProviderChoice = "native" | "ollama" | "openai" | "none";
export type ExtractionProviderChoice = "claude-code" | "ollama" | "opencode" | "codex" | "openrouter" | "none";
export type OpenClawRuntimeChoice = "plugin" | "legacy";
export type DeploymentTypeChoice = "local" | "vps" | "server";
export interface ResolveSetupExtractionProviderOptions {
	readonly deploymentType: DeploymentTypeChoice;
	readonly requestedProvider: ExtractionProviderChoice | null;
	readonly providerFromConfig: ExtractionProviderChoice | null;
	readonly preserveExisting: boolean;
	readonly detectedProvider: ExtractionProviderChoice;
	readonly availableProviders?: readonly ExtractionProviderChoice[];
	readonly preferredHarnesses?: readonly HarnessChoice[];
}

export const SETUP_HARNESS_CHOICES: readonly HarnessChoice[] = [
	"claude-code",
	"opencode",
	"openclaw",
	"oh-my-pi",
	"codex",
	"forge",
];
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
export const DEPLOYMENT_TYPE_CHOICES: readonly DeploymentTypeChoice[] = ["local", "vps", "server"];
const VPS_NON_LOCAL_EXTRACTION_PROVIDERS: readonly ExtractionProviderChoice[] = ["claude-code", "codex", "opencode"];
const DETECTED_EXTRACTION_PROVIDER_ORDER: readonly ExtractionProviderChoice[] = [
	"claude-code",
	"codex",
	"ollama",
	"opencode",
];

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
	if (detection.harnesses.ohMyPi) harnesses.push("Oh My Pi");
	if (detection.harnesses.codex) harnesses.push("Codex");
	if (detection.harnesses.forge) harnesses.push("Forge");
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

export function normalizeHarnessList(rawValues: readonly string[] | undefined, deps: HarnessDeps): HarnessChoice[] {
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

export function failSetupValidation(message: string, hint?: string): never {
	console.error(chalk.red(`  ${message}`));
	if (hint) {
		console.error(chalk.dim(`  ${hint}`));
	}
	process.exit(1);
}

export function failNonInteractiveSetup(message: string): never {
	failSetupValidation(
		message,
		"Provide explicit CLI values, or pass --deployment-type to use inferred provider defaults.",
	);
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

export function defaultEmbeddingProviderForDeployment(_deploymentType: DeploymentTypeChoice): EmbeddingProviderChoice {
	return "native";
}

export function defaultExtractionProviderForDeployment(
	deploymentType: DeploymentTypeChoice,
	detectedProvider: ExtractionProviderChoice,
	availableProviders: readonly ExtractionProviderChoice[] = [],
	preferredHarnesses: readonly HarnessChoice[] = [],
): ExtractionProviderChoice {
	if (deploymentType === "vps") {
		const preferredProviders = extractionProvidersFromHarnesses(preferredHarnesses);
		for (const provider of preferredProviders) {
			if (availableProviders.includes(provider)) {
				return provider;
			}
		}

		for (const provider of VPS_NON_LOCAL_EXTRACTION_PROVIDERS) {
			if (availableProviders.includes(provider)) {
				return provider;
			}
		}

		if (VPS_NON_LOCAL_EXTRACTION_PROVIDERS.includes(detectedProvider)) {
			return detectedProvider;
		}
		return "none";
	}
	return detectedProvider;
}

export function detectExtractionProviderFromAvailable(
	availableProviders: readonly ExtractionProviderChoice[],
): ExtractionProviderChoice {
	for (const provider of DETECTED_EXTRACTION_PROVIDER_ORDER) {
		if (availableProviders.includes(provider)) {
			return provider;
		}
	}
	return "none";
}

export function resolveSetupExtractionProvider(
	options: ResolveSetupExtractionProviderOptions,
): ExtractionProviderChoice {
	const inferred = defaultExtractionProviderForDeployment(
		options.deploymentType,
		options.detectedProvider,
		options.availableProviders ?? [],
		options.preferredHarnesses ?? [],
	);
	if (options.requestedProvider) {
		return options.requestedProvider;
	}
	if (options.preserveExisting && options.providerFromConfig) {
		return options.providerFromConfig;
	}
	if (options.deploymentType === "vps") {
		return inferred;
	}
	return options.providerFromConfig ?? inferred;
}

function extractionProvidersFromHarnesses(harnesses: readonly HarnessChoice[]): ExtractionProviderChoice[] {
	const providers: ExtractionProviderChoice[] = [];
	for (const harness of harnesses) {
		let provider: ExtractionProviderChoice | null = null;
		if (harness === "claude-code" || harness === "codex" || harness === "opencode") {
			provider = harness;
		}
		if (provider && !providers.includes(provider)) {
			providers.push(provider);
		}
	}
	return providers;
}

export function getDeploymentExtractionGuidance(deploymentType: DeploymentTypeChoice): string[] {
	switch (deploymentType) {
		case "vps":
			return [
				"VPS/cloud hosts with shared or constrained CPU should avoid local Ollama extraction.",
				"Use Built-in (native) embeddings for lower overhead than running an Ollama server.",
				"Safest default is extraction: none. If you enable extraction, prefer offloaded providers (claude-code/openrouter).",
			];
		case "server":
			return [
				"Dedicated self-hosted servers can run local providers if you have CPU/RAM headroom.",
				"Built-in (native) embeddings are still the lightest default for embeddings.",
			];
		default:
			return [
				"Local machines can use local providers, but monitor CPU if running background extraction with Ollama.",
				"Built-in (native) embeddings are recommended unless you need a specific external provider.",
			];
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
