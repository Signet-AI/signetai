/**
 * Synthesis-specific LlmProvider singleton.
 *
 * Separate from the extraction provider because synthesis needs a
 * smarter model that can reason across long context, whereas extraction
 * uses tiny local models for simple tagging work.
 */

import { logger } from "./logger";
import type { LlmProvider } from "./pipeline/provider";

let provider: LlmProvider | null = null;

export function initSynthesisProvider(instance: LlmProvider): void {
	if (provider) {
		logger.warn("synthesis", "Synthesis provider already initialised, skipping");
		return;
	}
	provider = instance;
}

export function getSynthesisProvider(): LlmProvider {
	if (!provider) {
		throw new Error("Synthesis LlmProvider not initialised — call initSynthesisProvider() first");
	}
	return provider;
}

export function closeSynthesisProvider(): void {
	provider = null;
}
