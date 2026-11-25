import { describe, expect, it } from "bun:test";
import { isNoiseSession, isTempProject } from "./noise";

describe("session-noise", () => {
	it("flags temp projects as projection noise", () => {
		expect(isTempProject("/tmp/signetai")).toBe(true);
		expect(isTempProject("/private/tmp/run-123")).toBe(true);
		expect(isTempProject("/home/nicholai/signet/signetai")).toBe(false);
	});

	it("flags synthetic identifiers only when no stable project is present", () => {
		expect(isNoiseSession({ project: null, sessionKey: "test-session-1", harness: "codex" })).toBe(true);
		expect(isNoiseSession({ project: null, sessionId: "fixture-42", harness: "codex" })).toBe(true);
		expect(
			isNoiseSession({
				project: "/home/nicholai/signet/signetai",
				sessionKey: "test-session-1",
				harness: "codex",
			}),
		).toBe(false);
	});
});
