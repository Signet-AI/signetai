import { describe, expect, it } from "bun:test";
import { parseRoutingConfig, resolveRoutingDecision } from "@signet/core";
import { ensureInferenceRoute } from "./inference-route-config";

describe("ensureInferenceRoute", () => {
	it("creates an explicit policy, workload bindings, and extraction task class", () => {
		const agent: Record<string, unknown> = {
			inference: {
				targets: {
					background: { executor: "llama-cpp", models: { default: { model: "gemma" } } },
					aggregation: { executor: "llama-cpp", models: { default: { model: "qwen" } } },
				},
			},
		};

		ensureInferenceRoute(agent);

		expect(agent.inference).toEqual({
			targets: {
				background: { executor: "llama-cpp", models: { default: { model: "gemma" } } },
				aggregation: { executor: "llama-cpp", models: { default: { model: "qwen" } } },
			},
			workloads: {
				memoryExtraction: { target: "background/default", taskClass: "memory_extraction" },
				aggregateRecall: { target: "aggregation/default" },
			},
			taskClasses: {
				memory_extraction: { reasoning: "medium" },
			},
			defaultPolicy: "default",
			policies: {
				default: {
					mode: "automatic",
					defaultTargets: ["background/default"],
					fallbackTargets: ["background/default"],
				},
			},
		});
	});

	it("routes generated memory extraction config through a dashboard target", () => {
		const agent: Record<string, unknown> = {
			inference: {
				targets: { background: { executor: "llama-cpp", models: { default: { model: "gemma" } } } },
			},
		};

		ensureInferenceRoute(agent);
		const parsed = parseRoutingConfig(agent);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;

		const decision = resolveRoutingDecision(
			parsed.value,
			{ operation: "memory_extraction" },
			{
				targets: {
					"background/default": {
						available: true,
						health: "healthy",
						circuitOpen: false,
						accountState: "ready",
					},
				},
			},
		);
		expect(decision.ok).toBe(true);
		if (decision.ok) expect(decision.value.targetRef).toBe("background/default");
	});

	it("keeps the generated policy scoped to primary when aggregation is added later", () => {
		const agent: Record<string, unknown> = {
			inference: {
				targets: { background: { models: { default: { model: "gemma" } } } },
			},
		};

		ensureInferenceRoute(agent);
		(agent.inference as Record<string, unknown>).targets = {
			background: { models: { default: { model: "gemma" } } },
			aggregation: { models: { default: { model: "qwen" } } },
		};
		ensureInferenceRoute(agent);

		const policy = ((agent.inference as Record<string, unknown>).policies as Record<string, unknown>).default as Record<
			string,
			unknown
		>;
		expect(policy.defaultTargets).toEqual(["background/default"]);
		expect(policy.fallbackTargets).toEqual(["background/default"]);
	});

	it("does not promote aggregation into the generic default route", () => {
		const agent: Record<string, unknown> = {
			inference: {
				targets: { aggregation: { models: { default: { model: "qwen" } } } },
			},
		};

		ensureInferenceRoute(agent);

		const inference = agent.inference as Record<string, unknown>;
		expect(inference.defaultPolicy).toBe("default");
		expect((inference.policies as Record<string, unknown>).default).toEqual({
			mode: "automatic",
			defaultTargets: [],
			fallbackTargets: [],
		});
		expect(inference.workloads).toEqual({ aggregateRecall: { target: "aggregation/default" } });
	});

	it("repairs a named missing default policy without replacing custom task classes", () => {
		const customTaskClass = { reasoning: "high", privacy: "local_only" };
		const agent: Record<string, unknown> = {
			inference: {
				defaultPolicy: "local-llama",
				policies: {},
				taskClasses: { memory_extraction: customTaskClass },
				targets: { background: { models: { default: { model: "gemma" } } } },
			},
		};

		ensureInferenceRoute(agent);

		const inference = agent.inference as Record<string, unknown>;
		expect(inference.defaultPolicy).toBe("local-llama");
		expect((inference.policies as Record<string, unknown>)["local-llama"]).toEqual({
			mode: "automatic",
			defaultTargets: ["background/default"],
			fallbackTargets: ["background/default"],
		});
		expect((inference.taskClasses as Record<string, unknown>).memory_extraction).toBe(customTaskClass);
	});

	it("does not invent a route before a target has a model", () => {
		const agent: Record<string, unknown> = { inference: { targets: { background: { executor: "llama-cpp" } } } };

		ensureInferenceRoute(agent);

		expect(agent.inference).toEqual({ targets: { background: { executor: "llama-cpp" } } });
	});

	it("preserves an explicit workload pin when the dashboard target is complete", () => {
		const agent: Record<string, unknown> = {
			inference: {
				targets: { background: { executor: "llama-cpp", models: { default: { model: "gemma" } } } },
				workloads: { memoryExtraction: { target: "background/gemma", taskClass: "memory_extraction" } },
			},
		};

		ensureInferenceRoute(agent);

		const workloads = (agent.inference as Record<string, unknown>).workloads as Record<string, unknown>;
		expect(workloads.memoryExtraction).toEqual({ target: "background/gemma", taskClass: "memory_extraction" });
	});

	it("does not pin default policy to arbitrary existing policy order", () => {
		const agent: Record<string, unknown> = {
			inference: {
				targets: { background: { executor: "llama-cpp", models: { default: { model: "gemma" } } } },
				policies: { privacy: { mode: "strict", defaultTargets: ["background/default"] } },
			},
		};

		ensureInferenceRoute(agent);

		expect((agent.inference as Record<string, unknown>).defaultPolicy).toBeUndefined();
	});

	it("preserves a custom workload binding when the dashboard target is incomplete", () => {
		const agent: Record<string, unknown> = {
			inference: {
				targets: { background: { executor: "llama-cpp" } },
				workloads: { memoryExtraction: { target: "remote/default", taskClass: "memory_extraction" } },
			},
		};

		ensureInferenceRoute(agent);

		expect((agent.inference as Record<string, unknown>).workloads).toEqual({
			memoryExtraction: { target: "remote/default", taskClass: "memory_extraction" },
		});
	});
});
