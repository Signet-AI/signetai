import { describe, expect, test } from "bun:test";
import { pickSessionKey } from "./hook";

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
