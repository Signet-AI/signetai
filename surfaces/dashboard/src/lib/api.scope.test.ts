import { describe, expect, it } from "bun:test";
import { api } from "./api";

describe("api.updateAgentScope", () => {
	it("clears group when changing a grouped agent to shared or isolated", async () => {
		const bodies: unknown[] = [];
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (input, init) => {
			const request =
				input instanceof Request ||
				(typeof input === "object" && input !== null && "clone" in input)
					? (input as Request)
					: null;
			const body = request ? await request.clone().text() : init?.body;
			bodies.push(body);
			return new Response(JSON.stringify({ data: { name: "worker" }, error: null }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}) as typeof fetch;

		try {
			await api.updateAgentScope("worker", "shared", undefined);
			await api.updateAgentScope("worker", "isolated", undefined);
		} finally {
			globalThis.fetch = originalFetch;
		}

		expect(bodies).toHaveLength(2);
		for (const body of bodies) {
			expect(JSON.parse(String(body))).toEqual({ memory: expect.any(String), group: null });
		}
	});
});
