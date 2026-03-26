import { describe, expect, it } from "bun:test";
import { resolveScopedAgent, resolveScopedProject, shouldEnforceScope } from "./request-scope";

describe("request scope helpers", () => {
	it("skips enforcement in local mode", () => {
		expect(shouldEnforceScope("local", null)).toBe(false);
		expect(resolveScopedAgent(null, "local", "agent-b").agentId).toBe("agent-b");
	});

	it("skips enforcement in hybrid mode without claims", () => {
		expect(shouldEnforceScope("hybrid", null)).toBe(false);
		expect(resolveScopedProject(null, "hybrid", "proj-a").project).toBe("proj-a");
	});

	it("rejects agent scope mismatches in team mode", () => {
		const result = resolveScopedAgent(
			{
				sub: "operator",
				role: "operator",
				scope: { agent: "agent-a" },
				exp: Math.floor(Date.now() / 1000) + 300,
			},
			"team",
			"agent-b",
		);

		expect(result.error).toContain("agent 'agent-a'");
	});

	it("applies scoped project when request omits one", () => {
		const result = resolveScopedProject(
			{
				sub: "operator",
				role: "operator",
				scope: { project: "proj-a" },
				exp: Math.floor(Date.now() / 1000) + 300,
			},
			"team",
			undefined,
		);

		expect(result.project).toBe("proj-a");
		expect(result.error).toBeUndefined();
	});

	it("rejects project scope mismatches in team mode", () => {
		const result = resolveScopedProject(
			{
				sub: "operator",
				role: "operator",
				scope: { project: "proj-a" },
				exp: Math.floor(Date.now() / 1000) + 300,
			},
			"team",
			"proj-b",
		);

		expect(result.error).toContain("project 'proj-a'");
	});
});
