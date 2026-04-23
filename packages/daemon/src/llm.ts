/**
 * Daemon-wide inference provider access.
 *
 * The daemon has one LLM abstraction: the inference router. Legacy helper
 * names remain as narrow compatibility shims, but they all delegate to the
 * router-backed workload resolver.
 */

import type { LlmProvider } from "@signet/core";

export type InferenceWorkload =
	| "default"
	| "memoryExtraction"
	| "sessionSynthesis"
	| "interactive"
	| "widgetGeneration"
	| "repair";

type InferenceProviderResolver = (workload: InferenceWorkload) => LlmProvider;

let resolver: InferenceProviderResolver | null = null;

export function initInferenceProviderResolver(next: InferenceProviderResolver): void {
	resolver = next;
}

export function closeInferenceProviderResolver(): void {
	resolver = null;
}

export function getInferenceProvider(workload: InferenceWorkload = "default"): LlmProvider {
	if (!resolver) {
		throw new Error("Inference provider resolver not initialised — call initInferenceProviderResolver() first");
	}
	return resolver(workload);
}

export function getInferenceProviderOrNull(workload: InferenceWorkload = "default"): LlmProvider | null {
	try {
		return getInferenceProvider(workload);
	} catch {
		return null;
	}
}

export function initLlmProvider(_instance: LlmProvider): void {
	throw new Error("initLlmProvider is obsolete — configure inference workloads instead");
}

export function getLlmProvider(): LlmProvider {
	return getInferenceProvider("memoryExtraction");
}

export function closeLlmProvider(): void {}

export function initSynthesisProvider(_instance: LlmProvider): void {
	throw new Error("initSynthesisProvider is obsolete — configure inference workloads instead");
}

export function getSynthesisProvider(): LlmProvider {
	return getInferenceProvider("sessionSynthesis");
}

export function closeSynthesisProvider(): void {}

export function initWidgetProvider(_instance: LlmProvider): void {
	throw new Error("initWidgetProvider is obsolete — configure inference workloads instead");
}

export function getWidgetProvider(): LlmProvider {
	return getInferenceProvider("widgetGeneration");
}

export function closeWidgetProvider(): void {}

export function getInteractiveLlmProvider(): LlmProvider {
	return getInferenceProvider("interactive");
}

export function getInteractiveLlmProviderOrNull(): LlmProvider | null {
	return getInferenceProviderOrNull("interactive");
}
