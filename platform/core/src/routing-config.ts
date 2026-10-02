import type { PipelineCommandConfig } from "./types";

export const ROUTING_ACCOUNT_KINDS = ["subscription_session", "api"] as const;
export const ROUTING_TARGET_KINDS = ["subscription_session", "api", "local", "gateway"] as const;
export const ROUTING_EXECUTOR_KINDS = [
	"acpx",
	"claude-code",
	"codex",
	"opencode",
	"anthropic",
	"openrouter",
	"ollama",
	"llama-cpp",
	"openai-compatible",
	"command",
] as const;
const ROUTING_EXECUTOR_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
export const ROUTING_POLICY_MODES = ["strict", "automatic", "hybrid"] as const;
export const ROUTING_PRIVACY_TIERS = ["remote_ok", "restricted_remote", "local_only"] as const;
export const ROUTING_REASONING_DEPTHS = ["low", "medium", "high"] as const;
export const ROUTING_COST_TIERS = ["low", "medium", "high"] as const;
export const ROUTING_OPERATION_KINDS = [
	"default",
	"interactive",
	"tool_planning",
	"code_reasoning",
	"memory_extraction",
	"session_synthesis",
	"aggregate_recall",
	"repair",
] as const;

export type RoutingAccountKind = (typeof ROUTING_ACCOUNT_KINDS)[number];
export type RoutingTargetKind = (typeof ROUTING_TARGET_KINDS)[number];
export type RoutingExecutorKind = (typeof ROUTING_EXECUTOR_KINDS)[number] | (string & {});
export type RoutingPolicyMode = (typeof ROUTING_POLICY_MODES)[number];
export type RoutingPrivacyTier = (typeof ROUTING_PRIVACY_TIERS)[number];
export type RoutingReasoningDepth = (typeof ROUTING_REASONING_DEPTHS)[number];
export type RoutingCostTier = (typeof ROUTING_COST_TIERS)[number];
export type RoutingOperationKind = (typeof ROUTING_OPERATION_KINDS)[number];
export const ROUTING_CLASSIFIER_TASK_CLASSES = {
	codeReasoning: "hard_coding",
	localSensitive: "local_sensitive",
} as const;

export type RoutingTargetRef = string & { readonly __brand: "RoutingTargetRef" };
export type RoutingPolicyId = string & { readonly __brand: "RoutingPolicyId" };
export type RoutingAgentId = string & { readonly __brand: "RoutingAgentId" };

export interface RouterError {
	readonly code:
		| "invalid-config"
		| "invalid-target-ref"
		| "policy-not-found"
		| "no-candidates"
		| "target-not-found"
		| "execution-failed";
	readonly message: string;
	readonly details?: Readonly<Record<string, unknown>>;
}

export interface RoutingValidationIssue {
	readonly severity: "error" | "warning";
	readonly field: string;
	readonly ref: string;
	readonly message: string;
}

export type RouterResult<T> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly error: RouterError };

export interface RoutingAccountConfig {
	readonly kind: RoutingAccountKind;
	readonly providerFamily: string;
	readonly label?: string;
	readonly credentialRef?: string;
	readonly sessionRef?: string;
	readonly usageTier?: string;
}

export interface RoutingModelConfig {
	readonly model: string;
	readonly label?: string;
	readonly reasoning?: RoutingReasoningDepth;
	readonly contextWindow?: number;
	readonly toolUse?: boolean;
	readonly streaming?: boolean;
	readonly multimodal?: boolean;
	readonly costTier?: RoutingCostTier;
	readonly averageLatencyMs?: number;
}

export interface RoutingOpenRouterReasoningConfig {
	readonly enabled?: boolean;
	readonly maxTokens?: number;
}

export interface RoutingOpenRouterConfig {
	readonly reasoning?: RoutingOpenRouterReasoningConfig;
}

const ACPX_PERMISSION_MODES = ["inherit", "deny-all", "approve-reads", "approve-all"] as const;
const ACPX_TOGGLE_MODES = ["inherit", "disabled", "enabled"] as const;
const ACPX_SESSION_MODES = ["exec", "session"] as const;
const ACPX_OUTPUT_FORMATS = ["quiet", "json"] as const;
const ACPX_MODEL_SELECTIONS = ["acp", "agent"] as const;

