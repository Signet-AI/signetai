import { describe, expect, it } from "bun:test";
import {
	buildRecallRequestBody,
	buildRememberRequestBody,
	escapeMemoryContextForFence,
	parseRecallPayload,
	stripInternalMemoryContext,
} from "./native-helpers.js";

describe("native connector helpers", () => {
	it("preserves daemon request fields without core imports", () => {
		expect(buildRecallRequestBody("hello", { agentId: "a", sessionKey: "s", recallSurface: "tool_call" })).toEqual({
			query: "hello",
			limit: 10,
			agentId: "a",
			sessionKey: "s",
			recallSurface: "tool_call",
		});
		expect(buildRememberRequestBody("memory", { harness: "pi", pinned: false })).toEqual({
			content: "memory",
			harness: "pi",
			pinned: false,
		});
	});
	it("parses and formats native daemon payloads", () => {
		const payload = parseRecallPayload({ results: [{ content: "remember this", source: "test" }] });
		expect(payload.results).toHaveLength(1);
	});
	it("scrubs adversarial malformed fences within a bounded time", () => {
		const adversarial = `${"<signet-memory>".repeat(9)}${"x".repeat(50_000)}${"</signet-memory>".repeat(9)}${"<signet-memory ".repeat(2_000)}${"x".repeat(50_000)}>${"</signet-memory ".repeat(2_000)}${"x".repeat(50_000)}>`;
		const started = performance.now();
		const result = stripInternalMemoryContext(adversarial);
		const elapsed = performance.now() - started;

		expect(result).toBe("");
		expect(elapsed).toBeLessThan(250);
	});

	it("scrubs memory fences and escapes injected content", () => {
		expect(stripInternalMemoryContext("a <signet-memory>secret</signet-memory> b")).toBe("a  b");
		expect(escapeMemoryContextForFence("<signet-memory>x</signet-memory>")).toContain("&lt;");
	});
});
