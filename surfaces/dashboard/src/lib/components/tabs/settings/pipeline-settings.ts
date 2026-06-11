import {
	DEFAULT_PIPELINE_TIMEOUT_MS,
	type PipelineProviderChoice,
	defaultPipelineModel,
	isPipelineProvider,
} from "@signetai/core/pipeline-providers";

export const DEFAULT_OPENAI_COMPATIBLE_ENDPOINT = "http://127.0.0.1:1234/v1";

function toRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? Object.fromEntries(Object.entries(value))
		: null;
}

function mutableRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function ensureRecord(root: Record<string, unknown>, key: string): Record<string, unknown> {
	const existing = mutableRecord(root[key]);
	if (existing) return existing;
	const next: Record<string, unknown> = {};
	root[key] = next;
	return next;
}

function readPipeline(agent: unknown): Record<string, unknown> | null {
	const root = toRecord(agent);
	const mem = toRecord(root?.memory);
	return toRecord(mem?.pipelineV2);
}

function readString(root: Record<string, unknown> | null, ...path: string[]): string | undefined {
	let node: unknown = root;
	for (const part of path) {
		const record = toRecord(node);
		if (!record) return undefined;
		node = record[part];
	}
	return typeof node === "string" && node.trim().length > 0 ? node : undefined;
}

function readNumber(root: Record<string, unknown> | null, ...path: string[]): number | undefined {
	let node: unknown = root;
	for (const part of path) {
		const record = toRecord(node);
		if (!record) return undefined;
		node = record[part];
	}
	return typeof node === "number" && Number.isFinite(node) ? node : undefined;
}

function readBoolean(root: Record<string, unknown> | null, ...path: string[]): boolean | undefined {
	let node: unknown = root;
	for (const part of path) {
		const record = toRecord(node);
		if (!record) return undefined;
		node = record[part];
	}
	return typeof node === "boolean" ? node : undefined;
}

export function hasExplicitSynthesisConfig(agent: unknown): boolean {
	return toRecord(readPipeline(agent)?.synthesis) !== null;
}

export function hasExplicitSynthesisProvider(agent: unknown): boolean {
	const pipeline = readPipeline(agent);
	return isPipelineProvider(readString(pipeline, "synthesis", "provider"));
}

export function resolveExtractionEndpoint(agent: unknown): string {
	const pipeline = readPipeline(agent);
	const explicit =
		readString(pipeline, "extractionEndpoint") ??
		readString(pipeline, "extractionBaseUrl") ??
		readString(pipeline, "extraction", "endpoint") ??
		readString(pipeline, "extraction", "base_url");
	if (explicit) return explicit;
	const provider = readString(pipeline, "extractionProvider") ?? readString(pipeline, "extraction", "provider");
	return provider === "openai-compatible" ? DEFAULT_OPENAI_COMPATIBLE_ENDPOINT : "";
}

export function resolveSynthesisProvider(agent: unknown): PipelineProviderChoice {
	const pipeline = readPipeline(agent);
	const explicit = readString(pipeline, "synthesis", "provider");
	if (isPipelineProvider(explicit)) return explicit;
	const flat = readString(pipeline, "extractionProvider");
	if (isPipelineProvider(flat)) return flat;
	const nested = readString(pipeline, "extraction", "provider");
	if (isPipelineProvider(nested)) return nested;
	return "llama-cpp";
}

export function resolveSynthesisModel(agent: unknown): string {
	const pipeline = readPipeline(agent);
	const provider = resolveSynthesisProvider(agent);
	const explicit = readString(pipeline, "synthesis", "model");
	if (explicit) return explicit;
	if (hasExplicitSynthesisProvider(agent)) return defaultPipelineModel(provider);
	return (
		readString(pipeline, "extractionModel") ??
		readString(pipeline, "extraction", "model") ??
		defaultPipelineModel(provider)
	);
}

export function resolveSynthesisEndpoint(agent: unknown): string {
	const pipeline = readPipeline(agent);
	const explicit = readString(pipeline, "synthesis", "endpoint") ?? readString(pipeline, "synthesis", "base_url");
	if (explicit) return explicit;
	if (hasExplicitSynthesisProvider(agent)) return "";
	return (
		readString(pipeline, "extraction", "endpoint") ??
		readString(pipeline, "extraction", "base_url") ??
		readString(pipeline, "extractionEndpoint") ??
		readString(pipeline, "extractionBaseUrl") ??
		""
	);
}

