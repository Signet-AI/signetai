import type { PipelineCommandConfig, PipelineExtractionConfig, PipelineSynthesisConfig } from "./types";

export const ROUTING_ACCOUNT_KINDS = ["subscription_session", "api"] as const;
export const ROUTING_TARGET_KINDS = ["subscription_session", "api", "local", "gateway"] as const;
export const ROUTING_EXECUTOR_KINDS = [
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
	"widget_generation",
	"repair",
	"os_agent",
] as const;

export type RoutingAccountKind = (typeof ROUTING_ACCOUNT_KINDS)[number];
export type RoutingTargetKind = (typeof ROUTING_TARGET_KINDS)[number];
export type RoutingExecutorKind = (typeof ROUTING_EXECUTOR_KINDS)[number];
export type RoutingPolicyMode = (typeof ROUTING_POLICY_MODES)[number];
export type RoutingPrivacyTier = (typeof ROUTING_PRIVACY_TIERS)[number];
export type RoutingReasoningDepth = (typeof ROUTING_REASONING_DEPTHS)[number];
export type RoutingCostTier = (typeof ROUTING_COST_TIERS)[number];
export type RoutingOperationKind = (typeof ROUTING_OPERATION_KINDS)[number];

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

export interface RoutingTargetConfig {
	readonly kind: RoutingTargetKind;
	readonly executor: RoutingExecutorKind;
	readonly account?: string;
	readonly endpoint?: string;
	readonly command?: PipelineCommandConfig;
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
	readonly source: "explicit" | "legacy-implicit";
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
		readonly sessionSynthesis?: RoutingWorkloadBinding;
		readonly widgetGeneration?: RoutingWorkloadBinding;
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

function ok<T>(value: T): RouterResult<T> {
	return { ok: true, value };
}

function err(
	code: RouterError["code"],
	message: string,
	details?: Readonly<Record<string, unknown>>,
): RouterResult<never> {
	return { ok: false, error: { code, message, ...(details ? { details } : {}) } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function asBool(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function asPositiveInt(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
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
	return typeof value === "string" && (ROUTING_POLICY_MODES as readonly string[]).includes(value)
		? (value as RoutingPolicyMode)
		: fallback;
}

function asRoutingPrivacyTier(value: unknown, fallback: RoutingPrivacyTier): RoutingPrivacyTier {
	return typeof value === "string" && (ROUTING_PRIVACY_TIERS as readonly string[]).includes(value)
		? (value as RoutingPrivacyTier)
		: fallback;
}

function asRoutingReasoningDepth(value: unknown, fallback: RoutingReasoningDepth): RoutingReasoningDepth {
	return typeof value === "string" && (ROUTING_REASONING_DEPTHS as readonly string[]).includes(value)
		? (value as RoutingReasoningDepth)
		: fallback;
}

function asRoutingCostTier(value: unknown): RoutingCostTier | undefined {
	return typeof value === "string" && (ROUTING_COST_TIERS as readonly string[]).includes(value)
		? (value as RoutingCostTier)
		: undefined;
}

function inferTargetKind(executor: string): RoutingTargetKind {
	if (executor === "ollama" || executor === "llama-cpp" || executor === "openai-compatible" || executor === "command") {
		return executor === "openai-compatible" ? "gateway" : "local";
	}
	if (executor === "anthropic" || executor === "openrouter") return "api";
	return "subscription_session";
}

function inferTargetPrivacy(executor: string): RoutingPrivacyTier {
	if (executor === "ollama" || executor === "llama-cpp") return "local_only";
	if (executor === "claude-code" || executor === "codex" || executor === "opencode") return "restricted_remote";
	return "remote_ok";
}

function mergeUnique(base: readonly string[], extra: readonly string[]): readonly string[] {
	const seen = new Set<string>();
	const merged: string[] = [];
	for (const value of [...base, ...extra]) {
		if (seen.has(value)) continue;
		seen.add(value);
		merged.push(value);
	}
	return merged;
}

function costRank(value: RoutingCostTier | undefined): number {
	switch (value) {
		case "low":
			return 1;
		case "medium":
			return 2;
		case "high":
			return 3;
		default:
			return 2;
	}
}

function privacyRank(value: RoutingPrivacyTier): number {
	switch (value) {
		case "remote_ok":
			return 0;
		case "restricted_remote":
			return 1;
		case "local_only":
			return 2;
	}
}

function reasoningRank(value: RoutingReasoningDepth): number {
	switch (value) {
		case "low":
			return 1;
		case "medium":
			return 2;
		case "high":
			return 3;
	}
}

function defaultLatencyForTarget(target: RoutingTargetConfig): number {
	switch (target.kind) {
		case "local":
			return 50;
		case "api":
			return 350;
		case "gateway":
			return 250;
		case "subscription_session":
			return 900;
	}
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
		return err("invalid-target-ref", `Invalid target ref \"${value}\". Expected target/model.`);
	}
	return ok({
		targetId: trimmed.slice(0, slash),
		modelId: trimmed.slice(slash + 1),
	});
}

function parseAccountConfig(raw: unknown): RoutingAccountConfig | null {
	if (!isRecord(raw)) return null;
	const kind = asString(raw.kind);
	if (!kind || !(ROUTING_ACCOUNT_KINDS as readonly string[]).includes(kind)) return null;
	const providerFamily = asString(raw.providerFamily ?? raw.provider_family);
	if (!providerFamily) return null;
	return {
		kind: kind as RoutingAccountKind,
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

function parseTargetConfig(raw: unknown): RoutingTargetConfig | null {
	if (!isRecord(raw)) return null;
	const executor = asString(raw.executor);
	if (!executor || !(ROUTING_EXECUTOR_KINDS as readonly string[]).includes(executor)) return null;
	const modelsRaw = isRecord(raw.models) ? raw.models : null;
	if (!modelsRaw) return null;
	const models: Record<string, RoutingModelConfig> = {};
	for (const [modelId, modelRaw] of Object.entries(modelsRaw)) {
		const parsed = parseModelConfig(modelRaw);
		if (parsed) models[modelId] = parsed;
	}
	if (Object.keys(models).length === 0) return null;
	return {
		kind: (() => {
			const parsed = asString(raw.kind);
			if (parsed && (ROUTING_TARGET_KINDS as readonly string[]).includes(parsed)) {
				return parsed as RoutingTargetKind;
			}
			return inferTargetKind(executor);
		})(),
		executor: executor as RoutingExecutorKind,
		account: asString(raw.account),
		endpoint: asString(raw.endpoint ?? raw.baseUrl ?? raw.base_url),
		command: parseCommandConfig(raw.command),
		privacy: asRoutingPrivacyTier(raw.privacy, inferTargetPrivacy(executor)),
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

export function compileLegacyRoutingConfig(opts: {
	readonly extraction: Pick<PipelineExtractionConfig, "provider" | "model" | "endpoint" | "command">;
	readonly synthesis: Pick<PipelineSynthesisConfig, "enabled" | "provider" | "model" | "endpoint">;
}): RoutingConfig {
	const targets: Record<string, RoutingTargetConfig> = {};
	const policies: Record<string, RoutingPolicyConfig> = {};
	const taskClasses: Record<string, RoutingTaskClassConfig> = {
		default: {
			reasoning: "medium",
		},
		interactive: {
			reasoning: "medium",
		},
		memory_extraction: {
			reasoning: "medium",
		},
		session_synthesis: {
			reasoning: "medium",
		},
	};
	const workloads: {
		default?: RoutingWorkloadBinding;
		interactive?: RoutingWorkloadBinding;
		memoryExtraction?: RoutingWorkloadBinding;
		sessionSynthesis?: RoutingWorkloadBinding;
		widgetGeneration?: RoutingWorkloadBinding;
		repair?: RoutingWorkloadBinding;
	} = {};
	let defaultTargets: readonly string[] = [];

	if (opts.extraction.provider !== "none" && opts.extraction.provider !== "command") {
		targets["legacy-extraction"] = {
			kind: inferTargetKind(opts.extraction.provider),
			executor: opts.extraction.provider,
			endpoint: opts.extraction.endpoint,
			command: opts.extraction.command,
			privacy: inferTargetPrivacy(opts.extraction.provider),
			models: {
				default: {
					model: opts.extraction.model,
					label: opts.extraction.model,
					reasoning: "medium",
				},
			},
		};
		const ref = makeRoutingTargetRef("legacy-extraction", "default");
		workloads.memoryExtraction = {
			target: ref,
			taskClass: "memory_extraction",
		};
		defaultTargets = [...defaultTargets, ref];
	}

	if (opts.synthesis.enabled && opts.synthesis.provider !== "none") {
		targets["legacy-synthesis"] = {
			kind: inferTargetKind(opts.synthesis.provider),
			executor: opts.synthesis.provider,
			endpoint: opts.synthesis.endpoint,
			privacy: inferTargetPrivacy(opts.synthesis.provider),
			models: {
				default: {
					model: opts.synthesis.model,
					label: opts.synthesis.model,
					reasoning: "medium",
				},
			},
		};
		const ref = makeRoutingTargetRef("legacy-synthesis", "default");
		workloads.sessionSynthesis = {
			target: ref,
			taskClass: "session_synthesis",
		};
		defaultTargets = [ref, ...defaultTargets];
	}

	policies["legacy-default"] = {
		mode: "automatic",
		defaultTargets,
		fallbackTargets: defaultTargets,
	};
	workloads.default = {
		policy: "legacy-default",
		taskClass: "default",
	};
	workloads.interactive = {
		policy: "legacy-default",
		taskClass: "interactive",
	};
	workloads.widgetGeneration = {
		policy: "legacy-default",
		taskClass: "session_synthesis",
	};
	workloads.repair = {
		policy: "legacy-default",
		taskClass: "memory_extraction",
	};

	return {
		source: "legacy-implicit",
		enabled: defaultTargets.length > 0,
		defaultPolicy: "legacy-default",
		accounts: {},
		targets,
		policies,
		taskClasses,
		agents: {},
		workloads,
	};
}

function emptyRoutingConfig(source: RoutingConfig["source"]): RoutingConfig {
	return {
		source,
		enabled: false,
		accounts: {},
		targets: {},
		policies: {},
		taskClasses: {},
		agents: {},
	};
}

export function parseRoutingConfig(raw: unknown, legacyConfig?: RoutingConfig): RouterResult<RoutingConfig> {
	const base = legacyConfig ?? emptyRoutingConfig("explicit");
	if (!isRecord(raw)) {
		return ok(base);
	}
	const embeddedInference = isRecord(raw.inference) ? raw.inference : null;
	const standaloneInference = embeddedInference ? null : hasStandaloneRoutingShape(raw) ? raw : null;
	const routingRaw = embeddedInference ?? standaloneInference;
	if (!routingRaw) {
		return ok(base);
	}

	const accounts: Record<string, RoutingAccountConfig> = { ...base.accounts };
	if (isRecord(routingRaw.accounts)) {
		for (const [accountId, accountRaw] of Object.entries(routingRaw.accounts)) {
			const parsed = parseAccountConfig(accountRaw);
			if (parsed) accounts[accountId] = parsed;
		}
	}

	const targets: Record<string, RoutingTargetConfig> = { ...base.targets };
	const targetsRaw = isRecord(routingRaw.targets)
		? routingRaw.targets
		: isRecord(routingRaw.providers)
			? routingRaw.providers
			: null;
	if (targetsRaw) {
		for (const [targetId, targetRaw] of Object.entries(targetsRaw)) {
			const parsed = parseTargetConfig(targetRaw);
			if (parsed) targets[targetId] = parsed;
		}
	}

	const policies: Record<string, RoutingPolicyConfig> = { ...base.policies };
	if (isRecord(routingRaw.policies)) {
		for (const [policyId, policyRaw] of Object.entries(routingRaw.policies)) {
			const parsed = parsePolicyConfig(policyRaw);
			if (parsed) policies[policyId] = parsed;
		}
	}

	const taskClasses: Record<string, RoutingTaskClassConfig> = { ...base.taskClasses };
	if (isRecord(routingRaw.taskClasses ?? routingRaw.task_classes)) {
		const taskClassRaw = isRecord(routingRaw.taskClasses)
			? routingRaw.taskClasses
			: (routingRaw.task_classes as Record<string, unknown>);
		for (const [taskId, taskRaw] of Object.entries(taskClassRaw)) {
			const parsed = parseTaskClassConfig(taskRaw);
			if (parsed) taskClasses[taskId] = parsed;
		}
	}

	const agents: Record<string, AgentRoutingConfig> = { ...base.agents };
	if (isRecord(routingRaw.agents)) {
		for (const [agentId, agentRaw] of Object.entries(routingRaw.agents)) {
			const parsed = parseAgentRoutingConfig(agentRaw);
			if (parsed) agents[agentId] = parsed;
		}
	}

	const workloads = {
		...(base.workloads ?? {}),
	};
	if (isRecord(routingRaw.workloads)) {
		const defaultBinding = parseWorkloadBinding(routingRaw.workloads.default);
		const interactive = parseWorkloadBinding(routingRaw.workloads.interactive);
		const memoryExtraction = parseWorkloadBinding(
			routingRaw.workloads.memoryExtraction ?? routingRaw.workloads.memory_extraction,
		);
		const sessionSynthesis = parseWorkloadBinding(
			routingRaw.workloads.sessionSynthesis ?? routingRaw.workloads.session_synthesis,
		);
		const widgetGeneration = parseWorkloadBinding(
			routingRaw.workloads.widgetGeneration ?? routingRaw.workloads.widget_generation,
		);
		const repair = parseWorkloadBinding(routingRaw.workloads.repair);
		if (defaultBinding) workloads.default = defaultBinding;
		if (interactive) workloads.interactive = interactive;
		if (memoryExtraction) workloads.memoryExtraction = memoryExtraction;
		if (sessionSynthesis) workloads.sessionSynthesis = sessionSynthesis;
		if (widgetGeneration) workloads.widgetGeneration = widgetGeneration;
		if (repair) workloads.repair = repair;
	}

	const explicitDefaultPolicy = asString(routingRaw.defaultPolicy ?? routingRaw.default_policy);
	const enabled = asBool(routingRaw.enabled) ?? (Object.keys(targets).length > 0 || base.enabled);
	const defaultPolicy = explicitDefaultPolicy ?? base.defaultPolicy ?? Object.keys(policies)[0];

	if (defaultPolicy && !policies[defaultPolicy] && Object.keys(policies).length > 0) {
		return err("invalid-config", `Routing default policy \"${defaultPolicy}\" was not found.`, {
			availablePolicies: Object.keys(policies),
		});
	}

	return ok({
		source: embeddedInference || standaloneInference ? "explicit" : base.source,
		enabled,
		...(defaultPolicy ? { defaultPolicy } : {}),
		accounts,
		targets,
		policies,
		taskClasses,
		agents,
		...(Object.keys(workloads).length > 0 ? { workloads } : {}),
	});
}

function workloadBindingForOperation(
	config: RoutingConfig,
	operation: RoutingOperationKind,
): RoutingWorkloadBinding | undefined {
	switch (operation) {
		case "default":
			return config.workloads?.default;
		case "interactive":
		case "tool_planning":
		case "code_reasoning":
		case "os_agent":
			return config.workloads?.interactive ?? config.workloads?.default;
		case "memory_extraction":
			return config.workloads?.memoryExtraction ?? config.workloads?.default;
		case "session_synthesis":
			return config.workloads?.sessionSynthesis ?? config.workloads?.default;
		case "widget_generation":
			return config.workloads?.widgetGeneration ?? config.workloads?.sessionSynthesis ?? config.workloads?.default;
		case "repair":
			return config.workloads?.repair ?? config.workloads?.memoryExtraction ?? config.workloads?.default;
	}
}

function classifyRouteRequest(config: RoutingConfig, request: RouteRequest): RouteClassification {
	const workload = workloadBindingForOperation(config, request.operation);
	const workloadTaskClass = workload?.taskClass;
	if (request.taskClass && config.taskClasses[request.taskClass]) {
		return {
			taskClass: request.taskClass,
			reasoning: config.taskClasses[request.taskClass]?.reasoning ?? "medium",
			source: "request",
			signals: ["taskClass=request"],
		};
	}
	if (workloadTaskClass && config.taskClasses[workloadTaskClass]) {
		return {
			taskClass: workloadTaskClass,
			reasoning: config.taskClasses[workloadTaskClass]?.reasoning ?? "medium",
			source: "workload",
			signals: [`taskClass=workload:${request.operation}`],
		};
	}

	const preview = (request.promptPreview ?? "").toLowerCase();
	const keywordMatches: string[] = [];
	for (const [taskClass, cfg] of Object.entries(config.taskClasses)) {
		if (!cfg.keywords || cfg.keywords.length === 0) continue;
		const hit = cfg.keywords.some((keyword) => preview.includes(keyword.toLowerCase()));
		if (hit) keywordMatches.push(taskClass);
	}
	if (keywordMatches.length > 0) {
		const taskClass = keywordMatches[0];
		return {
			taskClass,
			reasoning: config.taskClasses[taskClass]?.reasoning ?? "medium",
			source: "classifier",
			signals: keywordMatches.map((value) => `keyword:${value}`),
		};
	}

	if (
		request.operation === "code_reasoning" ||
		/\b(function|typescript|javascript|stack trace|traceback|error:|tsx|tsx|rust|python|bun)\b/.test(preview)
	) {
		return {
			taskClass: "hard_coding",
			reasoning: "high",
			source: "classifier",
			signals: ["prompt=code-like"],
		};
	}
	if (request.privacy === "local_only") {
		return {
			taskClass: "local_sensitive",
			reasoning: "medium",
			source: "classifier",
			signals: ["privacy=local_only"],
		};
	}

	const fallbackTaskClass =
		request.operation === "memory_extraction"
			? "memory_extraction"
			: request.operation === "session_synthesis"
				? "session_synthesis"
				: "interactive";
	return {
		taskClass: fallbackTaskClass,
		reasoning: config.taskClasses[fallbackTaskClass]?.reasoning ?? "medium",
		source: "default",
		signals: ["fallback=default"],
	};
}

function orderedPreferenceLists(
	config: RoutingConfig,
	request: RouteRequest,
	classification: RouteClassification,
):
	| {
			readonly policyId: string;
			readonly mode: RoutingPolicyMode;
			readonly orderedTargets: readonly string[];
			readonly fallbackTargets: readonly string[];
	  }
	| RouterError {
	const workload = workloadBindingForOperation(config, request.operation);
	const agentConfig = request.agentId ? config.agents[request.agentId] : undefined;
	const policyId =
		request.explicitPolicy ??
		workload?.policy ??
		agentConfig?.defaultPolicy ??
		config.defaultPolicy ??
		Object.keys(config.policies)[0];
	if (!policyId) {
		return {
			code: "policy-not-found",
			message: "No routing policy is configured.",
		};
	}
	const policy = config.policies[policyId];
	if (!policy) {
		return {
			code: "policy-not-found",
			message: `Routing policy \"${policyId}\" was not found.`,
		};
	}

	const allowedTargets = new Set(targetRefsAllowedByPolicy(config, request, policy));
	const explicitTargets = request.explicitTargets ?? [];
	const disallowedExplicitTargets = explicitTargets.filter((targetRef) => !allowedTargets.has(targetRef));
	if (disallowedExplicitTargets.length > 0) {
		return {
			code: "no-candidates",
			message: "Explicit target overrides are not allowed by the active agent roster or policy.",
			details: {
				policyId,
				agentId: request.agentId,
				explicitTargets: disallowedExplicitTargets,
			},
		};
	}
	const pinnedTarget = agentConfig?.pinnedTargets?.[classification.taskClass] ?? agentConfig?.pinnedTargets?.default;
	const orderedTargets = mergeUnique(
		explicitTargets,
		mergeUnique(
			pinnedTarget ? [pinnedTarget] : [],
			mergeUnique(
				workload?.target ? [workload.target] : [],
				mergeUnique(
					agentConfig?.preferredTargets?.[classification.taskClass] ?? [],
					mergeUnique(
						config.taskClasses[classification.taskClass]?.preferredTargets ?? [],
						mergeUnique(policy.taskTargets?.[classification.taskClass] ?? [], policy.defaultTargets ?? []),
					),
				),
			),
		),
	).filter((targetRef) => allowedTargets.has(targetRef));

	return {
		policyId,
		mode: policy.mode,
		orderedTargets,
		fallbackTargets: (policy.fallbackTargets ?? []).filter((targetRef) => allowedTargets.has(targetRef)),
	};
}

function targetRefsAllowedByPolicy(
	config: RoutingConfig,
	request: RouteRequest,
	policy: RoutingPolicyConfig,
): readonly string[] {
	const agentConfig = request.agentId ? config.agents[request.agentId] : undefined;
	const roster = agentConfig?.roster && agentConfig.roster.length > 0 ? agentConfig.roster : allTargetRefs(config);
	let candidates = [...roster];
	if (policy.allow && policy.allow.length > 0) {
		const allowed = new Set(policy.allow);
		candidates = candidates.filter((candidate) => allowed.has(candidate));
	}
	if (policy.deny && policy.deny.length > 0) {
		const denied = new Set(policy.deny);
		candidates = candidates.filter((candidate) => !denied.has(candidate));
	}
	return candidates;
}

function targetRefsForRoster(
	config: RoutingConfig,
	request: RouteRequest,
	classification: RouteClassification,
	policy: RoutingPolicyConfig,
): readonly string[] {
	let candidates = [...targetRefsAllowedByPolicy(config, request, policy)];
	if (request.explicitTargets && request.explicitTargets.length > 0) {
		const explicit = new Set(request.explicitTargets);
		candidates = candidates.filter((candidate) => explicit.has(candidate));
	}
	const preferred = config.taskClasses[classification.taskClass]?.preferredTargets ?? [];
	return mergeUnique(preferred, candidates);
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

function buildCandidateTrace(
	config: RoutingConfig,
	request: RouteRequest,
	classification: RouteClassification,
	targetRef: string,
	runtime: RoutingRuntimeState,
	policy: RoutingPolicyConfig,
	orderedTargets: readonly string[],
): RouteCandidateTrace {
	const ref = parseRoutingTargetRef(targetRef);
	if (ref.ok === false) {
		const invalid = ref.error.message;
		return {
			targetRef,
			allowed: false,
			score: null,
			reasons: [],
			blockedBy: [invalid],
			runtime,
		};
	}
	const target = config.targets[ref.value.targetId];
	const model = target?.models[ref.value.modelId];
	if (!target || !model) {
		return {
			targetRef,
			allowed: false,
			score: null,
			reasons: [],
			blockedBy: ["target not found"],
			runtime,
		};
	}

	const blockedBy: string[] = [];
	const reasons: string[] = [];
	let score = 0;
	const requiredPrivacy = request.privacy ?? config.taskClasses[classification.taskClass]?.privacy ?? "remote_ok";
	const targetPrivacy = target.privacy ?? inferTargetPrivacy(target.executor);
	if (privacyRank(targetPrivacy) < privacyRank(requiredPrivacy)) {
		blockedBy.push(`privacy gate (${requiredPrivacy})`);
	}
	if (requiredPrivacy === "local_only" && target.kind !== "local") {
		blockedBy.push("local_only request requires local executor");
	}
	if ((request.requireTools ?? config.taskClasses[classification.taskClass]?.toolsRequired) && model.toolUse !== true) {
		blockedBy.push("tool-use required");
	}
	if (
		(request.requireStreaming ?? config.taskClasses[classification.taskClass]?.streamingPreferred) &&
		model.streaming !== true
	) {
		blockedBy.push("streaming required");
	}
	if (
		(request.requireMultimodal ?? config.taskClasses[classification.taskClass]?.multimodalRequired) &&
		model.multimodal !== true
	) {
		blockedBy.push("multimodal required");
	}
	const expectedInputTokens =
		request.expectedInputTokens ?? config.taskClasses[classification.taskClass]?.expectedInputTokens;
	if (expectedInputTokens && model.contextWindow && expectedInputTokens > model.contextWindow) {
		blockedBy.push(`context window too small (${model.contextWindow})`);
	}
	if (!runtime.available || runtime.circuitOpen || runtime.health === "blocked") {
		blockedBy.push(runtime.unavailableReason ?? "executor unavailable");
	}
	if (
		runtime.accountState === "missing" ||
		runtime.accountState === "expired" ||
		runtime.accountState === "rate_limited"
	) {
		blockedBy.push(`account state ${runtime.accountState}`);
	}

	const requiredCost =
		request.costCeiling ?? config.taskClasses[classification.taskClass]?.costCeiling ?? policy.costCeiling;
	if (requiredCost && model.costTier && costRank(model.costTier) > costRank(requiredCost)) {
		blockedBy.push(`cost tier ${model.costTier} exceeds ${requiredCost}`);
	}

	const latencyBudget =
		request.latencyBudgetMs ?? config.taskClasses[classification.taskClass]?.maxLatencyMs ?? policy.maxLatencyMs;
	const estimatedLatency = model.averageLatencyMs ?? defaultLatencyForTarget(target);
	if (latencyBudget && estimatedLatency > latencyBudget * 2) {
		blockedBy.push(`estimated latency ${estimatedLatency}ms exceeds budget ${latencyBudget}ms`);
	}

	const reasoning = model.reasoning ?? "medium";
	const reasoningDelta = reasoningRank(reasoning) - reasoningRank(classification.reasoning);
	score += 100 - orderedTargets.indexOf(targetRef) * 5;
	if (orderedTargets.includes(targetRef)) {
		reasons.push(`preferred order ${orderedTargets.indexOf(targetRef) + 1}`);
	}
	if (reasoningDelta >= 0) {
		score += 25 - reasoningDelta * 3;
		reasons.push(`reasoning ${reasoning}`);
	} else {
		score += 10 + reasoningDelta * 10;
		reasons.push(`reasoning under target (${reasoning})`);
	}
	if (target.kind === "local") {
		score += 12;
		reasons.push("local executor");
	}
	if (latencyBudget && estimatedLatency <= latencyBudget) {
		score += 10;
		reasons.push(`latency within budget (${estimatedLatency}ms)`);
	}
	if (requiredCost && model.costTier && costRank(model.costTier) <= costRank(requiredCost)) {
		score += 8;
		reasons.push(`cost tier ${model.costTier}`);
	}
	if (runtime.health === "healthy") {
		score += 12;
		reasons.push("runtime healthy");
	} else if (runtime.health === "degraded") {
		score -= 8;
		reasons.push("runtime degraded");
	}
	if (runtime.accountState === "ready") {
		score += 6;
		reasons.push("account ready");
	}

	return {
		targetRef,
		allowed: blockedBy.length === 0,
		score: blockedBy.length === 0 ? score : null,
		reasons,
		blockedBy,
		runtime,
	};
}

export function resolveRoutingDecision(
	config: RoutingConfig,
	request: RouteRequest,
	runtimeSnapshot: RoutingRuntimeSnapshot,
): RouterResult<RouteDecision> {
	if (!config.enabled) {
		return err("no-candidates", "Routing is not enabled for this agent config.");
	}
	const pref = orderedPreferenceLists(config, request, classifyRouteRequest(config, request));
	if ("code" in pref) {
		return { ok: false, error: pref };
	}
	const policy = config.policies[pref.policyId];
	const classification = classifyRouteRequest(config, request);
	const candidateRefs = mergeUnique(
		pref.orderedTargets,
		mergeUnique(targetRefsForRoster(config, request, classification, policy), pref.fallbackTargets),
	);
	if (candidateRefs.length === 0) {
		return err("no-candidates", "No route candidates were available for this request.", {
			policyId: pref.policyId,
			agentId: request.agentId,
			taskClass: classification.taskClass,
		});
	}

	const traces = candidateRefs.map((targetRef) =>
		buildCandidateTrace(
			config,
			request,
			classification,
			targetRef,
			runtimeSnapshot.targets[targetRef] ?? {
				available: false,
				health: "blocked",
				circuitOpen: false,
				accountState: "unknown",
				unavailableReason: "missing runtime snapshot",
			},
			policy,
			pref.orderedTargets,
		),
	);

	const trace: RouteTrace = {
		policyId: pref.policyId,
		mode: pref.mode,
		classification,
		orderedTargets: pref.orderedTargets,
		candidates: traces,
	};

	const allowed = traces.filter((candidate) => candidate.allowed);
	if (allowed.length === 0) {
		return err("no-candidates", "All routing candidates were blocked by policy or runtime state.", {
			trace,
		});
	}

	const selected =
		pref.mode === "strict" ? allowed[0] : [...allowed].sort((left, right) => (right.score ?? 0) - (left.score ?? 0))[0];
	const parsedRef = parseRoutingTargetRef(selected.targetRef);
	if (parsedRef.ok === false) {
		return err("invalid-target-ref", parsedRef.error.message);
	}
	const fallbackTargetRefs = allowed
		.filter((candidate) => candidate.targetRef !== selected.targetRef)
		.map((candidate) => candidate.targetRef);
	return ok({
		policyId: pref.policyId,
		mode: pref.mode,
		taskClass: classification.taskClass,
		targetRef: selected.targetRef,
		targetId: parsedRef.value.targetId,
		modelId: parsedRef.value.modelId,
		fallbackTargetRefs,
		trace,
	});
}
