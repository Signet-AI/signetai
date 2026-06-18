import { describe, expect, test } from "bun:test";
import {
	formatDaemonUptime,
	humanizeConfigKey,
	normalizeSecretNameInput,
	sourceHasChunkCoverageWarning,
	summarizeOntologyText,
	validateSecretName,
} from "./issue-848-format";

describe("issue #848 dashboard formatting helpers", () => {
	test("formats daemon uptime from seconds rather than agent age", () => {
		expect(formatDaemonUptime(128.87)).toBe("2M");
		expect(formatDaemonUptime(880)).toBe("14M");
		expect(formatDaemonUptime(86_400)).toBe("1 DAY");
		expect(formatDaemonUptime(null)).toBe("--");
	});

	test("humanizes camelCase pipeline keys", () => {
		expect(humanizeConfigKey("graphEnabled")).toBe("Graph Enabled");
		expect(humanizeConfigKey("rerankerEnabled")).toBe("Reranker Enabled");
		expect(humanizeConfigKey("semanticContradictionTimeoutMs")).toBe("Semantic Contradiction Timeout MS");
	});

	test("normalizes and validates secret names", () => {
		expect(normalizeSecretNameInput("openai api-key")).toBe("openai_api_key");
		expect(validateSecretName("OPENAI_API_KEY")).toBeNull();
		expect(validateSecretName("npm_token")).toBeNull();
		expect(validateSecretName("_TOKEN")).toBeNull();
		expect(validateSecretName("A")).toBeNull();
		expect(validateSecretName("1_BAD")).toContain("start with a letter");
	});

	test("summarizes raw agent XML-like ontology blobs", () => {
		expect(summarizeOntologyText("<agent><content>Keep this concrete fact</content></agent>")).toBe(
			"Keep this concrete fact",
		);
		expect(summarizeOntologyText("x".repeat(230))).toHaveLength(220);
	});

	test("flags indexed sources with no chunks", () => {
		expect(sourceHasChunkCoverageWarning({ artifacts: 500, indexed: 500, chunks: 0 })).toBe(true);
		expect(sourceHasChunkCoverageWarning({ artifacts: 500, indexed: 500, chunks: 12 })).toBe(false);
	});
});