export type RoutingAcpxPermissionMode = (typeof ACPX_PERMISSION_MODES)[number];
export type RoutingAcpxHooksMode = (typeof ACPX_TOGGLE_MODES)[number];
export type RoutingAcpxTerminalMode = (typeof ACPX_TOGGLE_MODES)[number];
export type RoutingAcpxSessionMode = (typeof ACPX_SESSION_MODES)[number];
export type RoutingAcpxOutputFormat = (typeof ACPX_OUTPUT_FORMATS)[number];
export type AcpxModelSelection = (typeof ACPX_MODEL_SELECTIONS)[number];

export function resolveAcpxModelSelection(agent: string, configured?: AcpxModelSelection): AcpxModelSelection {
	if (configured) return configured;
	return agent.trim().toLowerCase() === "opencode" ? "agent" : "acp";
}

export interface RoutingAcpxConfig {
	readonly agent: string;
	readonly modelSelection?: AcpxModelSelection;
	readonly version?: string;
	readonly bin?: string;
	readonly package?: string;
	readonly cwd?: string;
	readonly session?: string;
	readonly mode?: RoutingAcpxSessionMode;
	readonly permissions?: RoutingAcpxPermissionMode;
	readonly hooks?: RoutingAcpxHooksMode;
	readonly terminal?: RoutingAcpxTerminalMode;
	readonly allowedTools?: readonly string[];
	readonly format?: RoutingAcpxOutputFormat;
	readonly captureEvents?: boolean;
	readonly maxCapturedEvents?: number;
	readonly emptyResponseRetries?: number;
	readonly timeoutMs?: number;
	readonly extraArgs?: readonly string[];
}

export interface RoutingTargetConfig {
	readonly kind: RoutingTargetKind;
	readonly executor: RoutingExecutorKind;
	readonly account?: string;
	readonly endpoint?: string;
	readonly command?: PipelineCommandConfig;
	readonly acpx?: RoutingAcpxConfig;
	readonly openrouter?: RoutingOpenRouterConfig;
	readonly privacy?: RoutingPrivacyTier;
	readonly models: Readonly<Record<string, RoutingModelConfig>>;
}

export interface RoutingPolicyConfig {
	readonly mode: RoutingPolicyMode;
	readonly allow?: readonly string[];
	readonly deny?: readonly string[];
	readonly defaultTargets?: readonly string[];
	readonly taskTargets?: Readonly<Record<string, readonly string[]>>;
	readonly fallbackTargets?: readonly string[];
	readonly maxLatencyMs?: number;
	readonly costCeiling?: RoutingCostTier;
}

export interface RoutingTaskClassConfig {
	readonly reasoning?: RoutingReasoningDepth;
	readonly toolsRequired?: boolean;
	readonly streamingPreferred?: boolean;
	readonly multimodalRequired?: boolean;
	readonly privacy?: RoutingPrivacyTier;
	readonly maxLatencyMs?: number;
	readonly costCeiling?: RoutingCostTier;
	readonly expectedInputTokens?: number;
	readonly expectedOutputTokens?: number;
	readonly preferredTargets?: readonly string[];
	readonly keywords?: readonly string[];
}

export interface AgentRoutingConfig {
	readonly defaultPolicy?: string;
	readonly roster?: readonly string[];
	readonly preferredTargets?: Readonly<Record<string, readonly string[]>>;
	readonly pinnedTargets?: Readonly<Record<string, string>>;
}

export interface RoutingWorkloadBinding {
	readonly policy?: string;
	readonly taskClass?: string;
	readonly target?: string;
}

export interface RoutingConfig {
	readonly source: "explicit";
	readonly enabled: boolean;
	readonly defaultPolicy?: string;
	readonly accounts: Readonly<Record<string, RoutingAccountConfig>>;
	readonly targets: Readonly<Record<string, RoutingTargetConfig>>;
	readonly policies: Readonly<Record<string, RoutingPolicyConfig>>;
	readonly taskClasses: Readonly<Record<string, RoutingTaskClassConfig>>;
	readonly agents: Readonly<Record<string, AgentRoutingConfig>>;
	readonly workloads?: {
		readonly default?: RoutingWorkloadBinding;
		readonly interactive?: RoutingWorkloadBinding;
		readonly memoryExtraction?: RoutingWorkloadBinding;
		readonly aggregateRecall?: RoutingWorkloadBinding;
		readonly repair?: RoutingWorkloadBinding;
	};
}

