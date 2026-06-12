import { describe, expect, test } from "bun:test";
import {
	buildSignetSystemPrompt,
	formatLastSeenShort,
	harnessSupportsNamedCrossAgentTools,
	sanitizePeerPromptField,
	serializeTraversalPath,
} from "./session-start-format";

describe("session start formatting helpers", () => {
	test("builds the Signet system prompt with memory tool guidance", () => {
		const prompt = buildSignetSystemPrompt();

		expect(prompt).toContain("[signet active]");
		expect(prompt).toContain("mcp__signet__memory_search");
		expect(prompt).toContain("Secrets are injected into subprocesses");
	});

	test("sanitizes peer prompt fields", () => {
		expect(sanitizePeerPromptField("agent`<#1>\n*name*")).toBe("agent 1 name");
	});

	test("detects named cross-agent tool support", () => {
		expect(harnessSupportsNamedCrossAgentTools(" codex ")).toBe(true);
		expect(harnessSupportsNamedCrossAgentTools("pi")).toBe(false);
	});

	test("serializes traversal paths with duplicate IDs removed", () => {
		expect(
			JSON.parse(
				serializeTraversalPath({
					entityIds: ["e1", "e1", "e2"],
					aspectIds: ["a1", "a1"],
					dependencyIds: ["d1", "d2", "d1"],
				}),
			),
		).toEqual({ entity_ids: ["e1", "e2"], aspect_ids: ["a1"], dependency_ids: ["d1", "d2"] });
	});

	test("formats invalid last-seen timestamps as unknown", () => {
		expect(formatLastSeenShort("not-a-date")).toBe("unknown");
	});
});
