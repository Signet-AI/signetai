type ConfigRecord = Record<string, unknown>;

function record(value: unknown): ConfigRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as ConfigRecord) : {};
}

function targetRef(targetId: string, target: unknown): string | undefined {
	const models = record(record(target).models);
	const modelId = Object.keys(models)[0];
	return modelId ? `${targetId}/${modelId}` : undefined;
}

/**
 * Make the dashboard's two model assignments a complete canonical route.
 * Existing policies and task classes remain authoritative. Generated values
 * only fill missing routing structure so advanced configurations are not
 * rewritten by a simple provider change.
 */
export function ensureInferenceRoute(agent: ConfigRecord): void {
	const inference = record(agent.inference);
	const targets = record(inference.targets);
	const workloads = record(inference.workloads);
	const taskClasses = record(inference.taskClasses);
	const policies = record(inference.policies);
	const backgroundRef = targetRef("background", targets.background);
	const aggregationRef = targetRef("aggregation", targets.aggregation);

	if (backgroundRef) {
		const existing = record(workloads.memoryExtraction);
		const existingTarget = typeof existing.target === "string" ? existing.target : undefined;
		workloads.memoryExtraction = {
			...existing,
			target: existingTarget ?? backgroundRef,
			taskClass:
				typeof existing.taskClass === "string" && existing.taskClass.length > 0
					? existing.taskClass
					: "memory_extraction",
		};
		if (taskClasses.memory_extraction == null) {
			taskClasses.memory_extraction = {
				reasoning: "medium",
			};
		}
	}

	if (aggregationRef) {
		const existing = record(workloads.aggregateRecall);
		const existingTarget = typeof existing.target === "string" ? existing.target : undefined;
		workloads.aggregateRecall = {
			...existing,
			target: existingTarget ?? aggregationRef,
		};
	}

	const refs = backgroundRef ? [backgroundRef] : [];
	if (backgroundRef || aggregationRef) {
		const configuredDefault =
			typeof inference.defaultPolicy === "string" && inference.defaultPolicy.length > 0
				? inference.defaultPolicy
				: undefined;
		const policyId = configuredDefault ?? (Object.keys(policies).length === 0 ? "default" : undefined);
		if (policyId != null) {
			if (policies[policyId] == null) {
				policies[policyId] = {
					mode: "automatic",
					defaultTargets: refs,
					fallbackTargets: refs,
				};
			}
			if (inference.defaultPolicy == null) inference.defaultPolicy = policyId;
		}
	}

	if (Object.keys(workloads).length > 0) inference.workloads = workloads;
	if (Object.keys(taskClasses).length > 0) inference.taskClasses = taskClasses;
	if (Object.keys(policies).length > 0) inference.policies = policies;
	if (Object.keys(targets).length > 0) inference.targets = targets;
	agent.inference = inference;
}
