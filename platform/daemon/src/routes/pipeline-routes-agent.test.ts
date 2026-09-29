import { afterEach, describe, expect, it } from "bun:test";
import type { Context } from "hono";
import { getDreamingTriggerBlockReason, resolveDreamRequestAgentId } from "./pipeline-routes";

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

describe("dream trigger admission", () => {
	it("rejects triggers during pipeline transitions", () => {
		expect(getDreamingTriggerBlockReason(true, false, false)).toEqual({
			status: 409,
			error: "Pipeline transition already in progress",
		});
	});

	it("rejects triggers while paused or mutations are frozen", () => {
		expect(getDreamingTriggerBlockReason(false, true, false)).toEqual({ status: 503, error: "Pipeline is paused" });
		expect(getDreamingTriggerBlockReason(false, false, true)).toEqual({
			status: 503,
			error: "Mutations are frozen (kill switch active)",
		});
	});

	it("allows explicit triggers when automatic Dreaming is disabled", () => {
		expect(getDreamingTriggerBlockReason(false, false, false)).toBeNull();
	});
});

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
