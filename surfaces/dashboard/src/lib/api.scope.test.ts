import { afterEach, describe, expect, it, vi } from "bun:test";
import { api } from "./api";

describe("api.updateAgentScope", () => {
	afterEach(() => vi.restoreAllMocks());

	it("clears group when changing a grouped agent to shared or isolated", async () => {
		const bodies: unknown[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation((async (_input, init) => {
			bodies.push(init?.body);
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
