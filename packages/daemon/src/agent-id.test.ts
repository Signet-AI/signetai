import { describe, expect, it } from "bun:test";
import { resolveAgentId, resolveDaemonAgentId } from "./agent-id";

describe("agent id resolution", () => {
	it("resolves daemon agent id from SIGNET_AGENT_ID", () => {
		expect(resolveDaemonAgentId({ SIGNET_AGENT_ID: "agent-b" } as NodeJS.ProcessEnv)).toBe("agent-b");
	});

	it("falls back to default when daemon agent id is blank", () => {
		expect(resolveDaemonAgentId({ SIGNET_AGENT_ID: "  " } as NodeJS.ProcessEnv)).toBe("default");
	});

	it("resolves agent id from agent-scoped session keys", () => {
		expect(resolveAgentId({ sessionKey: "agent:agent-b:session-1" })).toBe("agent-b");
	});
});
