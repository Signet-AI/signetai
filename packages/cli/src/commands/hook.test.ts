import { describe, expect, test } from "bun:test";
import { buildSessionEndBody, pickSessionKey } from "./hook";

describe("pickSessionKey", () => {
	test("prefers canonical sessionKey fields before legacy session_id aliases", () => {
		expect(
			pickSessionKey({
				session_key: "sess-kebab",
				sessionKey: "sess-camel",
				session_id: "sess-snake-id",
				sessionId: "sess-camel-id",
			}),
		).toBe("sess-kebab");
	});

	test("falls back through legacy aliases when canonical keys are absent", () => {
		expect(
			pickSessionKey({
				sessionId: "sess-camel-id",
			}),
		).toBe("sess-camel-id");
	});
});

describe("buildSessionEndBody", () => {
	test("forwards inline transcript capture for session-end hooks", () => {
		expect(
			buildSessionEndBody(
				{
					sessionKey: "sess-1",
					transcript: "user: hi\nassistant: hello",
					transcriptPath: "/tmp/session.txt",
					cwd: "/tmp/project",
					reason: "shutdown",
				},
				"claude-code",
			),
		).toEqual({
			harness: "claude-code",
			transcriptPath: "/tmp/session.txt",
			transcript: "user: hi\nassistant: hello",
			sessionId: "sess-1",
			sessionKey: "sess-1",
			cwd: "/tmp/project",
			reason: "shutdown",
		});
	});
});
