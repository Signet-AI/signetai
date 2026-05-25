import { afterEach, describe, expect, it } from "bun:test";
import type { Context } from "hono";
import { resolveDreamRequestAgentId } from "./pipeline-routes";

const originalAgentId = process.env.SIGNET_AGENT_ID;

function makeContext(query: Record<string, string | undefined>, headers: Record<string, string | undefined>): Context {
	return {
		req: {
			query(key: string) {
				return query[key];
			},
			header(key: string) {
				return headers[key];
			},
		},
	} as unknown as Context;
}

describe("dream route agent resolution", () => {
	afterEach(() => {
		if (originalAgentId === undefined) {
			Reflect.deleteProperty(process.env, "SIGNET_AGENT_ID");
		} else {
			process.env.SIGNET_AGENT_ID = originalAgentId;
		}
	});

	it("prefers JSON agentId over query, header, and daemon fallback", () => {
		process.env.SIGNET_AGENT_ID = "daemon-agent";
		const c = makeContext({ agent_id: "query-agent" }, { "x-signet-agent-id": "header-agent" });

		expect(resolveDreamRequestAgentId(c, { agentId: "body-agent" })).toBe("body-agent");
	});

	it("accepts snake_case query and falls back to the daemon agent", () => {
		process.env.SIGNET_AGENT_ID = "daemon-agent";

		expect(resolveDreamRequestAgentId(makeContext({ agent_id: "query-agent" }, {}))).toBe("query-agent");
		expect(resolveDreamRequestAgentId(makeContext({}, {}))).toBe("daemon-agent");
	});
});
