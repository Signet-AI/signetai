import { describe, expect, it } from "bun:test";
import { REDACTED_CREDENTIAL, findCredentialSpans, redactCredentials } from "./credential-detection";

describe("credential detection", () => {
	it("redacts provider keys, tokens, and private keys", () => {
		const cases: readonly [string, string][] = [
			["aws key AKIAIOSFODNN7EXAMPLE in config", "provider_key"],
			["use ghp_abcdefghijklmnopqrstuvwxyz0123456789 for the bot", "provider_key"],
			["github_pat_11ABCDEFG0123456789_abcdefghijklmnop works", "provider_key"],
			["OPENAI key sk-proj-abcdefghijklmnopqrstuvwx1234 is set", "provider_key"],
			["anthropic sk-ant-api03-abcdefghijklmnopqrstuvwxyz rotated", "provider_key"],
			["stripe sk_live_abcdefghijklmnop1234 here", "provider_key"],
			["slack xoxb-1234567890-abcdefghij posted", "provider_key"],
			["header Authorization: Bearer abcdefghijklmnop.qrstuvwxyz0123", "bearer_token"],
			["jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U ok", "jwt"],
			["DATABASE_PASSWORD=hunter2hunter2 in .env", "secret_assignment"],
			['config {"api_key": "a1b2c3d4e5f6g7h8"}', "secret_assignment"],
			["password: correct-horse-battery-9", "secret_assignment"],
		];
		for (const [text, kind] of cases) {
			const spans = findCredentialSpans(text);
			expect(spans.map((span) => span.kind)).toContain(kind as never);
			expect(redactCredentials(text)).toContain(REDACTED_CREDENTIAL);
		}
	});

	it("redacts only the secret value of an assignment", () => {
		expect(redactCredentials("export GITHUB_TOKEN=abcdef1234567890xyz")).toBe(
			`export GITHUB_TOKEN=${REDACTED_CREDENTIAL}`,
		);
		expect(redactCredentials("password: correct-horse-battery-9 and more")).toBe(
			`password: ${REDACTED_CREDENTIAL} and more`,
		);
	});

	it("redacts a whole private key block", () => {
		const key = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----";
		expect(redactCredentials(`before\n${key}\nafter`)).toBe(`before\n${REDACTED_CREDENTIAL}\nafter`);
	});

	it("leaves ordinary conversation and identifiers alone", () => {
		const benign = [
			"did he share his secret recipe with you?",
			"characters could reveal secrets to each other, or even to your protagonist",
			"I use a password manager and rotate my passwords",
			"commit 3f9a1c27b8e4d5f60718293a4b5c6d7e8f901234 fixed it",
			"content hash a3f5c9e1b7d2468013579bdf02468ace13579bdf02468ace13579bdf02468ace",
			"request id 550e8400-e29b-41d4-a716-446655440000",
			"I installed scikit-learn and sk-learn tutorials",
			"the token economy and secret sauce of the business",
			"password: weak",
			"applicationId: squareApplicationId, accessToken: squareAccessToken",
			'password="your_password", host="localhost"',
			"token = PasswordResetTokenGenerator().make_token(user)",
			"Monetizing the token: Economic models funding",
			"api_key=${credentials[$cred].api_key}",
			"Bearer of good news",
		];
		for (const text of benign) {
			expect(findCredentialSpans(text)).toEqual([]);
			expect(redactCredentials(text)).toBe(text);
		}
	});
});
