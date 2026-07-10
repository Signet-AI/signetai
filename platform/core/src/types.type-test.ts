import type { LlmGenerateOptions } from "./types";

const controller = new AbortController();
const structuredExtractionOptions = {
	timeoutMs: 60_000,
	maxTokens: 2_048,
	temperature: 0,
	signal: controller.signal,
	responseFormat: "json",
	think: false,
} satisfies LlmGenerateOptions;

void structuredExtractionOptions;
