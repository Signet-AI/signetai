// @ts-nocheck
import { afterEach, describe, expect, it } from "bun:test";
import { getHarnesses } from "./api";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

function json(data, status = 200) {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

describe("harness api helper", () => {
	it("lists harnesses from the daemon", async () => {
		globalThis.fetch = async (input, init) => {
			expect(String(input).endsWith("/api/harnesses")).toBe(true);
			expect(init?.signal).toBeDefined();
			return json({
				harnesses: [
					{
						id: "codex",
						name: "Codex",
						path: "/tmp/codex",
						exists: true,
						lastSeen: null,
					},
				],
			});
		};

		const harnesses = await getHarnesses(50);

		expect(harnesses).toHaveLength(1);
		expect(harnesses[0].id).toBe("codex");
	});

	it("falls back to an empty list when harness discovery stalls", async () => {
		globalThis.fetch = async (_input, init) => {
			return new Promise((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => {
					const err = new Error("aborted");
					err.name = "AbortError";
					reject(err);
				});
			});
		};

		const started = Date.now();
		const harnesses = await getHarnesses(10);

		expect(harnesses).toEqual([]);
		expect(Date.now() - started).toBeLessThan(250);
	});
});
