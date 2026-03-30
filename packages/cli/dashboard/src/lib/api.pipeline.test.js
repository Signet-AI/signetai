// @ts-nocheck
import { afterEach, describe, expect, it } from "bun:test";
import { pausePipeline, resumePipeline } from "./api";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("pipeline pause api helpers", () => {
	it("returns structured pause success data", async () => {
		globalThis.fetch = async (input, init) => {
			expect(String(input).endsWith("/api/pipeline/pause")).toBe(true);
			expect(init?.method).toBe("POST");
			return new Response(
				JSON.stringify({
					success: true,
					changed: true,
					paused: true,
					file: "/tmp/agent.yaml",
					mode: "paused",
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		};

		const res = await pausePipeline();

		expect(res).toEqual({
			success: true,
			changed: true,
			paused: true,
			file: "/tmp/agent.yaml",
			mode: "paused",
		});
	});

	it("returns daemon resume errors without throwing", async () => {
		globalThis.fetch = async (input, init) => {
			expect(String(input).endsWith("/api/pipeline/resume")).toBe(true);
			expect(init?.method).toBe("POST");
			return new Response(JSON.stringify({ error: "Pipeline transition already in progress" }), {
				status: 409,
				headers: { "Content-Type": "application/json" },
			});
		};

		const res = await resumePipeline();

		expect(res).toEqual({
			success: false,
			error: "Pipeline transition already in progress",
		});
	});

	it("falls back to thrown fetch errors", async () => {
		globalThis.fetch = async () => {
			throw new Error("offline");
		};

		const res = await pausePipeline();

		expect(res).toEqual({
			success: false,
			error: "Error: offline",
		});
	});
});
