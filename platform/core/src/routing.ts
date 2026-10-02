import type { InferenceLocality, LlmTelemetryAttribution } from "./types";
import {
	allTargetRefs,
	err,
	inferTargetPrivacy,
	isLocalInferenceEndpoint,
	ok,
	parseRoutingTargetRef,
	ROUTING_CLASSIFIER_TASK_CLASSES,
	ROUTING_OPERATION_KINDS,
} from "./routing-config";
import type {
	RouteCandidateTrace,
	RouteClassification,
	RouteDecision,
	RouteRequest,
	RouteTrace,
	RouterError,
	RouterResult,
	RoutingAccountConfig,
	RoutingConfig,
	RoutingCostTier,
	RoutingModelConfig,
	RoutingOperationKind,
	RoutingPolicyConfig,
	RoutingPolicyMode,
	RoutingPrivacyTier,
	RoutingReasoningDepth,
	RoutingRuntimeSnapshot,
	RoutingRuntimeState,
	RoutingTargetConfig,
	RoutingWorkloadBinding,
} from "./routing-config";

export {
	ROUTING_ACCOUNT_KINDS,
	ROUTING_TARGET_KINDS,
	ROUTING_EXECUTOR_KINDS,
	ROUTING_POLICY_MODES,
	ROUTING_PRIVACY_TIERS,
	ROUTING_REASONING_DEPTHS,
	ROUTING_COST_TIERS,
	ROUTING_OPERATION_KINDS,
	ROUTING_CLASSIFIER_TASK_CLASSES,
	resolveAcpxModelSelection,
	isLocalInferenceEndpoint,
	makeRoutingTargetRef,
	parseRoutingTargetRef,
	validateRoutingReferences,
	parseRoutingConfig,
	allTargetRefs,
} from "./routing-config";
export type * from "./routing-config";

const UNKNOWN_ACPX_PROVIDER = "unknown";
const REMOTE_ACPX_PROVIDERS = {
	claude: "claude",
	"claude-code": "claude",
	codex: "codex",
	gemini: "gemini",
} as const;

function acpxTelemetryProvider(agent?: string): string {
	const normalized = agent?.trim().toLowerCase();
	return (
		(normalized && REMOTE_ACPX_PROVIDERS[normalized as keyof typeof REMOTE_ACPX_PROVIDERS]) ?? UNKNOWN_ACPX_PROVIDER
	);
}
export function routingTargetLocality(
	target: Pick<RoutingTargetConfig, "executor" | "endpoint" | "privacy" | "acpx">,
): InferenceLocality {
	if (target.executor === "ollama" || target.executor === "llama-cpp") return "local";
	if (target.executor === "openai-compatible") {
		return isLocalInferenceEndpoint(target.endpoint) ? "local" : "remote";
	}
	if (target.executor === "acpx") {
		if (acpxTelemetryProvider(target.acpx?.agent) !== UNKNOWN_ACPX_PROVIDER) return "remote";
	}
	if (target.executor === "anthropic" || target.executor === "openrouter") return "remote";
	if (target.privacy === "local_only") return "local";
	if (target.executor === "acpx") return "unknown";
	return "unknown";
}
export function routingTelemetryAttribution(
	target: Pick<RoutingTargetConfig, "executor" | "endpoint" | "privacy" | "acpx">,
	model: Pick<RoutingModelConfig, "model">,
	account?: Pick<RoutingAccountConfig, "providerFamily">,
): LlmTelemetryAttribution {
	const executor = target.executor.trim().toLowerCase();
	const provider =
		executor === "acpx"
			? acpxTelemetryProvider(target.acpx?.agent)
			: (account?.providerFamily ?? target.executor).trim().toLowerCase();
	return {
		executor,
		...(provider ? { provider } : {}),
		model: model.model,
		locality: routingTargetLocality(target),
	};
}

