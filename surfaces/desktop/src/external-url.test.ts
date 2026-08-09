import { describe, expect, test } from "bun:test";
import { validateExternalUrl } from "./external-url";

describe("desktop OAuth external navigation", () => {
	test("accepts HTTPS authorization URLs and rejects unsafe or hostless URLs", () => {
		expect(validateExternalUrl("https://auth.openai.com/oauth/authorize?client_id=test")).toBe(
			"https://auth.openai.com/oauth/authorize?client_id=test",
		);
		expect(() => validateExternalUrl("http://auth.openai.com/oauth/authorize")).toThrow("Only HTTPS URLs");
		expect(() => validateExternalUrl("https://")).toThrow();
		expect(() => validateExternalUrl("javascript:alert(1)")).toThrow();
	});
});