export interface RoutingRuntimeState {
	readonly available: boolean;
	readonly health: "healthy" | "degraded" | "blocked";
	readonly circuitOpen: boolean;
	readonly accountState: "ready" | "missing" | "expired" | "rate_limited" | "unknown";
	readonly unavailableReason?: string;
}

export interface RoutingRuntimeSnapshot {
	readonly targets: Readonly<Record<string, RoutingRuntimeState>>;
}

export interface RouteRequest {
	readonly agentId?: string;
	readonly operation: RoutingOperationKind;
	readonly taskClass?: string;
	readonly explicitPolicy?: string;
	readonly explicitTargets?: readonly string[];
	readonly requireTools?: boolean;
	readonly requireStreaming?: boolean;
	readonly requireMultimodal?: boolean;
	readonly expectedInputTokens?: number;
	readonly expectedOutputTokens?: number;
	readonly privacy?: RoutingPrivacyTier;
	readonly latencyBudgetMs?: number;
	readonly costCeiling?: RoutingCostTier;
	readonly promptPreview?: string;
}

export interface RouteClassification {
	readonly taskClass: string;
	readonly reasoning: RoutingReasoningDepth;
	readonly source: "request" | "workload" | "classifier" | "default";
	readonly signals: readonly string[];
}

export interface RouteCandidateTrace {
	readonly targetRef: string;
	readonly allowed: boolean;
	readonly score: number | null;
	readonly reasons: readonly string[];
	readonly blockedBy: readonly string[];
	readonly runtime: RoutingRuntimeState;
}

export interface RouteTrace {
	readonly policyId: string;
	readonly mode: RoutingPolicyMode;
	readonly classification: RouteClassification;
	readonly orderedTargets: readonly string[];
	readonly candidates: readonly RouteCandidateTrace[];
}

export interface RouteDecision {
	readonly policyId: string;
	readonly mode: RoutingPolicyMode;
	readonly taskClass: string;
	readonly targetRef: string;
	readonly targetId: string;
	readonly modelId: string;
	readonly fallbackTargetRefs: readonly string[];
	readonly trace: RouteTrace;
}

export function ok<T>(value: T): RouterResult<T> {
	return { ok: true, value };
}

