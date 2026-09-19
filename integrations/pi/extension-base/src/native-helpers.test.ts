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
	it("scrubs memory fences and escapes injected content", () => {
		expect(stripInternalMemoryContext("a <signet-memory>secret</signet-memory> b")).toBe("a  b");
		expect(escapeMemoryContextForFence("<signet-memory>x</signet-memory>")).toContain("&lt;");
	});
});
