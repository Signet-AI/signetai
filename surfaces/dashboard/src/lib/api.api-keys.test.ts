import { afterEach, describe, expect, it, vi } from "bun:test";
import { api, getJSONResult } from "./api";

function capture(status: number, body: unknown) {
	const calls: Array<{ url: string; method: string; body: unknown }> = [];
	vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
		calls.push({
			url: String(input),
			method: init?.method ?? "GET",
			body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
		});
		return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
	}) as typeof fetch);
	return calls;
}

describe("API key client", () => {
	afterEach(() => vi.restoreAllMocks());

	it("creates keys with the same payload as signet api-key create", async () => {
		const calls = capture(201, { apiKey: { id: "key_1", key: "sig_sk_x_y", name: "alice-laptop" } });
		const result = await api.createApiKey({
			name: "alice-laptop",
			role: "agent",
			agentId: "alice",
			expiresAt: "2027-01-01T00:00:00.000Z",
		});
		expect(result.data?.apiKey.key).toBe("sig_sk_x_y");
		expect(calls[0]).toEqual({
			url: "/api/auth/api-keys",
			method: "POST",
			body: {
				name: "alice-laptop",
				role: "agent",
				agentId: "alice",
				scope: { agent: "alice" },
				expiresAt: "2027-01-01T00:00:00.000Z",
			},
		});
	});

	it("leaves the agent scope and expiry out when they are not set", async () => {
		const calls = capture(201, { apiKey: { id: "key_2", key: "sig_sk_a_b" } });
		await api.createApiKey({ name: "ci", role: "readonly" });
		expect(calls[0]?.body).toEqual({ name: "ci", role: "readonly" });
	});

	it("revokes by id", async () => {
		const calls = capture(200, { apiKey: { id: "key/1" } });
		const result = await api.revokeApiKey("key/1");
		expect(result.ok).toBe(true);
		expect(calls[0]).toMatchObject({ url: "/api/auth/api-keys/key%2F1", method: "DELETE" });
	});
});

describe("forbidden responses", () => {
	afterEach(() => vi.restoreAllMocks());

	it("turns a missing permission into a readable message", async () => {
		capture(403, { error: "role 'agent' lacks 'admin' permission" });
		const result = await getJSONResult("/api/secrets");
		expect(result).toMatchObject({ status: 403, error: "Requires the admin permission." });
	});

	it("explains a scope restriction", async () => {
		capture(403, { error: "scope restricted to agent 'alice'" });
		expect((await getJSONResult("/api/memories")).error).toBe("Your credential is limited to agent alice.");
	});
});