function mergeUnique(...groups: readonly (readonly string[])[]): readonly string[] {
	const seen = new Set<string>();
	const merged: string[] = [];
	for (const group of groups) {
		for (const value of group) {
			if (seen.has(value)) continue;
			seen.add(value);
			merged.push(value);
		}
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
			return config.workloads?.interactive ?? config.workloads?.default;
		case "memory_extraction":
			return config.workloads?.memoryExtraction ?? config.workloads?.default;
		case "session_synthesis":
			return config.workloads?.memoryExtraction ?? config.workloads?.default;
		case "aggregate_recall":
			return config.workloads?.aggregateRecall ?? config.workloads?.memoryExtraction ?? config.workloads?.default;
		case "repair":
			return config.workloads?.repair ?? config.workloads?.memoryExtraction ?? config.workloads?.default;
	}
}

function routeClassification(
	taskClass: string,
	source: RouteClassification["source"],
	signals: readonly string[],
	reasoning: RoutingReasoningDepth = "medium",
): RouteClassification {
	return { taskClass, reasoning, source, signals };
}

function classifyRouteRequest(config: RoutingConfig, request: RouteRequest): RouteClassification {
	const workload = workloadBindingForOperation(config, request.operation);
	const workloadTaskClass = workload?.taskClass;
	if (request.taskClass && config.taskClasses[request.taskClass]) {
		return routeClassification(
			request.taskClass,
			"request",
			["taskClass=request"],
			config.taskClasses[request.taskClass]?.reasoning ?? "medium",
		);
	}
	if (workloadTaskClass && config.taskClasses[workloadTaskClass]) {
		return routeClassification(
			workloadTaskClass,
			"workload",
			[`taskClass=workload:${request.operation}`],
			config.taskClasses[workloadTaskClass]?.reasoning ?? "medium",
		);
	}

	const preview = (request.promptPreview ?? "").toLowerCase();
	const keywordMatches = Object.entries(config.taskClasses)
		.filter(([, taskClass]) => taskClass.keywords?.some((keyword) => preview.includes(keyword.toLowerCase())))
		.map(([taskClass]) => taskClass);
	if (keywordMatches.length > 0) {
		const taskClass = keywordMatches[0];
		return routeClassification(
			taskClass,
			"classifier",
			keywordMatches.map((value) => `keyword:${value}`),
			config.taskClasses[taskClass]?.reasoning ?? "medium",
		);
	}

	if (
		request.operation === "code_reasoning" ||
		/\b(function|typescript|javascript|stack trace|traceback|error:|tsx|rust|python|bun)\b/.test(preview)
	) {
		return routeClassification(
			ROUTING_CLASSIFIER_TASK_CLASSES.codeReasoning,
			"classifier",
			["prompt=code-like"],
			"high",
		);
	}
	if (request.privacy === "local_only") {
		return routeClassification(ROUTING_CLASSIFIER_TASK_CLASSES.localSensitive, "classifier", ["privacy=local_only"]);
	}

	const fallbackTaskClass =
		request.operation === "memory_extraction"
			? "memory_extraction"
			: request.operation === "session_synthesis"
				? "session_synthesis"
				: "interactive";
	return routeClassification(
		fallbackTaskClass,
		"default",
		["fallback=default"],
		config.taskClasses[fallbackTaskClass]?.reasoning ?? "medium",
	);
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
			message: `Routing policy "${policyId}" was not found.`,
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
	const workloadTargets = workload?.target
		? [workload.target]
		: mergeUnique(
				config.taskClasses[classification.taskClass]?.preferredTargets ?? [],
				policy.taskTargets?.[classification.taskClass] ?? [],
				policy.defaultTargets ?? [],
			);
	const orderedTargets = mergeUnique(
		explicitTargets,
		pinnedTarget ? [pinnedTarget] : [],
		agentConfig?.preferredTargets?.[classification.taskClass] ?? [],
		workloadTargets,
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

export function configuredRoutingTargetRefs(config: RoutingConfig): readonly string[] {
	let refs: readonly string[] = [];
	for (const operation of ROUTING_OPERATION_KINDS) {
		const request: RouteRequest = { operation };
		const classification = classifyRouteRequest(config, request);
		const preference = orderedPreferenceLists(config, request, classification);
		if ("code" in preference) continue;

		const policy = config.policies[preference.policyId];
		if (!policy) continue;
		const workload = workloadBindingForOperation(config, operation);
		const rosterTargets = workload?.target ? [] : targetRefsForRoster(config, request, classification, policy);
		refs = mergeUnique(refs, preference.orderedTargets, rosterTargets, preference.fallbackTargets);
	}
	return refs;
}

interface CandidateContext {
	readonly targetRef: string;
	readonly target: RoutingTargetConfig;
	readonly model: RoutingModelConfig;
	readonly runtime: RoutingRuntimeState;
	readonly request: RouteRequest;
	readonly classification: RouteClassification;
	readonly taskClass: RoutingConfig["taskClasses"][string] | undefined;
	readonly orderedTargets: readonly string[];
	readonly requiredPrivacy: RoutingPrivacyTier;
	readonly expectedInputTokens?: number;
	readonly requiredCost?: RoutingCostTier;
	readonly latencyBudget?: number;
	readonly estimatedLatency: number;
}

interface CandidateTraceProjection {
	readonly targetRef: string;
	readonly runtime: RoutingRuntimeState;
	readonly blockedBy: readonly string[];
	readonly reasons: readonly string[];
	readonly score: number;
}

function createCandidateContext(
	config: RoutingConfig,
	request: RouteRequest,
	classification: RouteClassification,
	targetRef: string,
	runtime: RoutingRuntimeState,
	policy: RoutingPolicyConfig,
	orderedTargets: readonly string[],
): CandidateContext | string {
	const ref = parseRoutingTargetRef(targetRef);
	if (ref.ok === false) return ref.error.message;
	const target = config.targets[ref.value.targetId];
	const model = target?.models[ref.value.modelId];
	if (!target || !model) return "target not found";

	const taskClass = config.taskClasses[classification.taskClass];
	return {
		targetRef,
		target,
		model,
		runtime,
		request,
		classification,
		taskClass,
		orderedTargets,
		requiredPrivacy: request.privacy ?? taskClass?.privacy ?? "remote_ok",
		expectedInputTokens: request.expectedInputTokens ?? taskClass?.expectedInputTokens,
		requiredCost: request.costCeiling ?? taskClass?.costCeiling ?? policy.costCeiling,
		latencyBudget: request.latencyBudgetMs ?? taskClass?.maxLatencyMs ?? policy.maxLatencyMs,
		estimatedLatency: model.averageLatencyMs ?? defaultLatencyForTarget(target),
	};
}

function candidateBlockers(candidate: CandidateContext): string[] {
	const { target, model, runtime, request, taskClass, requiredPrivacy, expectedInputTokens } = candidate;
	const blockedBy: string[] = [];
	const targetPrivacy = target.privacy ?? inferTargetPrivacy(target.executor, target.endpoint);
	if (privacyRank(targetPrivacy) < privacyRank(requiredPrivacy)) {
		blockedBy.push(`privacy gate (${requiredPrivacy})`);
	}
	if (requiredPrivacy === "local_only" && target.kind !== "local") {
		blockedBy.push("local_only request requires local executor");
	}
	if ((request.requireTools ?? taskClass?.toolsRequired) && model.toolUse === false) {
		blockedBy.push("tool-use required");
	}
	if ((request.requireStreaming ?? taskClass?.streamingPreferred) && model.streaming !== true) {
		blockedBy.push("streaming required");
	}
	if ((request.requireMultimodal ?? taskClass?.multimodalRequired) && model.multimodal !== true) {
		blockedBy.push("multimodal required");
	}
	if (expectedInputTokens && model.contextWindow && expectedInputTokens > model.contextWindow) {
		blockedBy.push(`context window too small (${model.contextWindow})`);
	}
	if (!runtime.available || runtime.circuitOpen || runtime.health === "blocked") {
		blockedBy.push(runtime.unavailableReason ?? "executor unavailable");
	}
	if (["missing", "expired", "rate_limited"].includes(runtime.accountState)) {
		blockedBy.push(`account state ${runtime.accountState}`);
	}
	if (candidate.requiredCost && model.costTier && costRank(model.costTier) > costRank(candidate.requiredCost)) {
		blockedBy.push(`cost tier ${model.costTier} exceeds ${candidate.requiredCost}`);
	}
	if (candidate.latencyBudget && candidate.estimatedLatency > candidate.latencyBudget * 2) {
		blockedBy.push(`estimated latency ${candidate.estimatedLatency}ms exceeds budget ${candidate.latencyBudget}ms`);
	}
	return blockedBy;
}

function scoreCandidate(candidate: CandidateContext): { readonly score: number; readonly reasons: readonly string[] } {
	const {
		targetRef,
		target,
		model,
		runtime,
		classification,
		orderedTargets,
		latencyBudget,
		estimatedLatency,
		requiredCost,
	} = candidate;
	const reasons: string[] = [];
	let score = 0;
	const reasoning = model.reasoning ?? "medium";
	const reasoningDelta = reasoningRank(reasoning) - reasoningRank(classification.reasoning);
	const orderIndex = orderedTargets.indexOf(targetRef);
	if (orderIndex >= 0) {
		score += 100 - orderIndex * 5;
		reasons.push(`preferred order ${orderIndex + 1}`);
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
	return { score, reasons };
}

function projectCandidateTrace(trace: CandidateTraceProjection): RouteCandidateTrace {
	const allowed = trace.blockedBy.length === 0;
	return {
		targetRef: trace.targetRef,
		allowed,
		score: allowed ? trace.score : null,
		reasons: trace.reasons,
		blockedBy: trace.blockedBy,
		runtime: trace.runtime,
	};
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
	const candidate = createCandidateContext(config, request, classification, targetRef, runtime, policy, orderedTargets);
	if (typeof candidate === "string") {
		return projectCandidateTrace({ targetRef, runtime, blockedBy: [candidate], reasons: [], score: 0 });
	}
	const blockedBy = candidateBlockers(candidate);
	const { score, reasons } = scoreCandidate(candidate);
	return projectCandidateTrace({ targetRef, runtime, blockedBy, reasons, score });
}

function selectRouteCandidates(
	config: RoutingConfig,
	request: RouteRequest,
	candidates: readonly RouteCandidateTrace[],
	mode: RoutingPolicyMode,
): { readonly allowed: readonly RouteCandidateTrace[]; readonly selected: RouteCandidateTrace | undefined } {
	const allowed = candidates.filter((candidate) => {
		if (!candidate.allowed) return false;
		if (request.operation !== "aggregate_recall") return true;
		const parsed = parseRoutingTargetRef(candidate.targetRef);
		return !parsed.ok || config.targets[parsed.value.targetId]?.executor !== "acpx";
	});
	const selected =
		mode === "strict" ? allowed[0] : [...allowed].sort((left, right) => (right.score ?? 0) - (left.score ?? 0))[0];
	return { allowed, selected };
}

export function resolveRoutingDecision(
	config: RoutingConfig,
	request: RouteRequest,
	runtimeSnapshot: RoutingRuntimeSnapshot,
): RouterResult<RouteDecision> {
	if (!config.enabled) {
		return err("no-candidates", "Routing is not enabled for this agent config.");
	}
	const classification = classifyRouteRequest(config, request);
	const pref = orderedPreferenceLists(config, request, classification);
	if ("code" in pref) {
		return { ok: false, error: pref };
	}
	const policy = config.policies[pref.policyId];
	const workload = workloadBindingForOperation(config, request.operation);
	const rosterCandidates = workload?.target ? [] : targetRefsForRoster(config, request, classification, policy);
	const candidateRefs = mergeUnique(pref.orderedTargets, rosterCandidates, pref.fallbackTargets);
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
	const { allowed, selected } = selectRouteCandidates(config, request, traces, pref.mode);
	if (!selected) {
		const reason =
			request.operation === "aggregate_recall"
				? `All routing candidates for '${request.operation}' were blocked: this operation cannot use a subprocess (ACPX) executor — it requires a direct pi-ai provider for latency.`
				: "All routing candidates were blocked by policy or runtime state.";
		return err("no-candidates", reason, {
			trace,
		});
	}

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
