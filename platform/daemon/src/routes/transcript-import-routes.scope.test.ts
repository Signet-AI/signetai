import { describe, expect, it } from "bun:test";
import type { TokenClaims } from "../auth";
import { resolveTranscriptImportAgent } from "./transcript-import-routes";

function claims(agent: string): TokenClaims {
	const now = Math.floor(Date.now() / 1000);
	return {
		sub: "operator",
		role: "operator",
		scope: { agent },
		iat: now,
		exp: now + 300,
	};
}

describe("transcript import agent scope", () => {
	it("rejects a conflicting unauthenticated local agent while accepting the daemon agent", () => {
		expect(resolveTranscriptImportAgent(null, "local", "agent-b", "default")).toBeNull();
		expect(resolveTranscriptImportAgent(null, "local", "default", "default")).toBe("default");
		expect(resolveTranscriptImportAgent(null, "local", undefined, "default")).toBe("default");
	});

	it("accepts the authenticated agent and rejects conflicting aliases", () => {
		expect(resolveTranscriptImportAgent(claims("agent-a"), "team", undefined, "default")).toBe("agent-a");
		expect(resolveTranscriptImportAgent(claims("agent-a"), "team", "agent-b", "default")).toBeNull();
	});

	it("keeps team requests inside the token agent scope", () => {
		expect(resolveTranscriptImportAgent(claims("agent-a"), "team", "agent-b", "default")).toBeNull();
		expect(resolveTranscriptImportAgent(claims("agent-a"), "team", undefined, "default")).toBe("agent-a");
	});
});