export function resolveSynthesisTimeout(agent: unknown): number {
	const pipeline = readPipeline(agent);
	const explicit = readNumber(pipeline, "synthesis", "timeout");
	if (explicit !== undefined) return explicit;
	if (hasExplicitSynthesisProvider(agent)) return 120000;
	return (
		readNumber(pipeline, "extraction", "timeout") ??
		readNumber(pipeline, "extractionTimeout") ??
		DEFAULT_PIPELINE_TIMEOUT_MS
	);
}

export function resolveSynthesisEnabled(agent: unknown): boolean {
	const pipeline = readPipeline(agent);
	if (resolveSynthesisProvider(agent) === "none") return false;
	return readBoolean(pipeline, "synthesis", "enabled") ?? true;
}
export type AcpxDashboardAgent = "codex" | "claude-code" | "opencode";

export const ACPX_DASHBOARD_AGENT_OPTIONS: Array<{
	readonly value: AcpxDashboardAgent;
	readonly label: string;
	readonly model: string;
}> = [
	{ value: "codex", label: "Codex CLI", model: defaultPipelineModel("codex") },
	{ value: "claude-code", label: "Claude Code", model: defaultPipelineModel("claude-code") },
	{ value: "opencode", label: "OpenCode", model: defaultPipelineModel("opencode") },
];

export function defaultAcpxDashboardAgent(agentConfig: unknown): AcpxDashboardAgent {
	const inference = toRecord(toRecord(agentConfig)?.inference);
	const target = toRecord(toRecord(inference?.targets)?.["background-acpx"]);
	const acpx = toRecord(target?.acpx);
	const configured = acpx?.agent;
	if (configured === "claude") return "claude-code";
	if (configured === "claude-code" || configured === "opencode" || configured === "codex") return configured;
	const harnesses = toRecord(agentConfig)?.harnesses;
	if (Array.isArray(harnesses)) {
		for (const harness of harnesses) {
			if (harness === "codex" || harness === "claude-code" || harness === "opencode") return harness;
		}
	}
	return "codex";
}

export function defaultAcpxDashboardModel(agent: AcpxDashboardAgent): string {
	return ACPX_DASHBOARD_AGENT_OPTIONS.find((option) => option.value === agent)?.model ?? defaultPipelineModel("codex");
}

function acpxCommandAgent(agent: AcpxDashboardAgent): string {
	return agent === "claude-code" ? "claude" : agent;
}

export function applyAcpxDashboardSetup(
	agentConfig: Record<string, unknown>,
	options: { readonly agent: AcpxDashboardAgent; readonly model?: string },
): void {
	const model = options.model?.trim() || defaultAcpxDashboardModel(options.agent);
	const memory = ensureRecord(agentConfig, "memory");
	const pipeline = ensureRecord(memory, "pipelineV2");
	pipeline.enabled = true;
	pipeline.extractionProvider = "acpx";
	pipeline.extractionModel = model;
	pipeline.semanticContradictionEnabled = true;
	pipeline.graphEnabled = true;
	pipeline.rerankerEnabled = true;
	pipeline.synthesis = {
		enabled: true,
		provider: "acpx",
		model,
		timeout: 120000,
	};

	const inference = ensureRecord(agentConfig, "inference");
	const targets = ensureRecord(inference, "targets");
	targets["background-acpx"] = {
		executor: "acpx",
		acpx: {
			agent: acpxCommandAgent(options.agent),
			package: "acpx@0.7.0",
			version: "0.7.0",
			mode: "exec",
			permissions: "deny-all",
			hooks: "disabled",
			terminal: "inherit",
		},
		models: {
			default: {
				model,
				reasoning: "medium",
				toolUse: true,
				costTier: "medium",
			},
		},
	};
	const policies = ensureRecord(inference, "policies");
	policies["background-acpx"] = {
		mode: "automatic",
		defaultTargets: ["background-acpx/default"],
		fallbackTargets: ["background-acpx/default"],
	};
	const taskClasses = ensureRecord(inference, "taskClasses");
	taskClasses.memory_extraction = { reasoning: "medium", toolsRequired: true, privacy: "restricted_remote" };
	taskClasses.session_synthesis = { reasoning: "medium", toolsRequired: true, privacy: "restricted_remote" };
	const workloads = ensureRecord(inference, "workloads");
	workloads.memoryExtraction = { target: "background-acpx/default", taskClass: "memory_extraction" };
	workloads.sessionSynthesis = { target: "background-acpx/default", taskClass: "session_synthesis" };
}
