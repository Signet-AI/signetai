import { describe, expect, it } from "bun:test";
import { probeDaemonHealth } from "./service";

describe("daemon service health probe (#1340)", () => {
	it("uses the liveness endpoint with a bounded request", async () => {
		let url = "";
		let signal: AbortSignal | undefined;
		const result = await probeDaemonHealth(async (input, init) => {
			url = String(input);
			signal = init?.signal;
			return Response.json({ status: "healthy", uptime: 12, pid: 42 });
		});

		expect(url).toBe("http://localhost:3850/health/live");
		expect(signal).toBeDefined();
		expect(signal?.aborted).toBe(false);
		expect(result).toEqual({ status: "healthy", uptime: 12, pid: 42 });
	});

	it("reports a degraded status when the liveness probe times out", async () => {
		const result = await probeDaemonHealth((_input, init) => {
			const signal = init?.signal;
			if (!signal) return Promise.reject(new Error("health probe signal missing"));

			return new Promise<Response>((_resolve, reject) => {
				signal.addEventListener("abort", () => reject(signal.reason), { once: true });
			});
		});

		expect(result).toEqual({ status: "degraded", uptime: null, pid: null });
	});
});
