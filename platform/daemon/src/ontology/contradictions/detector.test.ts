import { describe, expect, it } from "bun:test";
import { detectSemanticContradiction } from "./detector";
import type { LlmProvider } from "../../inference/router/provider";

function mockProvider(raw: string): LlmProvider {
	return {
		name: "mock",
		async available() {
			return true;
		},
		async generate() {
			return raw;
		},
	};
}

describe("detectSemanticContradiction", () => {
	it("parses JSON wrapped in explanatory prose", async () => {
		const provider = mockProvider(
			'We should compare these carefully.\n{"contradicts": true, "confidence": 0.91, "reasoning": "Default theme changed from dark to light."}\nThis is my final answer.',
		);

		const result = await detectSemanticContradiction(
			"Dark mode is enabled by default",
			"Light mode is the default theme",
			provider,
		);

		expect(result.detected).toBe(true);
		expect(result.confidence).toBe(0.91);
		expect(result.reasoning).toContain("theme");
	});

	it("parses fenced JSON with trailing commas", async () => {
		const provider = mockProvider(`\`\`\`json
{
  "contradicts": false,
  "confidence": 0.8,
  "reasoning": "These statements are complementary.",
}
\`\`\``);

		const result = await detectSemanticContradiction("The API uses REST", "The API endpoint returns JSON", provider);

		expect(result.detected).toBe(false);
		expect(result.confidence).toBe(0.8);
	});

	it("prefers the final contradiction object over earlier examples", async () => {
		const provider = mockProvider(
			'Example: {"contradicts": false, "confidence": 0.2, "reasoning": "example"}\nFinal: {"contradicts": true, "confidence": 0.95, "reasoning": "actual answer"}',
		);

		const result = await detectSemanticContradiction(
			"Dark mode is enabled by default",
			"Light mode is the default theme",
			provider,
		);

		expect(result.detected).toBe(true);
		expect(result.confidence).toBe(0.95);
		expect(result.reasoning).toContain("actual answer");
	});
});