export function err(
	code: RouterError["code"],
	message: string,
	details?: Readonly<Record<string, unknown>>,
): RouterResult<never> {
	return { ok: false, error: { code, message, ...(details ? { details } : {}) } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asMember<const Values extends readonly string[]>(value: unknown, values: Values): Values[number] | undefined {
	if (typeof value !== "string") return undefined;
	return values.find((candidate) => candidate === value);
}

function parseRecordEntries<T>(value: unknown, parse: (value: unknown) => T | null): Record<string, T> {
	const result: Record<string, T> = {};
	if (!isRecord(value)) return result;
	for (const [key, raw] of Object.entries(value)) {
		const parsed = parse(raw);
		if (parsed !== null) result[key] = parsed;
	}
	return result;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function isLocalInferenceEndpoint(endpoint: string | undefined): boolean {
	if (!endpoint) return true;
	try {
		const parsed = new URL(endpoint);
		return ["127.0.0.1", "localhost", "::1", "[::1]"].includes(parsed.hostname);
	} catch {
		return false;
	}
}

function asBool(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function asPositiveInt(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
	return Math.floor(value);
}

function asNonNegativeInt(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
	return Math.floor(value);
}

function asRecordOfStrings(value: unknown): Record<string, string> {
	if (!isRecord(value)) return {};
	const next: Record<string, string> = {};
	for (const [key, raw] of Object.entries(value)) {
		const parsed = asString(raw);
		if (parsed) next[key] = parsed;
	}
	return next;
}

function asRecordOfStringArrays(value: unknown): Record<string, readonly string[]> {
	if (!isRecord(value)) return {};
	const next: Record<string, readonly string[]> = {};
	for (const [key, raw] of Object.entries(value)) {
		const parsed = asStringArray(raw);
		if (parsed.length > 0) next[key] = parsed;
	}
	return next;
}

function asStringArray(value: unknown): readonly string[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((entry) => {
		const parsed = asString(entry);
		return parsed ? [parsed] : [];
	});
}

function hasStandaloneRoutingShape(raw: Record<string, unknown>): boolean {
	return [
		"enabled",
		"defaultPolicy",
		"default_policy",
		"accounts",
		"targets",
		"providers",
		"policies",
		"taskClasses",
		"task_classes",
		"agents",
		"workloads",
	].some((key) => key in raw);
}

function asRoutingMode(value: unknown, fallback: RoutingPolicyMode): RoutingPolicyMode {
	return asMember(value, ROUTING_POLICY_MODES) ?? fallback;
}

function asRoutingPrivacyTier(value: unknown, fallback: RoutingPrivacyTier): RoutingPrivacyTier {
	return asMember(value, ROUTING_PRIVACY_TIERS) ?? fallback;
}

function asRoutingReasoningDepth(value: unknown, fallback: RoutingReasoningDepth): RoutingReasoningDepth {
	return asMember(value, ROUTING_REASONING_DEPTHS) ?? fallback;
}

function asRoutingCostTier(value: unknown): RoutingCostTier | undefined {
	return asMember(value, ROUTING_COST_TIERS);
}

interface InferredTargetDefaults {
	readonly kind: RoutingTargetKind;
	readonly privacy: RoutingPrivacyTier;
}

const INFERRED_TARGET_DEFAULTS: Readonly<Record<string, InferredTargetDefaults>> = {
	acpx: { kind: "subscription_session", privacy: "restricted_remote" },
	anthropic: { kind: "api", privacy: "remote_ok" },
	"claude-code": { kind: "subscription_session", privacy: "restricted_remote" },
	codex: { kind: "subscription_session", privacy: "restricted_remote" },
	command: { kind: "local", privacy: "remote_ok" },
	"llama-cpp": { kind: "local", privacy: "local_only" },
	ollama: { kind: "local", privacy: "local_only" },
	"openai-compatible": { kind: "gateway", privacy: "remote_ok" },
	openrouter: { kind: "api", privacy: "remote_ok" },
	opencode: { kind: "subscription_session", privacy: "restricted_remote" },
};

function inferTargetKind(executor: string): RoutingTargetKind {
	return INFERRED_TARGET_DEFAULTS[executor]?.kind ?? "api";
}

export function inferTargetPrivacy(executor: string, endpoint?: string): RoutingPrivacyTier {
	if (executor === "openai-compatible" && isLocalInferenceEndpoint(endpoint)) return "local_only";
	return INFERRED_TARGET_DEFAULTS[executor]?.privacy ?? "remote_ok";
}

export function makeRoutingTargetRef(targetId: string, modelId: string): RoutingTargetRef {
	return `${targetId}/${modelId}` as RoutingTargetRef;
}

export function parseRoutingTargetRef(
	value: string,
): RouterResult<{ readonly targetId: string; readonly modelId: string }> {
	const trimmed = value.trim();
	const slash = trimmed.indexOf("/");
	if (slash <= 0 || slash === trimmed.length - 1) {
		return err("invalid-target-ref", `Invalid target ref "${value}". Expected target/model.`);
	}
	return ok({
		targetId: trimmed.slice(0, slash),
		modelId: trimmed.slice(slash + 1),
	});
}

function parseAccountConfig(raw: unknown): RoutingAccountConfig | null {
	if (!isRecord(raw)) return null;
	const kind = asMember(asString(raw.kind), ROUTING_ACCOUNT_KINDS);
	if (!kind) return null;
	const providerFamily = asString(raw.providerFamily ?? raw.provider_family);
	if (!providerFamily) return null;
	return {
		kind,
		providerFamily,
		label: asString(raw.label),
		credentialRef: asString(raw.credentialRef ?? raw.credential_ref ?? raw.secretRef ?? raw.secret_ref),
		sessionRef: asString(raw.sessionRef ?? raw.session_ref),
		usageTier: asString(raw.usageTier ?? raw.usage_tier),
	};
}

function parseModelConfig(raw: unknown): RoutingModelConfig | null {
	if (!isRecord(raw)) return null;
	const model = asString(raw.model);
	if (!model) return null;
	return {
		model,
		label: asString(raw.label),
		reasoning: asRoutingReasoningDepth(raw.reasoning, "medium"),
		contextWindow: asPositiveInt(raw.contextWindow ?? raw.context_window),
		toolUse: asBool(raw.toolUse ?? raw.tool_use),
		streaming: asBool(raw.streaming),
		multimodal: asBool(raw.multimodal),
		costTier: asRoutingCostTier(raw.costTier ?? raw.cost_tier),
		averageLatencyMs: asPositiveInt(raw.averageLatencyMs ?? raw.average_latency_ms),
	};
}

function parseCommandConfig(raw: unknown): PipelineCommandConfig | undefined {
	if (!isRecord(raw)) return undefined;
	const bin = asString(raw.bin ?? raw.command);
	if (!bin) return undefined;
	const args = asStringArray(raw.args);
	const cwd = asString(raw.cwd);
	const env = asRecordOfStrings(raw.env);
	return {
		bin,
		args,
		...(cwd ? { cwd } : {}),
		...(Object.keys(env).length > 0 ? { env } : {}),
	};
}

function asAcpxTerminalMode(value: unknown): RoutingAcpxTerminalMode | undefined {
	if (value === false) return "disabled";
	if (value === true) return "enabled";
	return asMember(value, ACPX_TOGGLE_MODES);
}

function parseAcpxConfig(raw: unknown): RoutingAcpxConfig | undefined {
	if (!isRecord(raw)) return undefined;
	const nested = isRecord(raw.acpx) ? raw.acpx : raw;
	const agent = asString(nested.agent ?? nested.harness);
	if (!agent) return undefined;
	const allowedTools = asStringArray(nested.allowedTools ?? nested.allowed_tools);
	const extraArgs = asStringArray(nested.extraArgs ?? nested.extra_args);
	return {
		agent,
		modelSelection: resolveAcpxModelSelection(
			agent,
			asMember(nested.modelSelection ?? nested.model_selection, ACPX_MODEL_SELECTIONS),
		),
		version: asString(nested.version ?? nested.acpxVersion ?? nested.acpx_version),
		bin: asString(nested.bin ?? nested.command),
		package: asString(nested.package ?? nested.packageRef ?? nested.package_ref),
		cwd: asString(nested.cwd ?? nested.workspace),
		session: asString(nested.session ?? nested.sessionName ?? nested.session_name),
		mode: asMember(nested.mode, ACPX_SESSION_MODES),
		permissions: asMember(nested.permissions ?? nested.permissionMode ?? nested.permission_mode, ACPX_PERMISSION_MODES),
		hooks: asMember(nested.hooks ?? nested.hooksMode ?? nested.hooks_mode, ACPX_TOGGLE_MODES),
		terminal: asAcpxTerminalMode(nested.terminal ?? nested.terminalMode ?? nested.terminal_mode),
		allowedTools: allowedTools.length > 0 ? allowedTools : undefined,
		format: asMember(nested.format ?? nested.outputFormat ?? nested.output_format, ACPX_OUTPUT_FORMATS),
		captureEvents: asBool(nested.captureEvents ?? nested.capture_events),
		maxCapturedEvents: asPositiveInt(nested.maxCapturedEvents ?? nested.max_captured_events),
		emptyResponseRetries: Math.min(
			3,
			asNonNegativeInt(nested.emptyResponseRetries ?? nested.empty_response_retries) ?? 1,
		),
		timeoutMs: asPositiveInt(nested.timeoutMs ?? nested.timeout_ms),
		extraArgs: extraArgs.length > 0 ? extraArgs : undefined,
	};
}

function parseOpenRouterConfig(raw: unknown): RoutingOpenRouterConfig | undefined {
	if (!isRecord(raw)) return undefined;
	const nested = isRecord(raw.openrouter) ? raw.openrouter : raw;
	const reasoningRaw = isRecord(nested.reasoning) ? nested.reasoning : undefined;
	if (!reasoningRaw) return undefined;
	const enabled = asBool(reasoningRaw.enabled);
	const maxTokens = asNonNegativeInt(reasoningRaw.maxTokens ?? reasoningRaw.max_tokens);
	const reasoning = {
		...(enabled !== undefined ? { enabled } : {}),
		...(maxTokens !== undefined ? { maxTokens } : {}),
	};
	return Object.keys(reasoning).length > 0 ? { reasoning } : undefined;
}

function parseTargetConfig(raw: unknown): RoutingTargetConfig | null {
	if (!isRecord(raw)) return null;
	const executor = asString(raw.executor);
	if (!executor || !ROUTING_EXECUTOR_PATTERN.test(executor)) return null;
	const modelsRaw = isRecord(raw.models) ? raw.models : null;
	if (!modelsRaw) return null;
	const models: Record<string, RoutingModelConfig> = {};
	for (const [modelId, modelRaw] of Object.entries(modelsRaw)) {
		const parsed = parseModelConfig(modelRaw);
		if (parsed) models[modelId] = parsed;
	}
	if (Object.keys(models).length === 0) return null;
	const acpx = executor === "acpx" ? parseAcpxConfig(raw) : undefined;
	if (executor === "acpx" && !acpx) return null;
	const openrouter = executor === "openrouter" ? parseOpenRouterConfig(raw) : undefined;
	const endpoint = asString(raw.endpoint ?? raw.baseUrl ?? raw.base_url);
	return {
		kind: asMember(asString(raw.kind), ROUTING_TARGET_KINDS) ?? inferTargetKind(executor),
		executor: executor as RoutingExecutorKind,
		account: asString(raw.account),
		endpoint,
		command: parseCommandConfig(raw.command),
		acpx,
		openrouter,
		privacy: asRoutingPrivacyTier(raw.privacy, inferTargetPrivacy(executor, endpoint)),
		models,
	};
}

function parsePolicyConfig(raw: unknown): RoutingPolicyConfig | null {
	if (!isRecord(raw)) return null;
	return {
		mode: asRoutingMode(raw.mode, "automatic"),
		allow: asStringArray(raw.allow),
		deny: asStringArray(raw.deny),
		defaultTargets: asStringArray(raw.defaultTargets ?? raw.default_targets),
		taskTargets: asRecordOfStringArrays(raw.taskTargets ?? raw.task_targets),
		fallbackTargets: asStringArray(raw.fallbackTargets ?? raw.fallback_targets),
		maxLatencyMs: asPositiveInt(raw.maxLatencyMs ?? raw.max_latency_ms),
		costCeiling: asRoutingCostTier(raw.costCeiling ?? raw.cost_ceiling),
	};
}

function parseTaskClassConfig(raw: unknown): RoutingTaskClassConfig | null {
	if (!isRecord(raw)) return null;
	return {
		reasoning: asRoutingReasoningDepth(raw.reasoning, "medium"),
		toolsRequired: asBool(raw.toolsRequired ?? raw.tools_required),
		streamingPreferred: asBool(raw.streamingPreferred ?? raw.streaming_preferred),
		multimodalRequired: asBool(raw.multimodalRequired ?? raw.multimodal_required),
		privacy: asString(raw.privacy) ? asRoutingPrivacyTier(raw.privacy, "remote_ok") : undefined,
		maxLatencyMs: asPositiveInt(raw.maxLatencyMs ?? raw.max_latency_ms),
		costCeiling: asRoutingCostTier(raw.costCeiling ?? raw.cost_ceiling),
		expectedInputTokens: asPositiveInt(raw.expectedInputTokens ?? raw.expected_input_tokens),
		expectedOutputTokens: asPositiveInt(raw.expectedOutputTokens ?? raw.expected_output_tokens),
		preferredTargets: asStringArray(raw.preferredTargets ?? raw.preferred_targets),
		keywords: asStringArray(raw.keywords),
	};
}

function parseAgentRoutingConfig(raw: unknown): AgentRoutingConfig | null {
	if (!isRecord(raw)) return null;
	return {
		defaultPolicy: asString(raw.defaultPolicy ?? raw.default_policy),
		roster: asStringArray(raw.roster),
		preferredTargets: asRecordOfStringArrays(raw.preferredTargets ?? raw.preferred_targets),
		pinnedTargets: asRecordOfStrings(raw.pinnedTargets ?? raw.pinned_targets),
	};
}

function parseWorkloadBinding(raw: unknown): RoutingWorkloadBinding | undefined {
	if (!isRecord(raw)) return undefined;
	const policy = asString(raw.policy);
	const taskClass = asString(raw.taskClass ?? raw.task_class);
	const target = asString(raw.target);
	if (!policy && !taskClass && !target) return undefined;
	return {
		...(policy ? { policy } : {}),
		...(taskClass ? { taskClass } : {}),
		...(target ? { target } : {}),
	};
}

function emptyRoutingConfig(): RoutingConfig {
	return {
		source: "explicit",
		enabled: false,
		accounts: {},
		targets: {},
		policies: {},
		taskClasses: {},
		agents: {},
	};
}
export function validateRoutingReferences(config: RoutingConfig): readonly RoutingValidationIssue[] {
	const issues: RoutingValidationIssue[] = [];
	const policyIds = new Set(Object.keys(config.policies));
	const taskClassIds = new Set<string>([
		...Object.keys(config.taskClasses),
		...Object.values(ROUTING_CLASSIFIER_TASK_CLASSES),
		"memory_extraction",
		"session_synthesis",
		"interactive",
	]);
	const accountIds = new Set(Object.keys(config.accounts));
	const validTargetRefs = new Set(allTargetRefs(config));

	const missingTarget = (field: string, ref: string, severity: "error" | "warning"): void => {
		if (!validTargetRefs.has(ref)) {
			issues.push({ severity, field, ref, message: `Target ref "${ref}" referenced by ${field} does not exist.` });
		}
	};
	const missingPolicy = (field: string, ref: string, severity: "error" | "warning"): void => {
		if (!policyIds.has(ref)) {
			issues.push({ severity, field, ref, message: `Policy "${ref}" referenced by ${field} does not exist.` });
		}
	};
	const missingTaskClass = (field: string, ref: string): void => {
		if (!taskClassIds.has(ref)) {
			issues.push({
				severity: "warning",
				field,
				ref,
				message: `Task class "${ref}" referenced by ${field} does not exist.`,
			});
		}
	};
	const missingAccount = (field: string, ref: string): void => {
		if (!accountIds.has(ref)) {
			issues.push({
				severity: "warning",
				field,
				ref,
				message: `Account "${ref}" referenced by ${field} does not exist.`,
			});
		}
	};

	if (config.defaultPolicy && policyIds.size > 0) {
		missingPolicy("defaultPolicy", config.defaultPolicy, "error");
	}

	for (const [targetId, target] of Object.entries(config.targets)) {
		if (target.account) missingAccount(`targets.${targetId}.account`, target.account);
	}

	if (config.workloads) {
		for (const [name, binding] of Object.entries(config.workloads)) {
			if (!binding) continue;
			const field = `workloads.${name}`;
			if (binding.policy) missingPolicy(`${field}.policy`, binding.policy, "warning");
			if (binding.target) missingTarget(`${field}.target`, binding.target, "warning");
			if (binding.taskClass) missingTaskClass(`${field}.taskClass`, binding.taskClass);
		}
	}

	for (const [policyId, policy] of Object.entries(config.policies)) {
		for (const ref of policy.allow ?? []) missingTarget(`policies.${policyId}.allow`, ref, "warning");
		for (const ref of policy.defaultTargets ?? []) {
			missingTarget(`policies.${policyId}.defaultTargets`, ref, "warning");
		}
		for (const ref of policy.fallbackTargets ?? []) {
			missingTarget(`policies.${policyId}.fallbackTargets`, ref, "warning");
		}
		for (const [taskClass, refs] of Object.entries(policy.taskTargets ?? {})) {
			missingTaskClass(`policies.${policyId}.taskTargets.${taskClass}`, taskClass);
			for (const ref of refs) missingTarget(`policies.${policyId}.taskTargets.${taskClass}`, ref, "warning");
		}
	}

	for (const [agentId, agent] of Object.entries(config.agents)) {
		if (agent.defaultPolicy) missingPolicy(`agents.${agentId}.defaultPolicy`, agent.defaultPolicy, "warning");
		for (const ref of agent.roster ?? []) missingTarget(`agents.${agentId}.roster`, ref, "warning");
		for (const [taskClass, refs] of Object.entries(agent.preferredTargets ?? {})) {
			missingTaskClass(`agents.${agentId}.preferredTargets.${taskClass}`, taskClass);
			for (const ref of refs) missingTarget(`agents.${agentId}.preferredTargets.${taskClass}`, ref, "warning");
		}
		for (const [taskClass, ref] of Object.entries(agent.pinnedTargets ?? {})) {
			if (taskClass !== "default") missingTaskClass(`agents.${agentId}.pinnedTargets.${taskClass}`, taskClass);
			missingTarget(`agents.${agentId}.pinnedTargets.${taskClass}`, ref, "warning");
		}
	}

	for (const [taskClassId, taskClass] of Object.entries(config.taskClasses)) {
		for (const ref of taskClass.preferredTargets ?? []) {
			missingTarget(`taskClasses.${taskClassId}.preferredTargets`, ref, "warning");
		}
	}

	return issues;
}

export function parseRoutingConfig(raw: unknown): RouterResult<RoutingConfig> {
	const base = emptyRoutingConfig();
	if (!isRecord(raw)) {
		return ok(base);
	}
	const embeddedInference = isRecord(raw.inference) ? raw.inference : null;
	const standaloneInference = embeddedInference ? null : hasStandaloneRoutingShape(raw) ? raw : null;
	const routingRaw = embeddedInference ?? standaloneInference;
	if (!routingRaw) {
		return ok(base);
	}

	const accounts = { ...base.accounts, ...parseRecordEntries(routingRaw.accounts, parseAccountConfig) };

	const targetsRaw = isRecord(routingRaw.targets)
		? routingRaw.targets
		: isRecord(routingRaw.providers)
			? routingRaw.providers
			: null;
	const targets = { ...base.targets, ...parseRecordEntries(targetsRaw, parseTargetConfig) };

	const policies = { ...base.policies, ...parseRecordEntries(routingRaw.policies, parsePolicyConfig) };

	const taskClasses = {
		...base.taskClasses,
		...parseRecordEntries(routingRaw.taskClasses ?? routingRaw.task_classes, parseTaskClassConfig),
	};

	const agents = { ...base.agents, ...parseRecordEntries(routingRaw.agents, parseAgentRoutingConfig) };

	const workloads = {
		...(base.workloads ?? {}),
	};
	if (isRecord(routingRaw.workloads)) {
		for (const [field, camelCase, snakeCase] of [
			["default", "default"],
			["interactive", "interactive"],
			["memoryExtraction", "memoryExtraction", "memory_extraction"],
			["aggregateRecall", "aggregateRecall", "aggregate_recall"],
			["repair", "repair"],
		] as const) {
			const raw = routingRaw.workloads[camelCase] ?? (snakeCase ? routingRaw.workloads[snakeCase] : undefined);
			const binding = parseWorkloadBinding(raw);
			if (binding) workloads[field] = binding;
		}
	}

	const explicitDefaultPolicy = asString(routingRaw.defaultPolicy ?? routingRaw.default_policy);
	if (!explicitDefaultPolicy && Object.keys(policies).length === 0 && Object.keys(targets).length > 0) {
		const refs = allTargetRefs({ ...base, targets });
		policies.default = {
			mode: "automatic",
			defaultTargets: refs,
			fallbackTargets: refs,
		};
	}

	const enabled = asBool(routingRaw.enabled) ?? (Object.keys(targets).length > 0 || base.enabled);
	const defaultPolicy = explicitDefaultPolicy ?? base.defaultPolicy ?? Object.keys(policies)[0];

	const config: RoutingConfig = {
		source: "explicit",
		enabled,
		...(defaultPolicy ? { defaultPolicy } : {}),
		accounts,
		targets,
		policies,
		taskClasses,
		agents,
		...(Object.keys(workloads).length > 0 ? { workloads } : {}),
	};

	const issues = validateRoutingReferences(config);
	const errors = issues.filter((issue) => issue.severity === "error");
	if (errors.length > 0) {
		const summary = errors.map((issue) => `${issue.field}="${issue.ref}"`).join("; ");
		return err("invalid-config", `Routing config has ${errors.length} broken reference(s): ${summary}`, {
			issues: errors,
			warnings: issues.filter((issue) => issue.severity === "warning"),
		});
	}

	return ok(config);
}

export function allTargetRefs(config: RoutingConfig): readonly string[] {
	const refs: string[] = [];
	for (const [targetId, target] of Object.entries(config.targets)) {
		for (const modelId of Object.keys(target.models)) {
			refs.push(makeRoutingTargetRef(targetId, modelId));
		}
	}
	return refs;
}
