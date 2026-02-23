/**
 * Daemon-wide LlmProvider singleton.
 *
 * Follows the DbAccessor pattern: init once in main(), get from
 * anywhere, close on shutdown. Lower-level functions (extraction,
 * decision, worker) keep their provider parameter so tests can
 * inject mocks without touching global state.
 */

import type { LlmProvider } from "./pipeline/provider";
import { logger } from "./logger";

let provider: LlmProvider | null = null;

export function initLlmProvider(instance: LlmProvider): void {
	if (provider) {
		logger.warn("llm", "Provider already initialised, skipping");
		return;
	}
	provider = instance;
}

export function getLlmProvider(): LlmProvider {
	if (!provider) {
		throw new Error(
			"LlmProvider not initialised — call initLlmProvider() first",
		);
	}
	return provider;
}

export function closeLlmProvider(): void {
	provider = null;
}
