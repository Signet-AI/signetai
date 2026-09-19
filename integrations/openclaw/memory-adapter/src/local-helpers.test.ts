import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "bun:test";
import {
	buildRecallRequestBody,
	buildRememberRequestBody,
	formatRecallText,
	stripInternalMemoryContext,
	wrapMemoryContext,
} from "./local-helpers.js";

const root = join(import.meta.dir, "..");
it("keeps the production boundary local and SDK-only", () => {
	const source = readFileSync(join(root, "src/index.ts"), "utf8");
	const packageJson = readFileSync(join(root, "package.json"), "utf8");
	expect(source).not.toContain("@signet/core");
	expect(packageJson).not.toContain("@signet/core");
	expect(source).toContain("@signet/sdk");
});
it("preserves request shaping and context safety", () => {
	expect(buildRecallRequestBody("q", { limit: 5000, agentId: "a" })).toEqual({
		query: "q",
		limit: 100,
		agentId: "a",
		recallSurface: "tool_call",
	});
	expect(buildRememberRequestBody("x", { tags: [" a ", "", "b"], who: "openclaw" })).toEqual({
		content: "x",
		tags: "a,b",
		who: "openclaw",
	});
	expect(stripInternalMemoryContext("before<signet-memory>hidden</signet-memory>after")).toBe("beforeafter");
	expect(wrapMemoryContext("context", "bad source")).toContain('source="bad-source"');
	expect(
		formatRecallText({ results: [{ content: "remembered", source: "test" }], meta: { totalReturned: 1 } }),
	).toContain("remembered");
});
