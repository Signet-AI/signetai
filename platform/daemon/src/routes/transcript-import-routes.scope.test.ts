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
	it("allows a requested agent in local mode", () => {
		expect(resolveTranscriptImportAgent(null, "local", "agent-b", "default")).toBe("agent-b");
	});

	it("keeps team requests inside the token agent scope", () => {
		expect(resolveTranscriptImportAgent(claims("agent-a"), "team", "agent-b", "default")).toBeNull();
		expect(resolveTranscriptImportAgent(claims("agent-a"), "team", undefined, "default")).toBe("agent-a");
	});
});
