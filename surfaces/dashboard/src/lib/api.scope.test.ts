import { afterEach, describe, expect, it, vi } from "bun:test";
import { api, viewsAllAgents } from "./api";

describe("api.updateAgentScope", () => {
	afterEach(() => vi.restoreAllMocks());

	it("clears group when changing a grouped agent to shared or isolated", async () => {
		const bodies: unknown[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation((async (input, init) => {
			const request =
				input instanceof Request || (typeof input === "object" && input !== null && "clone" in input)
					? (input as Request)
					: null;
			const body = request ? await request.clone().text() : init?.body;
			bodies.push(body);
			return new Response(JSON.stringify({ data: { name: "worker" }, error: null }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}) as typeof fetch);

		await api.updateAgentScope("worker", "shared", undefined);
		await api.updateAgentScope("worker", "isolated", undefined);

		expect(bodies).toHaveLength(2);
		for (const body of bodies) {
			expect(JSON.parse(String(body))).toEqual({ memory: expect.any(String), group: null });
		}
	});
});

describe("memory views", () => {
	afterEach(() => vi.restoreAllMocks());

	it("does not ask for every agent before the session is known", async () => {
		const urls: string[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation((async (input) => {
			urls.push(String(input instanceof Request ? input.url : input));
			return new Response(JSON.stringify({ memories: [], stats: {} }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}) as typeof fetch);

		await api.getMemories({ limit: 5 });

		expect(urls).toHaveLength(1);
		expect(urls[0]).not.toContain("agentId=");
	});
});

describe("viewsAllAgents", () => {
	const renewal = {
		kind: "signed-out",
		mode: "team",
		providers: [],
		reason: null,
		expired: true,
		renewal: true,
		permissions: ["admin"],
	} as const;

	it("keeps an admin on the all-agent view while renewing", () => {
		expect(viewsAllAgents(renewal)).toBe(true);
		expect(
			viewsAllAgents({
				kind: "signed-in",
				mode: "team",
				identity: { sub: "a", name: null, role: "admin", expiresAt: 0 },
				permissions: ["admin"],
				expiresSoon: false,
			}),
		).toBe(true);
	});

	it("uses the credential's agent until an admin session is known", () => {
		expect(viewsAllAgents({ kind: "checking" })).toBe(false);
		expect(viewsAllAgents({ kind: "unreachable", error: "down" })).toBe(false);
		expect(viewsAllAgents({ ...renewal, renewal: false })).toBe(false);
		expect(viewsAllAgents({ kind: "open", mode: "team", permissions: ["recall"] })).toBe(false);
	});
});
