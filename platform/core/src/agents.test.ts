import { describe, expect, test } from "bun:test";
import { resolveAgentMemoryPolicy } from "./agents";

describe("resolveAgentMemoryPolicy", () => {
	test.each([
		["isolated", undefined, "agent"],
		["shared", undefined, "global"],
		["group", "writers", "group"],
	] as const)("accepts %s policy", (readPolicy, policyGroup, effectiveScope) => {
		expect(resolveAgentMemoryPolicy(readPolicy, policyGroup)).toMatchObject({
			readPolicy,
			policyGroup: policyGroup ?? null,
			effectiveScope,
		});
	});

	test.each([
		[undefined, undefined],
		["unknown", undefined],
		[123, undefined],
		["group", undefined],
		["isolated", "extra"],
		["shared", 123],
	])("rejects invalid policy combinations", (readPolicy, policyGroup) => {
		expect(() => resolveAgentMemoryPolicy(readPolicy, policyGroup)).toThrow();
	});
});
